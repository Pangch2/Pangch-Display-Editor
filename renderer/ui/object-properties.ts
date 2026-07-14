import { Euler, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import type { SelectionState } from '../controls/selection/select';
import { loadedObjectGroup } from '../load-project/upload-pbde';
import { replaceDisplayObject, updateDisplayObjectMatrix, updatePlayerHeadTexture } from '../load-project/mesh-builder';
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
let metadataOrder: string[] = JSON.parse(localStorage.getItem(metadataOrderKey) ?? '["texture","brightness","display"]');
type PropertySelection = { key: string; groupId: string; group: GroupData } | { key: string; mesh: InstancedMesh; instanceId: number };
let selectionOrder: PropertySelection[] = [];
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
    row.draggable = true;
    const label = document.createElement('label');
    label.textContent = labelText;
    row.append(label, control);
    row.ondragstart = event => event.dataTransfer?.setData('text/plain', key);
    row.ondragover = event => event.preventDefault();
    row.ondrop = event => {
        event.preventDefault();
        const source = event.dataTransfer?.getData('text/plain');
        if (!source || source === key) return;
        const keys = [...new Set([...metadataOrder, source, key])];
        [keys[keys.indexOf(source)], keys[keys.indexOf(key)]] = [key, source];
        metadataOrder = keys;
        localStorage.setItem(metadataOrderKey, JSON.stringify(keys));
        document.querySelectorAll<HTMLElement>('.object-property').forEach(sortMetadataRows);
    };
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

function brightnessProperty(brightness: { sky?: number; block?: number }, onChange: (brightness: { sky: number; block: number }) => Promise<void>): HTMLDivElement {
    const valuesList = Array.from({ length: 16 }, (_, value) => String(value));
    const values = document.createElement('span');
    values.style.cssText = 'display:grid;grid-template-columns:auto minmax(0,1fr) auto minmax(0,1fr);gap:4px;align-items:center';
    const sky = propertySelect(String(brightness.sky ?? 0), valuesList, value => onChange({ sky: Number(value), block: brightness.block ?? 0 }));
    const block = propertySelect(String(brightness.block ?? 0), valuesList, value => onChange({ sky: brightness.sky ?? 0, block: Number(value) }));
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

function renderMultiSelectionPivot(pivotLocal?: Vector3): void {
    multiSelectionPivot.hidden = !pivotLocal;
    if (!pivotLocal) return;
    const heading = document.createElement('h3');
    heading.textContent = '다중 선택 커스텀 피벗';
    const row = document.createElement('div');
    row.className = 'object-property-row';
    const label = document.createElement('label');
    label.textContent = 'Local';
    row.append(label);
    (['x', 'y', 'z'] as const).forEach(axis => {
        const input = numberInput(pivotLocal[axis], () => {});
        input.readOnly = true;
        row.append(input);
    });
    multiSelectionPivot.replaceChildren(heading, row);
}

function keepPivotFixed(current: Matrix4, next: Matrix4, localPivot: Vector3): Matrix4 {
    const offset = localPivot.clone().applyMatrix4(current).sub(localPivot.clone().applyMatrix4(next));
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
        section.append(row);
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
    section.append(pivotRow);

    const matrixLabel = document.createElement('h3');
    matrixLabel.textContent = '행렬';
    section.append(matrixLabel);
    for (let rowIndex = 0; rowIndex < 4; rowIndex++) {
        const row = document.createElement('div');
        row.className = 'object-property-row matrix';
        for (let column = 0; column < 4; column++) {
            const elementIndex = column * 4 + rowIndex;
            const input = numberInput(matrix.elements[elementIndex], next => {
                mesh.getMatrixAt(instanceId, matrix);
                const currentMatrix = matrix.clone();
                matrix.elements[elementIndex] = next;
                const transformPivot = currentPivotWorld
                    ?.clone().applyMatrix4(mesh.matrixWorld.clone().invert()).applyMatrix4(currentMatrix.clone().invert())
                    ?? localPivot;
                const nextMatrix = keepPivotFixed(currentMatrix, matrix, transformPivot);
                const currentWorld = currentMatrix.clone().premultiply(mesh.matrixWorld);
                const nextWorld = nextMatrix.clone().premultiply(mesh.matrixWorld);
                applySelectionDelta(nextWorld.multiply(currentWorld.invert()), { key: '', mesh, instanceId });
            });
            input.disabled = rowIndex === 3;
            row.append(input);
        }
        section.append(row);
    }

    const nbtLabel = document.createElement('h3');
    nbtLabel.textContent = 'NBT';
    const nbt = document.createElement('input');
    const objectNbt = loadedObjectGroup.userData.objectNbt as Map<string, string> | undefined;
    nbt.value = objectNbt?.get(uuid) ?? '';
    nbt.oninput = () => objectNbt?.set(uuid, nbt.value);
    section.append(nbtLabel, nbt);
    const isItemDisplay = (loadedObjectGroup.userData.objectIsItemDisplay as Set<string> | undefined)?.has(uuid) ?? false;
    const brightnessMap = loadedObjectGroup.userData.objectBrightness as Map<string, { sky?: number; block?: number }>;
    const brightness = brightnessMap.get(uuid) ?? {};
    const updateBrightness = async (value: { sky: number; block: number }) => {
        brightnessMap.set(uuid, value);
        await replaceDisplayObject(uuid, name, { pivotMode: currentPivotMode, pivotWorld: currentPivotWorld });
    };
    if (isItemDisplay) {
        const metadataLabel = document.createElement('h3');
        metadataLabel.className = 'object-metadata-title';
        metadataLabel.textContent = '개체 속성';
        section.append(metadataLabel);
        const textures = loadedObjectGroup.userData.objectTextures as Map<string, string> | undefined;
        const texture = textures?.get(uuid);
        if (name.startsWith('player_head')) {
            const input = document.createElement('input');
            input.value = texture ?? '';
            input.onchange = async () => {
                input.value = textureUrl(input.value.trim());
                await updatePlayerHeadTexture(uuid, input.value);
            };
            section.append(metadataProperty('texture', '텍스쳐', input));
        }
        section.append(brightnessProperty(brightness, updateBrightness));
        const displayType = (loadedObjectGroup.userData.objectDisplayTypes as Map<string, string> | undefined)?.get(uuid) ?? 'none';
        section.append(metadataProperty('display', '디스플레이', propertySelect(displayType, itemDisplayValues, async value => {
            await updateDisplayObjectMatrix(uuid, replaceNameDisplay(name, value));
        })));
        sortMetadataRows(section);
    } else {
        const objectBlockProps = loadedObjectGroup.userData.objectBlockProps as Map<string, Record<string, string>> | undefined;
        const props = objectBlockProps?.get(uuid) ?? {};
        const metadataLabel = document.createElement('h3');
        metadataLabel.className = 'object-metadata-title';
        metadataLabel.textContent = '개체 속성';
        section.append(metadataLabel);
        section.append(brightnessProperty(brightness, updateBrightness));
        sortMetadataRows(section);
        void getBlockPropertyOptions(name, props).then(options => {
            Object.entries(options)
                .filter(([, values]) => values.length > 1)
                .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
                .forEach(([key, values]) => {
                    const value = props[key] ?? (values.includes('false') ? 'false' : values[0]);
                    section.append(metadataProperty(key, key, propertySelect(value, values, async next => {
                        await replaceDisplayObject(uuid, replaceNameProperties(name, { ...props, [key]: next }), {
                            pivotMode: currentPivotMode,
                            pivotWorld: currentPivotWorld
                        });
                    })));
                });
            sortMetadataRows(section);
        }).catch(error => {
            console.error('블록 속성 후보를 불러오지 못했습니다.', error);
        });
    }
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
        section.append(row);
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
    section.append(pivotRow);

    const matrixLabel = document.createElement('h3');
    matrixLabel.textContent = '행렬';
    section.append(matrixLabel);
    for (let rowIndex = 0; rowIndex < 4; rowIndex++) {
        const row = document.createElement('div');
        row.className = 'object-property-row matrix';
        for (let column = 0; column < 4; column++) {
            const elementIndex = column * 4 + rowIndex;
            const input = numberInput(groupMatrix.elements[elementIndex], next => {
                const nextMatrix = groupMatrix.clone();
                nextMatrix.elements[elementIndex] = next;
                commitMatrix(nextMatrix);
            });
            input.disabled = rowIndex === 3;
            row.append(input);
        }
        section.append(row);
    }

    const nbtLabel = document.createElement('h3');
    nbtLabel.textContent = 'NBT';
    const nbt = document.createElement('input');
    nbt.value = group.nbt ?? '';
    nbt.oninput = () => { group.nbt = nbt.value; };
    section.append(nbtLabel, nbt);
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
    section.querySelectorAll<HTMLInputElement>('input[type="number"]').forEach((input, index) => {
        if (input !== document.activeElement) input.value = format(values[index]);
    });
}

function renderSelection(selection?: SelectionState, pivotWorld?: Vector3, multiCustomPivotLocal?: Vector3): void {
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
    renderMultiSelectionPivot(current.length > 1 ? multiCustomPivotLocal ?? new Vector3() : undefined);
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
    const detail = (event as CustomEvent<{ selection: SelectionState; pivotWorld?: Vector3; pivotMode: string; multiCustomPivotLocal?: Vector3 }>).detail;
    currentPivotMode = detail.pivotMode;
    renderSelection(detail.selection, detail.pivotWorld, detail.multiCustomPivotLocal);
});
window.addEventListener('pde:blockbench-scale-mode-changed', event => {
    const enabled = (event as CustomEvent<boolean>).detail;
    objectProperties.querySelectorAll<HTMLButtonElement>('.object-scale-direction').forEach(button => { button.hidden = !enabled; });
});
