import { Euler, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import type { SelectionState } from '../controls/selection/select';
import { loadedObjectGroup } from '../load-project/upload-pbde';
import type { GroupData } from './scene-panel-types';
import * as GroupUtils from '../controls/grouping/group';
import * as Overlay from '../controls/selection/overlay';
import { applyDeltaToSelection } from '../controls/selection/drag';

const title = document.getElementById('details-title')!;
const tabs = document.getElementById('project-tabs')!;
const projectProperties = document.getElementById('project-properties')!;
const objectProperties = document.getElementById('object-properties')!;
const matrix = new Matrix4();
const position = new Vector3();
const rotation = new Euler();
const quaternion = new Quaternion();
const scale = new Vector3();
type PropertySelection = { key: string; group: GroupData } | { key: string; mesh: InstancedMesh; instanceId: number };
let selectionOrder: PropertySelection[] = [];
const visibleSections = new WeakSet<Element>();
let currentPivotOverride: Vector3 | undefined;
const sectionObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const index = Array.prototype.indexOf.call(objectProperties.children, entry.target);
        const item = selectionOrder[index];
        if (item?.key === entry.target.getAttribute('data-key')) {
            const pivot = index === 0 ? currentPivotOverride : undefined;
            if (!entry.target.hasAttribute('data-hydrated')) {
                const section = 'group' in item
                    ? renderGroup(item.group, index, pivot)
                    : renderObject(item.mesh, item.instanceId, index, pivot);
                section.dataset.key = item.key;
                section.dataset.hydrated = '';
                entry.target.replaceWith(section);
                sectionObserver.unobserve(entry.target);
                sectionObserver.observe(section);
                visibleSections.add(section);
            } else {
                visibleSections.add(entry.target);
                updateSection(entry.target, item, pivot);
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

function setInstanceMatrix(mesh: InstancedMesh, instanceId: number, next: Matrix4): void {
    mesh.setMatrixAt(instanceId, next);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    window.dispatchEvent(new CustomEvent('pde:scene-updated'));
}

function renderObject(mesh: InstancedMesh, instanceId: number, index: number, pivotOverride?: Vector3): HTMLElement {
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

    const values = [position.clone(), rotation.clone(), scale.clone()];
    ['위치', '회전', '크기'].forEach((label, rowIndex) => {
        const row = document.createElement('div');
        row.className = 'object-property-row';
        const rowLabel = document.createElement('label');
        rowLabel.textContent = label;
        row.append(rowLabel);
        (['x', 'y', 'z'] as const).forEach(axis => row.append(numberInput(
            rowIndex === 1 ? values[rowIndex][axis] * 180 / Math.PI : values[rowIndex][axis],
            next => {
                mesh.getMatrixAt(instanceId, matrix);
                matrix.decompose(position, quaternion, scale);
                rotation.setFromQuaternion(quaternion);
                if (rowIndex === 0) position[axis] = next;
                else if (rowIndex === 1) rotation[axis] = next * Math.PI / 180;
                else scale[axis] = next;
                setInstanceMatrix(mesh, instanceId, matrix.compose(position, quaternion.setFromEuler(rotation), scale));
            }
        )));
        section.append(row);
    });

    const pivotBase = new Vector3();
    const displayType = Overlay.getDisplayType(mesh, instanceId);
    if (displayType === 'block_display') Overlay.getInstanceLocalBoxMin(mesh, instanceId, pivotBase);
    else if (displayType === 'item_display') Overlay.getInstanceLocalBox(mesh, instanceId)?.getCenter(pivotBase);
    const storedPivot = (mesh.userData.customPivots as Map<number, Vector3> | undefined)?.get(instanceId);
    const pivot = pivotOverride?.clone() ?? storedPivot?.clone().sub(pivotBase) ?? new Vector3();
    const pivotRow = document.createElement('div');
    pivotRow.className = 'object-property-row';
    const pivotLabel = document.createElement('label');
    pivotLabel.textContent = '피벗';
    pivotRow.append(pivotLabel);
    (['x', 'y', 'z'] as const).forEach(axis => pivotRow.append(numberInput(pivot[axis], next => {
        if (!mesh.userData.customPivots) mesh.userData.customPivots = new Map<number, Vector3>();
        pivot[axis] = next;
        (mesh.userData.customPivots as Map<number, Vector3>).set(instanceId, pivot.clone().add(pivotBase));
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
                matrix.elements[elementIndex] = next;
                setInstanceMatrix(mesh, instanceId, matrix);
            });
            input.disabled = rowIndex === 3 && column >= 2;
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
    return section;
}

function renderGroup(group: GroupData, index: number, pivotOverride?: Vector3): HTMLElement {
    const groupPosition = new Vector3(group.position.x, group.position.y, group.position.z);
    const groupQuaternion = new Quaternion(group.quaternion.x, group.quaternion.y, group.quaternion.z, group.quaternion.w);
    const groupScale = new Vector3(group.scale.x, group.scale.y, group.scale.z);
    const groupRotation = new Euler().setFromQuaternion(groupQuaternion);
    const groupMatrix = group.matrix?.clone() ?? new Matrix4().compose(groupPosition, groupQuaternion, groupScale);
    const commitMatrix = (next: Matrix4): void => {
        const deltaMatrix = next.clone().multiply(groupMatrix.clone().invert());
        const meshToInstanceIds = new Map<InstancedMesh, number[]>();
        for (const child of GroupUtils.getAllGroupChildren(loadedObjectGroup, group.id)) {
            if (!(child.mesh instanceof InstancedMesh)) continue;
            const ids = meshToInstanceIds.get(child.mesh) ?? [];
            ids.push(child.instanceId);
            meshToInstanceIds.set(child.mesh, ids);
        }
        applyDeltaToSelection({
            deltaMatrix,
            meshToInstanceIds,
            selectedGroupIds: new Set([group.id]),
            loadedObjectGroup
        });
        next.decompose(groupPosition, groupQuaternion, groupScale);
        groupMatrix.copy(next);
        for (const mesh of meshToInstanceIds.keys()) {
            mesh.computeBoundingBox();
            mesh.computeBoundingSphere();
        }
        window.dispatchEvent(new CustomEvent('pde:scene-updated'));
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
        (['x', 'y', 'z'] as const).forEach(axis => row.append(numberInput(
            rowIndex === 1 ? values[rowIndex][axis] * 180 / Math.PI : values[rowIndex][axis],
            next => {
                groupMatrix.decompose(groupPosition, groupQuaternion, groupScale);
                groupRotation.setFromQuaternion(groupQuaternion);
                if (rowIndex === 0) groupPosition[axis] = next;
                else if (rowIndex === 1) groupRotation[axis] = next * Math.PI / 180;
                else groupScale[axis] = next;
                commitMatrix(groupMatrix.clone().compose(groupPosition, groupQuaternion.setFromEuler(groupRotation), groupScale));
            }
        )));
        section.append(row);
    });

    const pivot = pivotOverride?.clone() ?? new Vector3(...(group.pivot ?? [0, 0, 0]));
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
            input.disabled = rowIndex === 3 && column >= 2;
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

function updateSection(section: Element, item: PropertySelection, pivotOverride?: Vector3): void {
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
        pivot = pivotOverride?.clone() ?? new Vector3(...(group.pivot ?? [0, 0, 0]));
    } else {
        item.mesh.getMatrixAt(item.instanceId, nextMatrix);
        nextMatrix.decompose(nextPosition, nextQuaternion, nextScale);
        const pivotBase = new Vector3();
        const displayType = Overlay.getDisplayType(item.mesh, item.instanceId);
        if (displayType === 'block_display') Overlay.getInstanceLocalBoxMin(item.mesh, item.instanceId, pivotBase);
        else if (displayType === 'item_display') Overlay.getInstanceLocalBox(item.mesh, item.instanceId)?.getCenter(pivotBase);
        const storedPivot = (item.mesh.userData.customPivots as Map<number, Vector3> | undefined)?.get(item.instanceId);
        pivot = pivotOverride?.clone() ?? storedPivot?.clone().sub(pivotBase) ?? new Vector3();
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

function renderSelection(selection?: SelectionState, pivotOverride?: Vector3): void {
    if (document.activeElement instanceof HTMLInputElement && objectProperties.contains(document.activeElement)) return;
    const groups = loadedObjectGroup.userData.groups as Map<string, GroupData> | undefined;
    const current: PropertySelection[] = [
        ...Array.from(selection?.groups ?? []).flatMap(id => {
            const group = groups?.get(id);
            return group ? [{ key: `group:${id}`, group }] : [];
        }),
        ...Array.from(selection?.objects ?? []).flatMap(([mesh, ids]) => mesh instanceof InstancedMesh
            ? Array.from(ids, instanceId => ({ key: `object:${mesh.uuid}:${instanceId}`, mesh, instanceId }))
            : [])
    ];
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
    currentPivotOverride = pivotOverride;
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
                updateSection(sections[index], item, index === 0 ? pivotOverride : undefined);
            }
        });
        return;
    }
    sectionObserver.disconnect();
    const lazy = selectionOrder.length > 20;
    const nextSections = selectionOrder.map((item, index) => {
        if (!lazy) {
            const section = 'group' in item
                ? renderGroup(item.group, index, index === 0 ? pivotOverride : undefined)
                : renderObject(item.mesh, item.instanceId, index, index === 0 ? pivotOverride : undefined);
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
window.addEventListener('pde:object-transform-changed', event => {
    const detail = (event as CustomEvent<{ selection: SelectionState; pivot?: Vector3 }>).detail;
    renderSelection(detail.selection, detail.pivot);
});
