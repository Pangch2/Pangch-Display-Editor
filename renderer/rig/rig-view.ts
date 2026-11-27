import { Box3, BufferGeometry, Float32BufferAttribute, LineBasicNodeMaterial, Matrix4, Object3D, Quaternion, Vector3, type Camera, type Group, type Renderer, type Scene } from 'three/webgpu';
import type { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { setupGizmo } from '../controls/gizmo/gizmo-setup';
import { readGizmoDragValues } from '../controls/gizmo/drag-values';
import { isShortcutPressed, matchesPointerShortcut } from '../controls/input/shortcuts';
import { currentSelection } from '../controls/selection/select';
import { OverlayBatch } from '../gpu-draw/overlay-batch';
import { recordStateChange, refreshHistory } from '../controls/undo-redo/scene-history';
import { animationSession, captureAnimationSnapshot, previewAnimation, recordAnimationTransform, restoreAnimationSnapshot, type AnimationSnapshot } from '../animation/animation-state';
import { copyRigNodes, findRigNode, pasteRigNodes, removeRigNode, rigBoneColors, rigDescendants, rigRestWorlds, setRigRestWorld,
    type RigArmature, type RigClip, type RigData } from './rig-data';
import { beginRigEdit, editRig, type RigEdit } from './rig-edit';

let boneMode = false;
/** Selected bones, nulls or armatures in click order; the last bone or null anchors the gizmo. */
let selection: string[] = [];
let objectsSelected = false;
let clipboard: RigClip | undefined;
let view: { root: Group; renderer: Renderer; getCamera: () => Camera; controls: TransformControls; editor: TransformControls; proxy: Object3D; lines: OverlayBatch; signature: string } | undefined;

export const isBoneMode = () => boneMode;
export const selectedRigNode = (): string | null => selection[selection.length - 1] ?? null;
export const selectedRigNodes = (): readonly string[] => selection;

export function setBoneMode(enabled: boolean): void {
    if (boneMode === enabled) return;
    boneMode = enabled;
    if (!enabled) selectRigNode(null);
    syncGizmo();
    window.dispatchEvent(new Event('pde:bone-mode-changed'));
}

const rigOf = (root: Group) => (root.userData.rig as RigData | undefined)?.armatures ?? [];
const isNode = (id: string) => { const found = view && findRigNode(view.root, id); return !!(found?.bone || found?.null); };
const anchorId = (): string | undefined => [...selection].reverse().find(isNode);

/** Picking bones or nulls clears the display selection, as a Blockbench selection holds one kind; toggling one in or out keeps it. */
export function selectRigNodes(ids: readonly string[], { toggle = false, keepDisplays = toggle } = {}): void {
    if (!view) return;
    const valid = ids.filter(id => findRigNode(view!.root, id));
    selection = toggle ? [...selection.filter(id => !valid.includes(id)), ...valid.filter(id => !selection.includes(id))] : [...new Set(valid)];
    if (!keepDisplays && valid.some(isNode)) {
        (view.root.userData.resetSelection as (() => void) | undefined)?.();
        objectsSelected = false;
    }
    window.dispatchEvent(new CustomEvent('pde:selection-changed', { detail: { ...currentSelection, rig: [...selection] } }));
    syncGizmo();
    window.dispatchEvent(new Event('pde:rig-selection-changed'));
}

export function selectRigNode(id: string | null, toggle = false): void { selectRigNodes(id ? [id] : [], { toggle }); }

/** Select all with bones selected: every bone and null. */
export function rigSelectAll(): boolean {
    if (!view || !boneMode || !selection.some(isNode)) return false;
    selectRigNodes(rigOf(view.root).flatMap(armature => [...armature.bones, ...armature.nulls].map(node => node.id)));
    return true;
}

/** Selected bones and nulls under no other selected node, by armature: moving, copying or duplicating them carries the rest. */
function selectedTops(): Map<RigArmature, string[]> {
    const result = new Map<RigArmature, string[]>(), chosen = new Set(selection);
    for (const id of selection) {
        const found = findRigNode(view!.root, id), node = found?.bone ?? found?.null;
        if (!found || !node) continue;
        let parent = node.parent, covered = false;
        while (parent && !covered) {
            covered = chosen.has(parent);
            parent = found.armature.bones.find(bone => bone.id === parent)?.parent ?? null;
        }
        if (!covered) result.set(found.armature, [...result.get(found.armature) ?? [], id]);
    }
    return result;
}

/** Forgets copied bones once displays are copied, so paste brings back whatever was copied last. */
export function clearRigClipboard(): void { clipboard = undefined; }

/**
 * Delete, duplicate, copy and paste for the bone mode selection; false leaves the action to the editor. Structure edits belong to
 * edit mode: in animation mode a paste of copied bones is refused rather than falling back to pasting displays.
 */
export function rigEditAction(action: string): boolean {
    if (!view || !boneMode) return false;
    const root = view.root;
    if (action === 'copySelection') {
        const anchor = anchorId(), armature = anchor && findRigNode(root, anchor)?.armature, tops = armature && selectedTops().get(armature);
        if (!armature || !tops) return false;
        clipboard = copyRigNodes(armature, tops);
        return true;
    }
    if (action === 'pasteSelection') {
        if (!clipboard) return false;
        if (animating()) return true;
        const primary = selectedRigNode(), found = primary ? findRigNode(root, primary) : undefined, armature = found?.armature ?? rigOf(root)[0];
        if (!armature) return false;
        let pasted: string[] = [];
        editRig(root, () => { pasted = pasteRigNodes(armature, clipboard!, found?.bone?.id ?? found?.null?.parent ?? null); });
        selectRigNodes(pasted);
        return true;
    }
    if (!selection.length || animating()) return false;
    if (action === 'deleteSelection') {
        const ids = [...selection];
        editRig(root, () => { for (const id of ids) removeRigNode(root, id); });
        selectRigNode(null);
        return true;
    }
    if (action !== 'duplicate') return false;
    const copies: string[] = [];
    editRig(root, () => { for (const [armature, ids] of selectedTops()) copies.push(...pasteRigNodes(armature, copyRigNodes(armature, ids))); });
    if (copies.length) selectRigNodes(copies);
    return !!copies.length;
}

/** World bounds of the selected bones and nulls (every node of a selected armature), for focusing the camera. */
export function rigSelectionBox(): Box3 | undefined {
    if (!view || !boneMode || !selection.length) return undefined;
    const root = view.root, worlds = posedWorlds(root), box = new Box3();
    root.updateWorldMatrix(true, false);
    for (const id of selection) {
        const found = findRigNode(root, id), node = found?.bone ?? found?.null;
        if (!found) continue;
        for (const entry of node ? [node] : [...found.armature.bones, ...found.armature.nulls]) {
            const world = new Matrix4().multiplyMatrices(root.matrixWorld, worlds.get(entry.id)!);
            const bone = 'length' in entry ? entry : undefined;
            box.union(new Box3().setFromPoints([new Vector3().applyMatrix4(world), new Vector3(0, bone?.length ?? 0, 0).applyMatrix4(world)])
                .expandByScalar(bone ? bone.width / 2 : .08));
        }
    }
    return box.isEmpty() ? undefined : box;
}

function posedWorlds(root: Group): Map<string, Matrix4> {
    const posed = root.userData.rigPose as Map<string, number[]> | undefined, worlds = new Map<string, Matrix4>();
    for (const armature of rigOf(root)) {
        for (const [id, world] of rigRestWorlds(armature)) worlds.set(id, posed?.has(id) ? new Matrix4().fromArray(posed.get(id)!) : world);
    }
    return worlds;
}

const animating = () => !!view && animationSession(view.root).enabled;

function syncGizmo(): void {
    if (!view) return;
    const anchor = anchorId();
    if (!boneMode || objectsSelected || !anchor) { view.controls.detach(); return; }
    const world = posedWorlds(view.root).get(anchor)!;
    view.root.updateWorldMatrix(true, false);
    new Matrix4().multiplyMatrices(view.root.matrixWorld, world).decompose(view.proxy.position, view.proxy.quaternion, view.proxy.scale);
    view.proxy.updateMatrixWorld(true);
    // In edit mode the scale tool sizes bones (length and width) and nulls only move; animation keys may rotate and scale both.
    // The editor's gizmo (toolbar, shortcuts) owns the tool and space; the bone gizmo follows it.
    const mode = !animating() && !selection.some(id => findRigNode(view!.root, id)?.bone) ? 'translate' : view.editor.mode;
    if (view.controls.mode !== mode) view.controls.setMode(mode);
    if (view.controls.space !== view.editor.space) view.controls.setSpace(view.editor.space);
    if (view.controls.object !== view.proxy) view.controls.attach(view.proxy);
}

const tip = new Vector3(), corner = new Vector3();
function rebuildLines(): void {
    const { root, lines } = view!;
    const armatures = rigOf(root);
    lines.visible = boneMode && armatures.some(armature => armature.bones.length || armature.nulls.length);
    if (!lines.visible) return;
    const signature = JSON.stringify([armatures, selection, [...(root.userData.rigPose as Map<string, number[]> | undefined) ?? []]]);
    if (signature === view!.signature) return;
    view!.signature = signature;
    const worlds = posedWorlds(root), chosen = new Set(selection), positions: number[] = [], colors: number[] = [];
    const segment = (a: Vector3, b: Vector3, color: number) => {
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        for (let index = 0; index < 2; index++) colors.push((color >> 16 & 255) / 255, (color >> 8 & 255) / 255, (color & 255) / 255);
    };
    for (const armature of armatures) {
        for (const bone of armature.bones) {
            const world = worlds.get(bone.id)!, color = chosen.has(bone.id) ? 0xffffff : rigBoneColors[bone.color % rigBoneColors.length];
            const origin = new Vector3().applyMatrix4(world);
            tip.set(0, bone.length, 0).applyMatrix4(world);
            // Blockbench draws a bone as an octahedron, widest near its origin.
            const ring = [[1, 0], [0, 1], [-1, 0], [0, -1]].map(([x, z]) => corner.set(x * bone.width / 2, bone.length * .15, z * bone.width / 2).applyMatrix4(world).clone());
            ring.forEach((point, index) => { segment(origin, point, color); segment(point, tip, color); segment(point, ring[(index + 1) % 4], color); });
        }
        for (const point of armature.nulls) {
            const center = new Vector3().applyMatrix4(worlds.get(point.id)!), color = chosen.has(point.id) ? 0xffffff : 0xb0b0b0, size = .08;
            for (const axis of [new Vector3(size, 0, 0), new Vector3(0, size, 0), new Vector3(0, 0, size)]) segment(center.clone().sub(axis), center.clone().add(axis), color);
            const target = point.ikTarget && worlds.get(point.ikTarget);
            if (target) segment(center, new Vector3().applyMatrix4(target), 0x707070);
        }
    }
    const geometry = lines.draw.geometry;
    const position = geometry.getAttribute('position') as Float32BufferAttribute | undefined;
    if (position?.array.length === positions.length) {
        (position.array as Float32Array).set(positions); position.needsUpdate = true;
        const color = geometry.getAttribute('color') as Float32BufferAttribute;
        (color.array as Float32Array).set(colors); color.needsUpdate = true;
    } else {
        geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
        geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    }
}

type Point = { x: number; y: number };
/** Root-space points to client pixels; undefined behind the camera. */
function projector(): (point: Vector3) => Point | undefined {
    const { root, renderer, getCamera } = view!, rect = renderer.domElement.getBoundingClientRect(), camera = getCamera();
    return point => {
        const value = point.clone().applyMatrix4(root.matrixWorld).project(camera);
        return value.z > 1 ? undefined : { x: (value.x + 1) / 2 * rect.width + rect.left, y: (1 - value.y) / 2 * rect.height + rect.top };
    };
}

/** The bone or null drawn nearest the pointer, within a few pixels. */
function pick(event: PointerEvent): string | undefined {
    const screen = projector(), worlds = posedWorlds(view!.root);
    let best: string | undefined, distance = 8;
    const consider = (id: string, a?: Point, b = a) => {
        if (!a || !b) return;
        const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
        const amount = length ? Math.min(1, Math.max(0, ((event.clientX - a.x) * dx + (event.clientY - a.y) * dy) / length)) : 0;
        const value = Math.hypot(event.clientX - a.x - dx * amount, event.clientY - a.y - dy * amount);
        if (value < distance) { distance = value; best = id; }
    };
    for (const armature of rigOf(view!.root)) {
        for (const bone of armature.bones) {
            const world = worlds.get(bone.id)!;
            consider(bone.id, screen(new Vector3().applyMatrix4(world)), screen(new Vector3(0, bone.length, 0).applyMatrix4(world)));
        }
        for (const point of armature.nulls) consider(point.id, screen(new Vector3().applyMatrix4(worlds.get(point.id)!)));
    }
    return best;
}

/** Box select in bone mode: bones (by their middle) and nulls inside win over displays, as a click on a bone does; none leaves the displays. */
function boxSelect(a: Point, b: Point): void {
    const screen = projector(), worlds = posedWorlds(view!.root), ids: string[] = [];
    const inside = (point?: Point) => !!point && point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x) && point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y);
    for (const armature of rigOf(view!.root)) {
        for (const bone of armature.bones) if (inside(screen(new Vector3(0, bone.length / 2, 0).applyMatrix4(worlds.get(bone.id)!)))) ids.push(bone.id);
        for (const point of armature.nulls) if (inside(screen(new Vector3().applyMatrix4(worlds.get(point.id)!)))) ids.push(point.id);
    }
    if (ids.length) selectRigNodes(ids);
}

/** Steps counted from the drag's start, or from zero (the grid) with align, as the editor's gizmo snaps. */
const snap = (value: number, start: number, step: number | null, align: boolean) => {
    const from = align ? 0 : start;
    return step ? from + Math.round((value - from) / step) * step : value;
};

export function initRigView({ scene, renderer, getCamera, getControls, root, editor, isVertexMode }: { scene: Scene; renderer: Renderer; getCamera: () => Camera;
    getControls: () => { enabled: boolean }; root: Group; editor: TransformControls; isVertexMode: () => boolean }): void {
    const { transformControls: controls } = setupGizmo(getCamera(), renderer, scene);
    const proxy = new Object3D();
    scene.add(proxy);
    // One non-instanced draw of the whole skeleton, like the hover line overlay.
    const lines = new OverlayBatch('lines', new BufferGeometry(), new LineBasicNodeMaterial({ vertexColors: true, depthTest: false, depthWrite: false, transparent: true }));
    lines.count = 1; lines.renderOrder = 998; lines.matrixAutoUpdate = false;
    scene.add(lines);
    view = { root, renderer, getCamera, controls, editor, proxy, lines, signature: '' };

    let drag: { edit?: RigEdit; animation?: AnimationSnapshot; moved: boolean; position: Vector3; quaternion: Quaternion; scale: Vector3;
        sizes: Map<string, { length: number; width: number }>; values: ReturnType<typeof readGizmoDragValues> } | undefined;
    controls.addEventListener('dragging-changed', event => { getControls().enabled = !(event as unknown as { value: boolean }).value; });
    controls.addEventListener('mouseDown', () => {
        if (!anchorId()) return;
        window.dispatchEvent(new Event('pde:transform-start'));
        const sizes = new Map(selection.flatMap(id => { const bone = findRigNode(root, id)?.bone; return bone ? [[id, { length: bone.length, width: bone.width }] as const] : []; }));
        drag = { edit: animating() ? undefined : beginRigEdit(root), animation: animating() ? captureAnimationSnapshot(root) : undefined, moved: false,
            position: proxy.position.clone(), quaternion: proxy.quaternion.clone(), scale: proxy.scale.clone(), sizes, values: readGizmoDragValues() };
    });
    controls.addEventListener('objectChange', () => {
        const anchor = anchorId();
        if (!drag || !anchor) return;
        const { values } = drag, fine = isShortcutPressed('fineAdjust'), scaleStep = fine ? values.fineScale : values.scale;
        if (controls.mode === 'translate') {
            const step = fine ? values.finePosition : values.position, local = controls.space === 'local', axis = controls.axis ?? '';
            const origin = values.align ? new Vector3() : drag.position, delta = proxy.position.clone().sub(origin);
            if (local) delta.applyQuaternion(drag.quaternion.clone().invert());
            // Undragged axes keep their off-grid value with align.
            if (step) for (const key of ['x', 'y', 'z'] as const) if (!values.align || axis.includes(key.toUpperCase())) delta[key] = Math.round(delta[key] / step) * step;
            if (local) delta.applyQuaternion(drag.quaternion);
            proxy.position.copy(origin).add(delta);
        }
        if (controls.mode === 'scale' && !animating()) {
            // The gizmo scales in the bone's own axes: Y is its length, X or Z (whichever moved more) its width; steps are of length and width.
            const factor = proxy.scale.clone().divide(drag.scale), across = Math.abs(Math.abs(factor.x - 1) >= Math.abs(factor.z - 1) ? factor.x : factor.z);
            for (const [id, size] of drag.sizes) {
                const bone = findRigNode(root, id)?.bone;
                if (!bone) continue;
                bone.length = Math.max(0, snap(size.length * Math.abs(factor.y), size.length, scaleStep, values.align));
                bone.width = Math.max(0, snap(size.width * across, size.width, scaleStep, values.align));
            }
            return;
        }
        if (controls.mode === 'scale') for (const key of ['x', 'y', 'z'] as const) proxy.scale[key] = snap(proxy.scale[key], drag.scale[key], scaleStep, values.align);
        proxy.updateMatrixWorld(true);
        const world = root.matrixWorld.clone().invert().multiply(proxy.matrixWorld);
        if (drag.edit) {
            // One move for every selected subtree, taken from the anchor; bound displays ride along.
            const armature = findRigNode(root, anchor)!.armature, delta = world.clone().multiply(rigRestWorlds(armature).get(anchor)!.clone().invert());
            for (const [owner, ids] of selectedTops()) for (const id of ids) setRigRestWorld(owner, id, delta.clone().multiply(rigRestWorlds(owner).get(id)!));
            drag.edit.follow();
            return;
        }
        // Each move keys again from the drag's start, so bound displays follow live and the skin is never keyed into them.
        restoreAnimationSnapshot(root, drag.animation);
        const posed: Map<string, number[]> = root.userData.rigPose ??= new Map(), worlds = posedWorlds(root), tops = [...selectedTops()];
        const delta = world.clone().multiply(worlds.get(anchor)!.clone().invert());
        for (const [armature, ids] of tops) for (const id of ids) {
            for (const node of [{ id }, ...rigDescendants(armature, id)]) posed.set(node.id, delta.clone().multiply(worlds.get(node.id)!).toArray());
        }
        recordAnimationTransform(root, drag.animation, tops.flatMap(([, ids]) => ids));
        previewAnimation(root);
        drag.moved = true;
    });
    controls.addEventListener('mouseUp', () => {
        const ended = drag;
        drag = undefined;
        if (!ended) return;
        if (ended.edit) { ended.edit.commit(); syncGizmo(); return; }
        if (!ended.moved) return;
        const after = captureAnimationSnapshot(root);
        recordStateChange({ before: ended.animation, after, apply: state => restoreAnimationSnapshot(root, state),
            refresh: () => { refreshHistory(root); window.dispatchEvent(new Event('pde:animation-changed')); } });
        syncGizmo();
    });

    // Capture on the canvas parent runs before the editor's own pointer handlers on the canvas.
    let press: (Point & { hit?: string; box: boolean; toggle: boolean }) | undefined;
    renderer.domElement.parentElement!.addEventListener('pointerdown', event => {
        delete renderer.domElement.dataset.rigPointer;
        press = undefined;
        if (!boneMode || event.button !== 0 || event.target !== renderer.domElement) return;
        // Gizmo hover only updates on pointer moves; refresh it so a press without one (a second click, pen, touch) still finds a handle.
        const rect = renderer.domElement.getBoundingClientRect();
        const pointer = { x: (event.clientX - rect.left) / rect.width * 2 - 1, y: -(event.clientY - rect.top) / rect.height * 2 + 1, button: 0 };
        controls.pointerHover(pointer); editor.pointerHover(pointer);
        if (controls.object && controls.axis) { renderer.domElement.dataset.rigPointer = 'gizmo'; return; }
        const box = matchesPointerShortcut(event, 'boxSelect');
        // The editor's gizmo handles, box select and vertex mode keep their presses, though bones are drawn over them.
        const hit = editor.axis === null && !isVertexMode() && !box ? pick(event) : undefined;
        // A press on a bone is not the editor's selection click, but dragging from it still orbits the camera.
        if (hit) renderer.domElement.dataset.rigPointer = 'bone';
        press = { x: event.clientX, y: event.clientY, hit, box, toggle: matchesPointerShortcut(event, 'multiSelect') };
    }, { capture: true });
    // Runs after the editor's own click and box selection on the canvas.
    window.addEventListener('pointerup', event => {
        const started = press;
        delete renderer.domElement.dataset.rigPointer;
        press = undefined;
        if (!started) return;
        if (Math.hypot(event.clientX - started.x, event.clientY - started.y) > 5) {
            if (started.box && !isVertexMode()) boxSelect(started, event);
            return;
        }
        if (started.hit) selectRigNode(started.hit, started.toggle);
        // A click that left nothing selected releases the bones too.
        else if (!started.toggle && selection.length && !objectsSelected) selectRigNode(null);
    });
    for (const name of ['mode-changed', 'space-changed']) editor.addEventListener(name, () => { if (!controls.dragging) syncGizmo(); });
    window.addEventListener('pde:selection-changed', event => {
        const detail = (event as CustomEvent).detail;
        if (detail?.rig) return;
        // The editor's selection holds Sets; a display selection hides the bone gizmo so one drag moves one thing.
        objectsSelected = !!(detail?.groups?.size || detail?.objects?.size);
        syncGizmo();
    });
    for (const name of ['pde:rig-changed', 'pde:animation-preview', 'pde:history-restored', 'pde:animation-mode-changed']) window.addEventListener(name, syncGizmo);
    window.addEventListener('pde:active-project-changed', () => selectRigNode(null));
}

/** Per frame: follows camera swaps, the root's transform, pose changes and the editor's rotation step. */
export function updateRigView(): void {
    if (!view) return;
    view.controls.camera = view.getCamera();
    view.root.updateWorldMatrix(true, false);
    view.lines.matrix.copy(view.root.matrixWorld);
    view.lines.matrixWorldNeedsUpdate = true;
    if (selection.some(id => !findRigNode(view!.root, id))) selectRigNodes(selection.filter(id => findRigNode(view!.root, id)), { keepDisplays: true });
    // The editor's gizmo carries the rotation step (settings, fine adjust); translation and scale steps are applied on each move.
    if (view.controls.rotationSnap !== view.editor.rotationSnap) view.controls.setRotationSnap(view.editor.rotationSnap);
    rebuildLines();
    if (boneMode && view.controls.object && !view.controls.dragging && animating()) syncGizmo();
}
