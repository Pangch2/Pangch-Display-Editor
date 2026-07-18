import { Euler, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import type { SelectionState } from '../controls/selection/select';
import { loadedObjectGroup } from '../load-project/upload-pbde';
import { replaceDisplayObject, updateDisplayObjectMatrix, updateObjectBrightness, updatePlayerHeadTexture } from '../load-project/mesh-builder';
import { getBlockPropertyOptions } from '../load-project/pbde-assets';
import type { GroupData } from './scene-panel-types';
import * as GroupUtils from '../controls/grouping/group';
import * as Overlay from '../controls/selection/overlay';
import { applyDeltaToSelection } from '../controls/selection/drag';
import { blockbenchScaleMode } from '../controls/gizmo/blockbench-scale';

const title = document.getElementById('details-title')!;
const tabs = document.getElementById('project-tabs')!;
const projectProperties = document.getElementById('project-properties')!;
const multiSelectionPivot = document.getElementById('multi-selection-pivot')!;
const objectProperties = document.getElementById('object-properties')!;
const matrix = new Matrix4();
const position = new Vector3();
const rotation = new Euler();
const quaternion = new Quaternion();
const scale = new Vector3();
const itemDisplayValues = ['none', 'thirdperson_lefthand', 'thirdperson_righthand', 'firstperson_lefthand', 'firstperson_righthand', 'head', 'gui', 'ground', 'fixed'];
const metadataOrderKey = 'pde-object-metadata-order';
const matrixInputModeKey = 'pde-matrix-input-mode';
const propertySectionOrderKey = 'pde-object-property-section-order';
let metadataOrder: string[] = JSON.parse(localStorage.getItem(metadataOrderKey) ?? '["texture","brightness","display"]');
let compactMatrixInput = localStorage.getItem(matrixInputModeKey) === 'text';
let propertySectionOrder: string[] = JSON.parse(localStorage.getItem(propertySectionOrderKey) ?? '["transform","matrix","nbt","metadata"]');
let draggedMetadataKey: string | null = null;
let metadataDropRow: HTMLElement | null = null;
let draggedPropertySection: HTMLElement | null = null;
let propertySectionDropTarget: HTMLElement | null = null;
type PropertySelection = { key: string; groupId: string; group: GroupData } | { key: string; mesh: InstancedMesh; instanceId: number };
let selectionOrder: PropertySelection[] = [];
let multiSelectionKey = '';
const multiSelectionMatrix = new Matrix4();
const visibleSections = new WeakSet<Element>();
let currentPivotWorld: Vector3 | undefined;
let currentPivotMode = 'origin';
const sectionObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const index = Array.prototype.indexOf.call(objectProperties.children, entry.target);
        const item = selectionOrder[index];
        if (item?.key === entry.target.getAttribute('data-key')) {
            if (!entry.target.hasAttribute('data-hydrated')) {
                const section = 'group' in item
                    ? renderGroup(item.groupId, item.group, index, index === 0 ? currentPivotWorld : undefined)
                    : renderObject(item.mesh, item.instanceId, index, index === 0 ? currentPivotWorld : undefined);
                section.dataset.key = item.key;
                section.dataset.hydrated = '';
                entry.target.replaceWith(section);
                sectionObserver.unobserve(entry.target);
                sectionObserver.observe(section);
                visibleSections.add(section);
            } else {
                visibleSections.add(entry.target);
                updateSection(entry.target, item, index === 0 ? currentPivotWorld : undefined);
            }
        }
    }
}, { rootMargin: '200px 0px' });

function format(value: number): string {
    return Number(value.toFixed(6)).toString();
}

function numberInput(value: number, onChange: (value: number) => void): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.value = format(value);
    input.oninput = () => {
        const next = input.valueAsNumber;
        if (Number.isFinite(next)) onChange(next);
    };
    return input;
}

function matrixInput(value: Matrix4, onChange: (value: Matrix4) => Matrix4): HTMLElement[] {
    let current = value.clone();
    const heading = document.createElement('h3');
    heading.className = 'object-matrix-heading';
    heading.append('행렬');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'object-matrix-toggle';
    toggle.textContent = compactMatrixInput ? '▶' : '▼';
    toggle.title = compactMatrixInput ? '4×4 입력으로 전환' : '한 줄 입력으로 전환';
    toggle.setAttribute('aria-label', toggle.title);
    heading.append(toggle);

    const grid = document.createElement('div');
    const gridInputs: HTMLInputElement[] = [];
    for (let rowIndex = 0; rowIndex < 4; rowIndex++) {
        const row = document.createElement('div');
        row.className = 'object-property-row matrix';
        for (let column = 0; column < 4; column++) {
            const elementIndex = column * 4 + rowIndex;
            const input = numberInput(current.elements[elementIndex], () => {
                const nextMatrix = new Matrix4();
                gridInputs.forEach((gridInput, index) => {
                    nextMatrix.elements[(index % 4) * 4 + Math.floor(index / 4)] = gridInput.valueAsNumber;
                });
                current = onChange(nextMatrix);
            });
            input.disabled = rowIndex === 3;
            gridInputs.push(input);
            row.append(input);
        }
        grid.append(row);
    }
    grid.hidden = compactMatrixInput;

    const textRow = document.createElement('div');
    textRow.className = 'object-matrix-text';
    textRow.hidden = !compactMatrixInput;
    const text = document.createElement('input');
    text.setAttribute('aria-label', '행렬 한 줄 입력');
    const fixedText = document.createElement('span');
    fixedText.style.whiteSpace = 'pre';
    fixedText.textContent = ' 0, 0, 0, 1';
    textRow.append(text, fixedText);
    const syncText = () => {
        text.value = Array.from({ length: 12 }, (_, index) =>
            format(current.elements[(index % 4) * 4 + Math.floor(index / 4)]))
            .join(', ');
    };
    const syncGrid = () => gridInputs.forEach((input, index) => {
        input.value = format(current.elements[(index % 4) * 4 + Math.floor(index / 4)]);
    });
    const parseText = (): number[] | null => {
        const values = text.value.trim().split(/[,\s]+/).map(entry => Number(entry.replace(/f$/i, '')));
        const validLength = values.length === 12 || values.length === 16;
        return validLength
            && values.every(Number.isFinite)
            ? [...values.slice(0, 12), 0, 0, 0, 1]
            : null;
    };
    text.onchange = () => {
        const values = parseText();
        if (!values) {
            syncText();
            return;
        }
        const next = new Matrix4();
        values.forEach((entry, index) => { next.elements[(index % 4) * 4 + Math.floor(index / 4)] = entry; });
        current = onChange(next);
        syncGrid();
        syncText();
    };
    text.onkeydown = event => { if (event.key === 'Enter') text.blur(); };
    toggle.onclick = () => {
        textRow.hidden = !textRow.hidden;
        grid.hidden = !grid.hidden;
        compactMatrixInput = !textRow.hidden;
        localStorage.setItem(matrixInputModeKey, compactMatrixInput ? 'text' : 'grid');
        toggle.textContent = textRow.hidden ? '▼' : '▶';
        toggle.title = textRow.hidden ? '한 줄 입력으로 전환' : '4×4 입력으로 전환';
        toggle.setAttribute('aria-label', toggle.title);
        if (!textRow.hidden) {
            current = new Matrix4();
            gridInputs.forEach((input, index) => {
                current.elements[(index % 4) * 4 + Math.floor(index / 4)] = input.valueAsNumber;
            });
            syncText();
        }
    };
    if (!textRow.hidden) syncText();
    return [heading, grid, textRow];
}

function propertySelect(value: string, values: string[], onChange: (value: string) => void | Promise<void>): HTMLSelectElement {
    const select = document.createElement('select');
    const optionValues = values.includes(value) ? values : [value, ...values];
    [...new Set(optionValues)].forEach(optionValue => select.add(new Option(optionValue, optionValue)));
    select.value = value;
    select.onchange = async () => {
        select.disabled = true;
        try {
            await onChange(select.value);
        } catch (error) {
            console.error(error);
            select.value = value;
            window.alert(error instanceof Error ? error.message : '오브젝트 변경에 실패했습니다.');
        } finally {
            select.disabled = false;
        }
    };
    return select;
}

function metadataProperty(key: string, labelText: string, control: HTMLElement): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'object-metadata-row';
    row.dataset.metadataKey = key;
    const label = document.createElement('label');
    label.textContent = labelText;
    label.draggable = true;
    row.append(label, control);
    label.ondragstart = event => {
        draggedMetadataKey = key;
        event.dataTransfer?.setData('text/plain', key);
    };
    const clearDropPreview = () => {
        metadataDropRow?.classList.remove('object-metadata-drop-before', 'object-metadata-drop-after');
        metadataDropRow = null;
    };
    label.ondragend = () => {
        draggedMetadataKey = null;
        clearDropPreview();
    };
    row.addEventListener('dragover', event => {
        if (!draggedMetadataKey || draggedMetadataKey === key) return;
        event.preventDefault();
        clearDropPreview();
        metadataDropRow = row;
        row.classList.add(event.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2
            ? 'object-metadata-drop-before'
            : 'object-metadata-drop-after');
    }, true);
    row.addEventListener('dragleave', event => {
        if (!row.contains(event.relatedTarget as Node | null)) clearDropPreview();
    });
    row.addEventListener('drop', event => {
        event.preventDefault();
        const source = draggedMetadataKey ?? event.dataTransfer?.getData('text/plain');
        if (!source || source === key) return;
        const visibleKeys = [...row.parentElement!.querySelectorAll<HTMLElement>(':scope > .object-metadata-row')]
            .map(item => item.dataset.metadataKey!);
        const keys = [...new Set([...metadataOrder, ...visibleKeys])];
        const after = row.classList.contains('object-metadata-drop-after');
        clearDropPreview();
        const [moved] = keys.splice(keys.indexOf(source), 1);
        keys.splice(keys.indexOf(key) + (after ? 1 : 0), 0, moved);
        metadataOrder = keys;
        localStorage.setItem(metadataOrderKey, JSON.stringify(keys));
        document.querySelectorAll<HTMLElement>('[data-property-section="metadata"]').forEach(sortMetadataRows);
    }, true);
    return row;
}

function sortMetadataRows(section: HTMLElement): void {
    [...section.querySelectorAll<HTMLElement>(':scope > .object-metadata-row')]
        .sort((a, b) => {
            const aIndex = metadataOrder.indexOf(a.dataset.metadataKey ?? '');
            const bIndex = metadataOrder.indexOf(b.dataset.metadataKey ?? '');
            return (aIndex < 0 ? Infinity : aIndex) - (bIndex < 0 ? Infinity : bIndex);
        })
        .forEach(row => section.append(row));
}

function propertySection(key: string, label: string | HTMLElement, ...children: (Node | string)[]): HTMLDivElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'object-property-section';
    wrapper.dataset.propertySection = key;
    const heading = typeof label === 'string' ? document.createElement('h3') : label;
    if (typeof label === 'string') heading.textContent = label;
    heading.draggable = true;
    wrapper.append(heading, ...children);
    const clearDropPreview = () => {
        propertySectionDropTarget?.classList.remove('object-property-section-drop-before', 'object-property-section-drop-after');
        propertySectionDropTarget = null;
    };
    heading.ondragstart = event => {
        draggedPropertySection = wrapper;
        event.dataTransfer?.setData('text/plain', key);
    };
    heading.ondragend = () => {
        draggedPropertySection = null;
        clearDropPreview();
    };
    wrapper.ondragover = event => {
        if (!draggedPropertySection || draggedPropertySection === wrapper) return;
        event.preventDefault();
        clearDropPreview();
        propertySectionDropTarget = wrapper;
        wrapper.classList.add(event.clientY < wrapper.getBoundingClientRect().top + wrapper.offsetHeight / 2
            ? 'object-property-section-drop-before'
            : 'object-property-section-drop-after');
    };
    wrapper.ondragleave = event => {
        if (!wrapper.contains(event.relatedTarget as Node | null)) clearDropPreview();
    };
    wrapper.ondrop = event => {
        event.preventDefault();
        if (!draggedPropertySection || draggedPropertySection === wrapper) return;
        const source = draggedPropertySection.dataset.propertySection!;
        const after = wrapper.classList.contains('object-property-section-drop-after');
        clearDropPreview();
        const keys = propertySectionOrder.filter(item => item !== source);
        keys.splice(keys.indexOf(key) + (after ? 1 : 0), 0, source);
        propertySectionOrder = keys;
        localStorage.setItem(propertySectionOrderKey, JSON.stringify(keys));
        document.querySelectorAll<HTMLElement>('.object-property').forEach(sortPropertySections);
    };
    return wrapper;
}

function sortPropertySections(section: HTMLElement): void {
    [...section.querySelectorAll<HTMLElement>(':scope > .object-property-section')]
        .sort((a, b) => propertySectionOrder.indexOf(a.dataset.propertySection!) - propertySectionOrder.indexOf(b.dataset.propertySection!))
        .forEach(item => section.append(item));
}

function brightnessProperty(brightness: { sky?: number; block?: number }, onChange: (brightness: { sky: number; block: number }) => Promise<void>): HTMLDivElement {
    const valuesList = Array.from({ length: 16 }, (_, value) => String(value));
    const values = document.createElement('span');
    values.style.cssText = 'display:grid;grid-template-columns:auto minmax(0,1fr) auto minmax(0,1fr);gap:4px;align-items:center';
    const sky = propertySelect(String(brightness.sky ?? 15), valuesList, value => onChange({ sky: Number(value), block: brightness.block ?? 0 }));
    const block = propertySelect(String(brightness.block ?? 0), valuesList, value => onChange({ sky: brightness.sky ?? 15, block: Number(value) }));
    values.append('하늘', sky, '블럭', block);
    return metadataProperty('brightness', '밝기', values);
}

function textureUrl(value: string): string {
    try {
        return JSON.parse(atob(value)).textures.SKIN.url;
    } catch {
        return value;
    }
}

function replaceNameProperties(name: string, props: Record<string, string>): string {
    return `${name.replace(/\[[^\]]*\]$/, '')}[${Object.entries(props).map(([key, value]) => `${key}=${value}`).join(',')}]`;
}

function replaceNameDisplay(name: string, display: string): string {
    const baseName = name.replace(/\[[^\]]*\]$/, '');
    return display === 'none' ? baseName : `${baseName}[display=${display}]`;
}

function scaleInput(value: number, onChange: (value: number, direction: '+' | '-') => void): HTMLElement {
    let direction: '+' | '-' = '+';
    const wrapper = document.createElement('span');
    wrapper.className = 'object-scale-input';
    const input = numberInput(value, next => onChange(next, direction));
    const arrow = document.createElement('button');
    arrow.type = 'button';
    arrow.className = 'object-scale-direction';
    arrow.hidden = !blockbenchScaleMode;
    arrow.textContent = '▶';
    arrow.title = '+축 방향 조작';
    arrow.onclick = () => {
        direction = direction === '+' ? '-' : '+';
        arrow.textContent = direction === '-' ? '◀' : '▶';
        arrow.title = `${direction}축 방향 조작`;
    };
    wrapper.append(input, arrow);
    return wrapper;
}

function renderMultiSelectionProperties(selection?: SelectionState, pivotWorld?: Vector3, pivotLocal?: Vector3): void {
    multiSelectionPivot.hidden = !pivotLocal;
    if (!selection || !pivotLocal) {
        multiSelectionKey = '';
        return;
    }
    const applyDelta = (deltaMatrix: Matrix4): void => {
        const meshToInstanceIds = new Map<InstancedMesh, number[]>();
        const add = (mesh: InstancedMesh, instanceId: number): void => {
            const ids = meshToInstanceIds.get(mesh) ?? [];
            if (!ids.includes(instanceId)) ids.push(instanceId);
            meshToInstanceIds.set(mesh, ids);
        };
        selection.objects.forEach((ids, mesh) => {
            if (mesh instanceof InstancedMesh) ids.forEach(instanceId => add(mesh, instanceId));
        });
        selection.groups.forEach(groupId => GroupUtils.getAllGroupChildren(loadedObjectGroup, groupId)
            .forEach(child => child.mesh instanceof InstancedMesh && add(child.mesh, child.instanceId)));
        applyDeltaToSelection({ deltaMatrix, meshToInstanceIds, selectedGroupIds: selection.groups, loadedObjectGroup });
        meshToInstanceIds.forEach((_ids, mesh) => {
            mesh.computeBoundingBox();
            mesh.computeBoundingSphere();
        });
        window.dispatchEvent(new CustomEvent('pde:scene-updated'));
    };

    const key = [
        ...selection.groups,
        ...Array.from(selection.objects, ([mesh, ids]) => `${mesh.uuid}:${[...ids].sort((a, b) => a - b).join(',')}`)
    ].sort().join('|');
    const pivot = pivotWorld?.clone() ?? pivotLocal.clone();
    if (multiSelectionKey === key && multiSelectionPivot.contains(document.activeElement)) return;
    if (multiSelectionKey !== key) {
        multiSelectionKey = key;
        multiSelectionMatrix.identity().setPosition(pivot);
    } else {
        multiSelectionMatrix.setPosition(pivot);
    }
    const selectionMatrix = multiSelectionMatrix;
    const applyMatrix = (next: Matrix4): Matrix4 => {
        const delta = next.clone().multiply(selectionMatrix.clone().invert());
        selectionMatrix.copy(next);
        applyDelta(delta);
        return selectionMatrix.clone();
    };
    const transformSection = propertySection('transform', '변환');
    selectionMatrix.decompose(position, quaternion, scale);
    const values = [position.clone(), new Euler().setFromQuaternion(quaternion), scale.clone()];
    ['위치', '회전', '크기'].forEach((label, rowIndex) => {
        const row = document.createElement('div');
        row.className = 'object-property-row';
        const rowLabel = document.createElement('label');
        rowLabel.textContent = label;
        row.append(rowLabel);
        (['x', 'y', 'z'] as const).forEach(axis => {
            const value = rowIndex === 1 ? values[rowIndex][axis] * 180 / Math.PI : values[rowIndex][axis];
            row.append(numberInput(value, next => {
                selectionMatrix.decompose(position, quaternion, scale);
                rotation.setFromQuaternion(quaternion);
                if (rowIndex === 0) position[axis] = next;
                else if (rowIndex === 1) rotation[axis] = next * Math.PI / 180;
                else scale[axis] = next;
                applyMatrix(new Matrix4().compose(position, quaternion.setFromEuler(rotation), scale));
            }));
        });
        transformSection.append(row);
    });

    const row = document.createElement('div');
    row.className = 'object-property-row';
    const label = document.createElement('label');
    label.textContent = '피벗';
    row.append(label);
    (['x', 'y', 'z'] as const).forEach(axis => {
        const input = numberInput(pivotLocal[axis], next => {
            pivotLocal[axis] = next;
            const primaryMatrix = new Matrix4();
            if (selection.primary?.type === 'group') {
                const group = (loadedObjectGroup.userData.groups as Map<string, GroupData> | undefined)?.get(selection.primary.id);
                if (!group) return;
                primaryMatrix.copy(group.matrix ?? new Matrix4().compose(
                    new Vector3(group.position.x, group.position.y, group.position.z),
                    new Quaternion(group.quaternion.x, group.quaternion.y, group.quaternion.z, group.quaternion.w),
                    new Vector3(group.scale.x, group.scale.y, group.scale.z)
                ));
            } else if (selection.primary?.type === 'object' && selection.primary.mesh instanceof InstancedMesh) {
                selection.primary.mesh.getMatrixAt(selection.primary.instanceId, primaryMatrix);
                primaryMatrix.premultiply(selection.primary.mesh.matrixWorld);
            } else {
                return;
            }
            window.dispatchEvent(new CustomEvent('pde:multi-selection-pivot-change', {
                detail: pivotLocal.clone().applyMatrix4(primaryMatrix)
            }));
        });
        row.append(input);
    });
    const pivotSection = propertySection('pivot', '다중 선택 커스텀 피벗', row);
    const matrixParts = matrixInput(selectionMatrix, applyMatrix);
    multiSelectionPivot.replaceChildren(pivotSection, transformSection, propertySection('matrix', matrixParts[0], ...matrixParts.slice(1)));
    sortPropertySections(multiSelectionPivot);
}

function updateMultiSelectionTransformValues(pivotWorld?: Vector3): void {
    if (pivotWorld) multiSelectionMatrix.setPosition(pivotWorld);
    multiSelectionMatrix.decompose(position, quaternion, scale);
    rotation.setFromQuaternion(quaternion);
    const transformValues = [
        position.x, position.y, position.z,
        rotation.x * 180 / Math.PI, rotation.y * 180 / Math.PI, rotation.z * 180 / Math.PI,
        scale.x, scale.y, scale.z
    ];
    multiSelectionPivot.querySelectorAll<HTMLInputElement>('[data-property-section="transform"] input[type="number"]').forEach((input, index) => {
        if (input !== document.activeElement) input.value = format(transformValues[index]);
    });
}

function keepPivotFixed(current: Matrix4, next: Matrix4, localPivot: Vector3, preserveTranslation = false): Matrix4 {
    const offset = localPivot.clone().applyMatrix4(current).sub(localPivot.clone().applyMatrix4(next));
    if (preserveTranslation) {
        offset.add(new Vector3().setFromMatrixPosition(next).sub(new Vector3().setFromMatrixPosition(current)));
    }
    next.elements[12] += offset.x;
    next.elements[13] += offset.y;
    next.elements[14] += offset.z;
    return next;
}

function getScalePivot(localPivot: Vector3, localBox: { min: Vector3; max: Vector3 } | null, axis: 'x' | 'y' | 'z', direction: '+' | '-'): Vector3 {
    const pivot = localPivot.clone();
    if (blockbenchScaleMode && localBox) pivot[axis] = localBox[direction === '+' ? 'min' : 'max'][axis];
    return pivot;
}

function applySelectionDelta(deltaMatrix: Matrix4, target: PropertySelection): void {
    const meshToInstanceIds = new Map<InstancedMesh, number[]>();
    const add = (mesh: InstancedMesh, instanceId: number): void => {
        const ids = meshToInstanceIds.get(mesh) ?? [];
        if (!ids.includes(instanceId)) ids.push(instanceId);
        meshToInstanceIds.set(mesh, ids);
    };
    if ('group' in target) {
        GroupUtils.getAllGroupChildren(loadedObjectGroup, target.groupId)
            .forEach(child => child.mesh instanceof InstancedMesh && add(child.mesh, child.instanceId));
    } else {
        add(target.mesh, target.instanceId);
    }
    applyDeltaToSelection({
        deltaMatrix,
        meshToInstanceIds,
        selectedGroupIds: 'group' in target ? new Set([target.groupId]) : undefined,
        loadedObjectGroup
    });
    meshToInstanceIds.forEach((_ids, mesh) => {
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
    });
    window.dispatchEvent(new CustomEvent('pde:scene-updated'));
}

function renderObject(mesh: InstancedMesh, instanceId: number, index: number, pivotWorld?: Vector3): HTMLElement {
    mesh.getMatrixAt(instanceId, matrix);
    matrix.decompose(position, quaternion, scale);
    rotation.setFromQuaternion(quaternion);

    const uuid = (loadedObjectGroup.userData.instanceKeyToObjectUuid as Map<string, string> | undefined)
        ?.get(`${mesh.uuid}_${instanceId}`) ?? `${mesh.name || '오브젝트'} ${instanceId}`;
    const name = (loadedObjectGroup.userData.objectNames as Map<string, string> | undefined)?.get(uuid) ?? uuid;
    const section = document.createElement('section');
    section.className = 'object-property';
    const heading = document.createElement('h3');
    heading.textContent = `${index + 1}. ${name}`;
    section.append(heading);

    const pivotBase = new Vector3();
    const displayType = Overlay.getDisplayType(mesh, instanceId);
    if (displayType === 'block_display') Overlay.getInstanceLocalBoxMin(mesh, instanceId, pivotBase);
    else if (displayType === 'item_display' && mesh.userData.hasHat) pivotBase.y = Overlay.isItemDisplayHatEnabled(mesh, instanceId) ? 0.03125 : 0;
    else if (displayType === 'item_display') Overlay.getInstanceLocalBox(mesh, instanceId)?.getCenter(pivotBase);
    const storedPivot = (mesh.userData.customPivots as Map<number, Vector3> | undefined)?.get(instanceId);
    const localPivot = storedPivot?.clone() ?? pivotBase.clone();
    if (pivotWorld) {
        localPivot.copy(pivotWorld).applyMatrix4(mesh.matrixWorld.clone().invert()).applyMatrix4(matrix.clone().invert());
    }

    const transformSection = propertySection('transform', '변환');
    const values = [position.clone(), rotation.clone(), scale.clone()];
    ['위치', '회전', '크기'].forEach((label, rowIndex) => {
        const row = document.createElement('div');
        row.className = 'object-property-row';
        const rowLabel = document.createElement('label');
        rowLabel.textContent = label;
        row.append(rowLabel);
        (['x', 'y', 'z'] as const).forEach(axis => {
            const value = rowIndex === 1 ? values[rowIndex][axis] * 180 / Math.PI : values[rowIndex][axis];
            const change = (next: number, direction: '+' | '-' = '+') => {
                mesh.getMatrixAt(instanceId, matrix);
                const currentMatrix = matrix.clone();
                matrix.decompose(position, quaternion, scale);
                rotation.setFromQuaternion(quaternion);
                if (rowIndex === 0) position[axis] = next;
                else if (rowIndex === 1) rotation[axis] = next * Math.PI / 180;
                else scale[axis] = next;
                matrix.compose(position, quaternion.setFromEuler(rotation), scale);
                let transformPivot = currentPivotWorld
                    ?.clone().applyMatrix4(mesh.matrixWorld.clone().invert()).applyMatrix4(currentMatrix.clone().invert())
                    ?? localPivot;
                if (rowIndex === 2) transformPivot = getScalePivot(transformPivot, Overlay.getInstanceLocalBox(mesh, instanceId), axis, direction);
                const nextMatrix = rowIndex === 0 ? matrix : keepPivotFixed(currentMatrix, matrix, transformPivot);
                const currentWorld = currentMatrix.clone().premultiply(mesh.matrixWorld);
                const nextWorld = nextMatrix.clone().premultiply(mesh.matrixWorld);
                applySelectionDelta(nextWorld.multiply(currentWorld.invert()), { key: '', mesh, instanceId });
            };
            row.append(rowIndex === 2 ? scaleInput(value, change) : numberInput(value, change));
        });
        transformSection.append(row);
    });

    const pivot = localPivot.clone();
    const pivotRow = document.createElement('div');
    pivotRow.className = 'object-property-row';
    const pivotLabel = document.createElement('label');
    pivotLabel.textContent = '피벗';
    pivotRow.append(pivotLabel);
    (['x', 'y', 'z'] as const).forEach(axis => pivotRow.append(numberInput(pivot[axis], next => {
        if (!mesh.userData.customPivots) mesh.userData.customPivots = new Map<number, Vector3>();
        pivot[axis] = next;
        localPivot.copy(pivot);
        (mesh.userData.customPivots as Map<number, Vector3>).set(instanceId, localPivot.clone());
        window.dispatchEvent(new CustomEvent('pde:scene-updated'));
    })));
    transformSection.append(pivotRow);
    section.append(transformSection);

    const matrixParts = matrixInput(matrix, nextMatrix => {
        mesh.getMatrixAt(instanceId, matrix);
        const currentMatrix = matrix.clone();
        const transformPivot = currentPivotWorld
            ?.clone().applyMatrix4(mesh.matrixWorld.clone().invert()).applyMatrix4(currentMatrix.clone().invert())
            ?? localPivot;
        keepPivotFixed(currentMatrix, nextMatrix, transformPivot, true);
        const currentWorld = currentMatrix.clone().premultiply(mesh.matrixWorld);
        const nextWorld = nextMatrix.clone().premultiply(mesh.matrixWorld);
        applySelectionDelta(nextWorld.multiply(currentWorld.invert()), { key: '', mesh, instanceId });
        return nextMatrix;
    });
    section.append(propertySection('matrix', matrixParts[0] as HTMLElement, ...matrixParts.slice(1)));

    const nbt = document.createElement('input');
    const objectNbt = loadedObjectGroup.userData.objectNbt as Map<string, string> | undefined;
    nbt.value = objectNbt?.get(uuid) ?? '';
    nbt.oninput = () => objectNbt?.set(uuid, nbt.value);
    section.append(propertySection('nbt', 'NBT', nbt));
    const isItemDisplay = (loadedObjectGroup.userData.objectIsItemDisplay as Set<string> | undefined)?.has(uuid) ?? false;
    const brightnessMap = loadedObjectGroup.userData.objectBrightness as Map<string, { sky?: number; block?: number }>;
    const brightness = brightnessMap.get(uuid) ?? {};
    const updateBrightness = async (value: { sky: number; block: number }) => {
        updateObjectBrightness(uuid, value);
    };
    if (isItemDisplay) {
        const metadataSection = propertySection('metadata', '개체 속성');
        metadataSection.firstElementChild!.className = 'object-metadata-title';
        section.append(metadataSection);
        const textures = loadedObjectGroup.userData.objectTextures as Map<string, string> | undefined;
        const texture = textures?.get(uuid);
        if (name.startsWith('player_head')) {
            const input = document.createElement('input');
            input.value = texture ?? '';
            input.onchange = async () => {
                input.value = textureUrl(input.value.trim());
                await updatePlayerHeadTexture(uuid, input.value);
            };
            metadataSection.append(metadataProperty('texture', '텍스쳐', input));
        }
        metadataSection.append(brightnessProperty(brightness, updateBrightness));
        const displayType = (loadedObjectGroup.userData.objectDisplayTypes as Map<string, string> | undefined)?.get(uuid) ?? 'none';
        metadataSection.append(metadataProperty('display', '디스플레이', propertySelect(displayType, itemDisplayValues, async value => {
            await updateDisplayObjectMatrix(uuid, replaceNameDisplay(name, value));
        })));
        sortMetadataRows(metadataSection);
    } else {
        const objectBlockProps = loadedObjectGroup.userData.objectBlockProps as Map<string, Record<string, string>> | undefined;
        const props = objectBlockProps?.get(uuid) ?? {};
        const metadataSection = propertySection('metadata', '개체 속성');
        metadataSection.firstElementChild!.className = 'object-metadata-title';
        section.append(metadataSection);
        metadataSection.append(brightnessProperty(brightness, updateBrightness));
        sortMetadataRows(metadataSection);
        void getBlockPropertyOptions(name, props).then(options => {
            Object.entries(options)
                .filter(([, values]) => values.length > 1)
                .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
                .forEach(([key, values]) => {
                    const value = props[key] ?? (values.includes('false') ? 'false' : values[0]);
                    metadataSection.append(metadataProperty(key, key, propertySelect(value, values, async next => {
                        await replaceDisplayObject(uuid, replaceNameProperties(name, { ...props, [key]: next }), {
                            pivotMode: currentPivotMode,
                            pivotWorld: currentPivotWorld
                        });
                    })));
                });
            sortMetadataRows(metadataSection);
        }).catch(error => {
            console.error('블록 속성 후보를 불러오지 못했습니다.', error);
        });
    }
    sortPropertySections(section);
    return section;
}

function renderGroup(groupId: string, group: GroupData, index: number, pivotWorld?: Vector3): HTMLElement {
    const groupPosition = new Vector3(group.position.x, group.position.y, group.position.z);
    const groupQuaternion = new Quaternion(group.quaternion.x, group.quaternion.y, group.quaternion.z, group.quaternion.w);
    const groupScale = new Vector3(group.scale.x, group.scale.y, group.scale.z);
    const groupRotation = new Euler().setFromQuaternion(groupQuaternion);
    const groupMatrix = group.matrix?.clone() ?? new Matrix4().compose(groupPosition, groupQuaternion, groupScale);
    const localPivot = pivotWorld
        ? pivotWorld.clone().applyMatrix4(groupMatrix.clone().invert())
        : new Vector3(...(group.pivot ?? [0, 0, 0]));
    const commitMatrix = (next: Matrix4): void => {
        const deltaMatrix = next.clone().multiply(groupMatrix.clone().invert());
        applySelectionDelta(deltaMatrix, { key: '', groupId, group });
        groupMatrix.copy(group.matrix ?? next);
    };
    const section = document.createElement('section');
    section.className = 'object-property';
    const heading = document.createElement('h3');
    heading.textContent = `${index + 1}. ${group.name}`;
    section.append(heading);
    const transformSection = propertySection('transform', '변환');
    const values = [groupPosition.clone(), groupRotation.clone(), groupScale.clone()];
    ['위치', '회전', '크기'].forEach((label, rowIndex) => {
        const row = document.createElement('div');
        row.className = 'object-property-row';
        const rowLabel = document.createElement('label');
        rowLabel.textContent = label;
        row.append(rowLabel);
        (['x', 'y', 'z'] as const).forEach(axis => {
            const value = rowIndex === 1 ? values[rowIndex][axis] * 180 / Math.PI : values[rowIndex][axis];
            const change = (next: number, direction: '+' | '-' = '+') => {
                groupMatrix.decompose(groupPosition, groupQuaternion, groupScale);
                groupRotation.setFromQuaternion(groupQuaternion);
                if (rowIndex === 0) groupPosition[axis] = next;
                else if (rowIndex === 1) groupRotation[axis] = next * Math.PI / 180;
                else groupScale[axis] = next;
                const nextMatrix = new Matrix4().compose(groupPosition, groupQuaternion.setFromEuler(groupRotation), groupScale);
                let transformPivot = currentPivotWorld?.clone().applyMatrix4(groupMatrix.clone().invert()) ?? localPivot;
                if (rowIndex === 2) transformPivot = getScalePivot(transformPivot, Overlay.getGroupLocalBoundingBox(groupId), axis, direction);
                commitMatrix(rowIndex === 0 ? nextMatrix : keepPivotFixed(groupMatrix, nextMatrix, transformPivot));
            };
            row.append(rowIndex === 2 ? scaleInput(value, change) : numberInput(value, change));
        });
        transformSection.append(row);
    });

    const pivot = localPivot.clone();
    const pivotRow = document.createElement('div');
    pivotRow.className = 'object-property-row';
    const pivotLabel = document.createElement('label');
    pivotLabel.textContent = '피벗';
    pivotRow.append(pivotLabel);
    (['x', 'y', 'z'] as const).forEach(axis => pivotRow.append(numberInput(pivot[axis], next => {
        pivot[axis] = next;
        group.pivot = [pivot.x, pivot.y, pivot.z];
        window.dispatchEvent(new CustomEvent('pde:scene-updated'));
    })));
    transformSection.append(pivotRow);
    section.append(transformSection);

    const matrixParts = matrixInput(groupMatrix, nextMatrix => {
        const transformPivot = currentPivotWorld?.clone().applyMatrix4(groupMatrix.clone().invert()) ?? localPivot;
        commitMatrix(keepPivotFixed(groupMatrix, nextMatrix, transformPivot, true));
        return groupMatrix.clone();
    });
    section.append(propertySection('matrix', matrixParts[0] as HTMLElement, ...matrixParts.slice(1)));

    const nbt = document.createElement('input');
    nbt.value = group.nbt ?? '';
    nbt.oninput = () => { group.nbt = nbt.value; };
    section.append(propertySection('nbt', 'NBT', nbt));
    sortPropertySections(section);
    return section;
}

function updateSection(section: Element, item: PropertySelection, pivotWorld?: Vector3): void {
    const nextMatrix = new Matrix4();
    const nextPosition = new Vector3();
    const nextQuaternion = new Quaternion();
    const nextScale = new Vector3();
    let pivot: Vector3;

    if ('group' in item) {
        const group = item.group;
        nextPosition.set(group.position.x, group.position.y, group.position.z);
        nextQuaternion.set(group.quaternion.x, group.quaternion.y, group.quaternion.z, group.quaternion.w);
        nextScale.set(group.scale.x, group.scale.y, group.scale.z);
        nextMatrix.copy(group.matrix ?? new Matrix4().compose(nextPosition, nextQuaternion, nextScale));
        nextMatrix.decompose(nextPosition, nextQuaternion, nextScale);
        pivot = pivotWorld?.clone().applyMatrix4(nextMatrix.clone().invert()) ?? new Vector3(...(group.pivot ?? [0, 0, 0]));
    } else {
        item.mesh.getMatrixAt(item.instanceId, nextMatrix);
        nextMatrix.decompose(nextPosition, nextQuaternion, nextScale);
        const pivotBase = new Vector3();
        const displayType = Overlay.getDisplayType(item.mesh, item.instanceId);
        if (displayType === 'block_display') Overlay.getInstanceLocalBoxMin(item.mesh, item.instanceId, pivotBase);
        else if (displayType === 'item_display' && item.mesh.userData.hasHat) pivotBase.y = Overlay.isItemDisplayHatEnabled(item.mesh, item.instanceId) ? 0.03125 : 0;
        else if (displayType === 'item_display') Overlay.getInstanceLocalBox(item.mesh, item.instanceId)?.getCenter(pivotBase);
        const storedPivot = (item.mesh.userData.customPivots as Map<number, Vector3> | undefined)?.get(item.instanceId);
        pivot = pivotWorld
            ?.clone().applyMatrix4(item.mesh.matrixWorld.clone().invert()).applyMatrix4(nextMatrix.clone().invert())
            ?? storedPivot?.clone()
            ?? pivotBase;
    }

    const nextRotation = new Euler().setFromQuaternion(nextQuaternion);
    const values = [
        nextPosition.x, nextPosition.y, nextPosition.z,
        nextRotation.x * 180 / Math.PI, nextRotation.y * 180 / Math.PI, nextRotation.z * 180 / Math.PI,
        nextScale.x, nextScale.y, nextScale.z,
        pivot.x, pivot.y, pivot.z,
        ...Array.from({ length: 16 }, (_, index) => nextMatrix.elements[(index % 4) * 4 + Math.floor(index / 4)])
    ];
    section.querySelectorAll<HTMLInputElement>('[data-property-section="transform"] input[type="number"]').forEach((input, index) => {
        if (input !== document.activeElement) input.value = format(values[index]);
    });
    section.querySelectorAll<HTMLInputElement>('[data-property-section="matrix"] input[type="number"]').forEach((input, index) => {
        if (input !== document.activeElement) input.value = format(values[index + 12]);
    });
    const matrixText = section.querySelector<HTMLInputElement>('.object-matrix-text input');
    if (matrixText && matrixText !== document.activeElement) matrixText.value = values.slice(12, 24).map(format).join(', ');
}

function renderSelection(selection?: SelectionState, pivotWorld?: Vector3, multiCustomPivotLocal?: Vector3, renderMulti = true): void {
    const groups = loadedObjectGroup.userData.groups as Map<string, GroupData> | undefined;
    const current: PropertySelection[] = [
        ...Array.from(selection?.groups ?? []).flatMap(id => {
            const group = groups?.get(id);
            return group ? [{ key: `group:${id}`, groupId: id, group }] : [];
        }),
        ...Array.from(selection?.objects ?? []).flatMap(([mesh, ids]) => mesh instanceof InstancedMesh
            ? Array.from(ids, instanceId => ({ key: `object:${mesh.uuid}:${instanceId}`, mesh, instanceId }))
            : [])
    ];
    if (renderMulti) renderMultiSelectionProperties(selection, pivotWorld, current.length > 1 ? multiCustomPivotLocal ?? new Vector3() : undefined);
    const propertyPivotWorld = current.length === 1 ? pivotWorld : undefined;
    const currentByKey = new Map(current.map(item => [item.key, item]));
    selectionOrder = selectionOrder.filter(item => currentByKey.has(item.key)).map(item => currentByKey.get(item.key)!);
    const known = new Set(selectionOrder.map(item => item.key));
    const primaryKey = selection?.primary?.type === 'group'
        ? `group:${selection.primary.id}`
        : selection?.primary?.type === 'object'
            ? `object:${selection.primary.mesh.uuid}:${selection.primary.instanceId}`
            : null;
    if (selectionOrder.length === 0 && primaryKey && currentByKey.has(primaryKey)) {
        selectionOrder.push(currentByKey.get(primaryKey)!);
        known.add(primaryKey);
    }
    current.forEach(item => {
        if (!known.has(item.key)) selectionOrder.push(item);
    });
    const selected = selectionOrder.length > 0;
    currentPivotWorld = propertyPivotWorld;
    title.textContent = selected ? '오브젝트 속성' : '프로젝트 세부 정보';
    tabs.hidden = selected;
    projectProperties.hidden = selected;
    objectProperties.hidden = !selected;
    if (!selected) return;
    const sections = objectProperties.children;
    if (sections.length === selectionOrder.length
        && selectionOrder.every((item, index) => sections[index].getAttribute('data-key') === item.key)) {
        selectionOrder.forEach((item, index) => {
            if (visibleSections.has(sections[index])) {
                updateSection(sections[index], item, index === 0 ? propertyPivotWorld : undefined);
            }
        });
        return;
    }
    sectionObserver.disconnect();
    const lazy = selectionOrder.length > 20;
    const nextSections = selectionOrder.map((item, index) => {
        if (!lazy) {
            const section = 'group' in item
                ? renderGroup(item.groupId, item.group, index, index === 0 ? propertyPivotWorld : undefined)
                : renderObject(item.mesh, item.instanceId, index, index === 0 ? propertyPivotWorld : undefined);
            section.dataset.key = item.key;
            section.dataset.hydrated = '';
            visibleSections.add(section);
            return section;
        }
        const section = document.createElement('section');
        section.className = 'object-property';
        section.style.minHeight = '250px';
        section.dataset.key = item.key;
        return section;
    });
    objectProperties.replaceChildren(...nextSections);
    nextSections.forEach(section => sectionObserver.observe(section));
}

window.addEventListener('pde:selection-changed', event => renderSelection((event as CustomEvent<SelectionState>).detail));
window.addEventListener('pde:selection-transform-context', event => {
    const detail = (event as CustomEvent<{ selection: SelectionState; pivotWorld?: Vector3; pivotMode: string; multiCustomPivotLocal?: Vector3 }>).detail;
    currentPivotMode = detail.pivotMode;
    renderSelection(detail.selection, detail.pivotWorld, detail.multiCustomPivotLocal);
});
window.addEventListener('pde:object-transform-changed', event => {
    const detail = (event as CustomEvent<{ selection: SelectionState; pivotWorld?: Vector3; pivotMode: string; multiCustomPivotLocal?: Vector3; deltaMatrix?: Matrix4; dragging?: boolean }>).detail;
    currentPivotMode = detail.pivotMode;
    if (detail.dragging) {
        if (detail.deltaMatrix && detail.multiCustomPivotLocal) {
            multiSelectionMatrix.premultiply(detail.deltaMatrix);
            updateMultiSelectionTransformValues(detail.pivotWorld);
        }
        return;
    }
    renderSelection(detail.selection, detail.pivotWorld, detail.multiCustomPivotLocal);
});
window.addEventListener('pde:blockbench-scale-mode-changed', event => {
    const enabled = (event as CustomEvent<boolean>).detail;
    objectProperties.querySelectorAll<HTMLButtonElement>('.object-scale-direction').forEach(button => { button.hidden = !enabled; });
});
