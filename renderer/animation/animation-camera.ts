import { Euler, Quaternion, Vector3, type Camera, type Group, type Matrix4 } from 'three/webgpu';
import { applySceneVisibility } from '../controls/scene-visibility';
import { getVisibleInstanceIds, objectRef, setInstanceVisible } from '../scene-store/object-access';

type CameraControls = { target: Vector3; enabled: boolean; update(): unknown };
// `controls` is a getter: the gizmo swaps the editing controls for new ones, and the camera must follow the live ones.
type CameraBinding = { camera: () => Camera; controls: () => CameraControls; preview: boolean; hidden?: string;
    saved?: { camera: Camera; position: Vector3; quaternion: Quaternion; target: Vector3; enabled: boolean } };
const bindings = new WeakMap<Group, CameraBinding>();

export function bindAnimationCamera(root: Group, camera: () => Camera, controls: () => CameraControls): void {
    bindings.set(root, { camera, controls, preview: false });
}

/** While previewing, the view is the camera object's: anything that turned the editing controls back on is undone. */
export function lockAnimationCameraControls(root: Group): void {
    const binding = bindings.get(root);
    if (binding?.preview && binding.saved) binding.controls().enabled = false; // before `saved` exists the view has not moved yet
}

export function isAnimationCameraPreview(root: Group): boolean { return bindings.get(root)?.preview ?? false; }

/** The object the animation camera follows, while it is in the scene. */
export function animationCameraObject(root: Group): string | undefined {
    const id = root.userData.animation?.camera as string | undefined;
    return id && root.userData.objectUuidToInstance?.has(id) ? id : undefined;
}

/** Turns `quaternion` into the in-game view rotation: Minecraft Camera.setRotation uses YXZ with zero roll (player /tp takes yaw and pitch only). */
export function gameViewQuaternion(quaternion: Quaternion): Quaternion {
    const forward = new Vector3(0, 0, -1).applyQuaternion(quaternion);
    const yaw = Math.atan2(-forward.x, forward.z), pitch = -Math.asin(Math.max(-1, Math.min(1, forward.y)));
    return quaternion.setFromEuler(new Euler(-pitch, Math.PI - yaw, 0, 'YXZ'));
}

/** The editing view's world matrix; a camera key stores it as the camera object's pose. */
export function animationViewMatrix(root: Group): Matrix4 {
    const binding = bindings.get(root);
    if (!binding) throw new Error('카메라가 아직 준비되지 않았습니다.');
    const camera = binding.camera();
    camera.updateMatrixWorld();
    return camera.matrixWorld.clone();
}

export function setAnimationCameraPreview(root: Group, enabled: boolean): void {
    const binding = bindings.get(root);
    if (!binding) return;
    binding.preview = enabled;
    if (!enabled) restoreCamera(root, binding);
}

function restoreCamera(root: Group, binding: CameraBinding): void {
    if (binding.hidden) { applySceneVisibility(root, [binding.hidden]); delete binding.hidden; }
    const saved = binding.saved;
    if (!saved) return;
    if (saved.camera === binding.camera()) {
        saved.camera.position.copy(saved.position); saved.camera.quaternion.copy(saved.quaternion);
        binding.controls().target.copy(saved.target);
    }
    binding.controls().enabled = saved.enabled;
    delete binding.saved;
    binding.controls().update();
    window.dispatchEvent(new Event('pde:camera-changed'));
}

/** Moves the view to the camera object `id`, whose display transform in world space is `matrix`. */
export function previewAnimationCamera(root: Group, id?: string, matrix?: Matrix4): void {
    const binding = bindings.get(root);
    if (!binding?.preview) return;
    if (!id || !matrix) { restoreCamera(root, binding); return; }
    const camera = binding.camera(), controls = binding.controls();
    if (binding.saved && binding.saved.camera !== camera) { setAnimationCameraPreview(root, false); return; }
    binding.saved ??= { camera, position: camera.position.clone(), quaternion: camera.quaternion.clone(),
        target: controls.target.clone(), enabled: controls.enabled };
    const position = new Vector3(), quaternion = new Quaternion();
    matrix.decompose(position, quaternion, new Vector3());
    if (![...position.toArray(), ...quaternion.toArray()].every(Number.isFinite)) throw new Error('잘못된 카메라 위치입니다.');
    gameViewQuaternion(quaternion);
    // The view sits inside the camera's own model, which the game never draws for its viewer.
    if (binding.hidden !== id) {
        if (binding.hidden) applySceneVisibility(root, [binding.hidden]);
        binding.hidden = id;
    }
    const ref = objectRef(root, id);
    // A batch left with no visible slot must leave the render traversal, or showing it again is never drawn.
    if (ref && setInstanceVisible(ref.mesh, ref.instanceId, false)) ref.mesh.visible = getVisibleInstanceIds(ref.mesh).length > 0;
    controls.enabled = false;
    camera.position.copy(position); camera.quaternion.copy(quaternion);
    const distance = Math.max(.1, binding.saved.position.distanceTo(binding.saved.target));
    controls.target.set(0, 0, -distance).applyQuaternion(quaternion).add(position);
    camera.updateMatrixWorld();
    window.dispatchEvent(new Event('pde:camera-changed'));
}
