const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
camera.position.z = 5;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const materials = [
  new THREE.MeshBasicMaterial({ color: 0xff0000 }), // 오른쪽
  new THREE.MeshBasicMaterial({ color: 0x00ff00 }), // 왼쪽
  new THREE.MeshBasicMaterial({ color: 0x0000ff }), // 위
  new THREE.MeshBasicMaterial({ color: 0xffff00 }), // 아래
  new THREE.MeshBasicMaterial({ color: 0xff00ff }), // 앞
  new THREE.MeshBasicMaterial({ color: 0x00ffff }), // 뒤
];

const geometry = new THREE.BoxGeometry();
const cube = new THREE.Mesh(geometry, materials);
scene.add(cube);

function animate() {
  requestAnimationFrame(animate);
  cube.rotation.x += 0.01;
  cube.rotation.y += 0.01;
  renderer.render(scene, camera);
}

animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
