import { Euler, Matrix4, Quaternion, Vector3, type Camera, type Group } from 'three/webgpu';
import { animationCameraId, keyTransform, offsetAnimationChannel, putKey, sampleChannelValues, sampleTrack, type AnimationClip } from './animation-data';
import { sampleCameraShake } from './camera-shake';

type CameraControls = { target: Vector3; enabled: boolean; update(): unknown };
type CameraBinding = { camera: () => Camera; controls: CameraControls; preview: boolean;
    pose?: number[];
    saved?: { camera: Camera; position: Vector3; quaternion: Quaternion; target: Vector3; enabled: boolean } };
const bindings = new WeakMap<Group, CameraBinding>();

export function bindAnimationCamera(root: Group, camera: () => Camera, controls: CameraControls): void {
    bindings.set(root, { camera, controls, preview: false });
}

export function isAnimationCameraPreview(root: Group): boolean { return bindings.get(root)?.preview ?? false; }

export function captureAnimationCamera(root: Group): number[] | undefined {
    const binding = bindings.get(root);
    if (binding?.preview && binding.pose) return [...binding.pose];
    const camera = binding?.camera();
    camera?.updateMatrix();
    return camera?.matrix.toArray();
}

export function setAnimationCameraPreview(root: Group, enabled: boolean): void {
    const binding = bindings.get(root);
    if (!binding) return;
    binding.preview = enabled;
    if (!enabled) restoreCamera(binding);
}

export function editAnimationCameraView(root: Group): void {
    const binding = bindings.get(root);
    if (!binding?.preview) return;
    const saved = binding.saved;
    if (saved && binding.pose && saved.camera === binding.camera()) {
        const distance = Math.max(.1, saved.position.distanceTo(saved.target));
        new Matrix4().fromArray(binding.pose).decompose(saved.position, saved.quaternion, new Vector3());
        saved.target.set(0, 0, -distance).applyQuaternion(saved.quaternion).add(saved.position);
    }
    setAnimationCameraPreview(root, false);
}

function restoreCamera(binding: CameraBinding): void {
    const saved = binding.saved;
    if (!saved) return;
    if (saved.camera === binding.camera()) {
        saved.camera.position.copy(saved.position); saved.camera.quaternion.copy(saved.quaternion);
        binding.controls.target.copy(saved.target);
    }
    binding.controls.enabled = saved.enabled;
    delete binding.saved;
    delete binding.pose;
    binding.controls.update();
    window.dispatchEvent(new Event('pde:camera-changed'));
}

export function recordAnimationCamera(root: Group, clip: AnimationClip, tick: number): void {
    const binding = bindings.get(root);
    if (!binding) throw new Error('카메라가 아직 준비되지 않았습니다.');
    if (binding.preview) throw new Error('카메라 미리보기를 끄고 원하는 시점으로 이동해 주세요.');
    if (!Number.isSafeInteger(tick) || tick < 0) throw new Error('카메라 키프레임은 0 이상의 정수 틱에 추가해 주세요.');
    const camera = binding.camera();
    camera.updateMatrix();
    let track = clip.tracks.find(track => track.id === animationCameraId);
    if (!track) clip.tracks.push(track = { type: 'camera', id: animationCameraId, keys: [] });
    const previous = structuredClone(track.keys);
    const transform = keyTransform(camera.matrix);
    putKey(track, tick, camera.matrix, camera.matrix, ['translation', 'rotation']);
    if (tick === 0 && previous.length) for (const channel of ['translation', 'rotation'] as const) {
        offsetAnimationChannel(track, channel, sampleChannelValues(previous, channel, 0, clip.tickRate),
            sampleChannelValues(track.keys, channel, 0, clip.tickRate, transform));
    }
}

export function previewAnimationCamera(root: Group, layers: Array<{ clip: AnimationClip; tick: number }>, from?: number[], amount = 1): void {
    const binding = bindings.get(root);
    if (!binding?.preview) return;
    const layer = [...layers].reverse().find(({ clip }) => clip.tracks.some(track => track.id === animationCameraId && track.keys.length));
    if (!layer) { restoreCamera(binding); return; }
    const camera = binding.camera(), controls = binding.controls;
    if (binding.saved && binding.saved.camera !== camera) { setAnimationCameraPreview(root, false); return; }
    binding.saved ??= { camera, position: camera.position.clone(), quaternion: camera.quaternion.clone(),
        target: controls.target.clone(), enabled: controls.enabled };
    const track = layer.clip.tracks.find(track => track.id === animationCameraId)!;
    let matrix = sampleTrack(track.keys, layer.tick, layer.clip.tickRate);
    if (from && amount < 1) matrix = sampleTrack([
        { tick: 0, transform: keyTransform(new Matrix4().fromArray(from)) }, { tick: 1, transform: keyTransform(matrix) }
    ], amount);
    const position = new Vector3(), quaternion = new Quaternion();
    matrix.decompose(position, quaternion, new Vector3());
    if (![...position.toArray(), ...quaternion.toArray()].every(Number.isFinite)) throw new Error('잘못된 카메라 키프레임입니다.');
    const forward = new Vector3(0, 0, -1).applyQuaternion(quaternion);
    const yaw = Math.atan2(-forward.x, forward.z), pitch = -Math.asin(Math.max(-1, Math.min(1, forward.y)));
    quaternion.setFromEuler(new Euler(-pitch, Math.PI - yaw, 0, 'YXZ'));
    binding.pose = new Matrix4().compose(position, quaternion, new Vector3(1, 1, 1)).toArray();
    const shake = sampleCameraShake(layer.clip, layer.tick);
    position.add(new Vector3().fromArray(shake.translation));
    // Minecraft Camera.setRotation uses YXZ with zero roll; player /tp accepts yaw and pitch only.
    const shakenPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch + shake.rotation[0] * Math.PI / 180));
    quaternion.setFromEuler(new Euler(-shakenPitch, Math.PI - yaw - shake.rotation[1] * Math.PI / 180, 0, 'YXZ'));
    controls.enabled = false;
    camera.position.copy(position); camera.quaternion.copy(quaternion);
    const distance = Math.max(.1, binding.saved.position.distanceTo(binding.saved.target));
    controls.target.set(0, 0, -distance).applyQuaternion(quaternion).add(position);
    camera.updateMatrixWorld();
    window.dispatchEvent(new Event('pde:camera-changed'));
}
