import { Matrix4 } from 'three/webgpu';
import { animationCameraShakeId, animationEndTick, keyTransform, sampleChannelValues, ticksPerSecond,
    type AnimationCameraShake, type AnimationClip, type AnimationTrack } from './animation-data';

function shakeOffsets(shake: AnimationCameraShake, tick: number, rate: number): { translation: [number, number, number]; rotation: [number, number, number] } {
    const time = tick / rate * shake.frequency * Math.PI * 2;
    const wave = (axis: number) => .6 * Math.sin(time * 1.13 + axis * 2.17)
        + .3 * Math.sin(time * 2.41 + axis * 3.71) + .1 * Math.sin(time * 4.79 + axis * 5.13);
    return { translation: [wave(1) * shake.translation, wave(2) * shake.translation, wave(3) * shake.translation],
        rotation: [wave(4) * shake.rotation, wave(5) * shake.rotation, 0] };
}

export function sampleCameraShake(clip: AnimationClip, tick: number): ReturnType<typeof shakeOffsets> {
    const track = clip.tracks.find(track => track.id === animationCameraShakeId);
    const rate = clip.tickRate ?? ticksPerSecond;
    if (clip.cameraShake?.enabled !== false && track?.keys.length) return {
        translation: sampleChannelValues(track.keys, 'translation', tick, rate) as [number, number, number],
        rotation: sampleChannelValues(track.keys, 'rotation', tick, rate) as [number, number, number]
    };
    return clip.cameraShake?.enabled && !track ? shakeOffsets(clip.cameraShake, tick, rate)
        : { translation: [0, 0, 0], rotation: [0, 0, 0] };
}

export function generateCameraShakeTrack(clip: AnimationClip): AnimationTrack {
    const end = animationEndTick(clip), rate = clip.tickRate ?? ticksPerSecond;
    // shortcut: generate at most 10,000 keys at once; stream generation before supporting longer shots.
    if (end >= 10_000) throw new Error('쉐이킹 그래프는 한 번에 10,000키까지 생성할 수 있습니다. 동작을 나눠 주세요.');
    const transform = keyTransform(new Matrix4());
    return { type: 'camera', id: animationCameraShakeId, keys: Array.from({ length: end + 1 }, (_, tick) => ({
        tick, transform: structuredClone(transform), channels: ['translation', 'rotation'],
        values: shakeOffsets(clip.cameraShake!, tick, rate)
    })) };
}
