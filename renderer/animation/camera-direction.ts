import { BufferGeometry, Float32BufferAttribute, LineBasicNodeMaterial, LineSegments, Quaternion, Vector3, type Group, type Scene } from 'three/webgpu';
import { objectRef } from '../scene-store/object-access';
import { animationCameraObject, gameViewQuaternion, isAnimationCameraPreview } from './animation-camera';
import { animationCameraPose } from './animation-state';

// Like the blue line of Minecraft's hitbox view (F3+B): an arrow from the camera along the way the game looks, 2 blocks long.
// It is a scene helper, not part of the object's model, so it never counts toward the object's overlay or size.
const length = 2, head = .3;
const geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute([
    0, 0, 0, 0, 0, -length,
    0, 0, -length, head / 2, 0, -length + head, 0, 0, -length, -head / 2, 0, -length + head,
    0, 0, -length, 0, head / 2, -length + head, 0, 0, -length, 0, -head / 2, -length + head
], 3));
const helper = new LineSegments(geometry, new LineBasicNodeMaterial({ color: 0x0000ff, depthTest: false, transparent: true }));
helper.matrixAutoUpdate = false;
helper.frustumCulled = false;
helper.renderOrder = 999;
helper.visible = false;

export function addCameraDirection(scene: Scene): void { scene.add(helper); }

/** Places the arrow on the animation camera object, or hides it (no camera object, or camera preview); it follows the object whatever model it shows. */
export function updateCameraDirection(root: Group): void {
    const id = animationCameraObject(root), ref = id && objectRef(root, id);
    if (!ref || isAnimationCameraPreview(root)) { helper.visible = false; return; }
    const pose = animationCameraPose(root, id);
    if (!pose) { helper.visible = false; return; }
    const position = new Vector3(), quaternion = new Quaternion();
    pose.decompose(position, quaternion, new Vector3());
    helper.matrix.compose(position, gameViewQuaternion(quaternion), new Vector3(1, 1, 1));
    helper.matrixWorld.copy(helper.matrix);
    helper.visible = true;
}
