import { Matrix4, Quaternion, Vector3, type Camera, type Group } from 'three/webgpu';
import { animationCameraId, keyTransform, offsetAnimationChannel, putKey, sampleChannelValues, sampleTrack, type AnimationClip } from './animation-data';

type CameraControls = { target: Vector3; enabled: boolean; update(): unknown };
type CameraBinding = { camera: () => Camera; controls: CameraControls; preview: boolean;
    saved?: { camera: Camera; position: Vector3; quaternion: Quaternion; target: Vector3; enabled: boolean } };
const bindings = new WeakMap<Group, CameraBinding>();

export function bindAnimationCamera(root: Group, camera: () => Camera, controls: CameraControls): void {
    bindings.set(root, { camera, controls, preview: false });
}

export function isAnimationCameraPreview(root: Group): boolean { return bindings.get(root)?.preview ?? false; }

export function captureAnimationCamera(root: Group): number[] | undefined {
    const camera = bindings.get(root)?.camera();
    camera?.updateMatrix();
    return camera?.matrix.toArray();
}

export function setAnimationCameraPreview(root: Group, enabled: boolean): void {
    const binding = bindings.get(root);
    if (!binding) return;
    binding.preview = enabled;
    if (!enabled) restoreCamera(binding);
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
    binding.controls.update();
    window.dispatchEvent(new Event('pde:camera-changed'));
}

export function recordAnimationCamera(root: Group, clip: AnimationClip, tick: number): void {
    const binding = bindings.get(root);
    if (!binding) throw new Error('카메라가 아직 준비되지 않았습니다.');
    if (binding.preview) throw new Error('카메라 미리보기를 끄고 원하는 시점으로 이동해 주세요.');
    const camera = binding.camera();
    camera.updateMatrix();
    let track = clip.tracks.find(track => track.type === 'camera');
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
    const layer = [...layers].reverse().find(({ clip }) => clip.tracks.some(track => track.type === 'camera' && track.keys.length));
    if (!layer) { restoreCamera(binding); return; }
    const camera = binding.camera(), controls = binding.controls;
    if (binding.saved && binding.saved.camera !== camera) { setAnimationCameraPreview(root, false); return; }
    binding.saved ??= { camera, position: camera.position.clone(), quaternion: camera.quaternion.clone(),
        target: controls.target.clone(), enabled: controls.enabled };
    const track = layer.clip.tracks.find(track => track.type === 'camera')!;
    let matrix = sampleTrack(track.keys, layer.tick, layer.clip.tickRate);
    if (from && amount < 1) matrix = sampleTrack([
        { tick: 0, transform: keyTransform(new Matrix4().fromArray(from)) }, { tick: 1, transform: keyTransform(matrix) }
    ], amount);
    const position = new Vector3(), quaternion = new Quaternion();
    matrix.decompose(position, quaternion, new Vector3());
    if (![...position.toArray(), ...quaternion.toArray()].every(Number.isFinite)) throw new Error('잘못된 카메라 키프레임입니다.');
    controls.enabled = false;
    camera.position.copy(position); camera.quaternion.copy(quaternion);
    const distance = Math.max(.1, binding.saved.position.distanceTo(binding.saved.target));
    controls.target.set(0, 0, -distance).applyQuaternion(quaternion).add(position);
    camera.updateMatrixWorld();
    window.dispatchEvent(new Event('pde:camera-changed'));
}
