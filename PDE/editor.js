const THREE = require('three')

const container = document.getElementById('viewport')

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000)
camera.position.set(3, 3, 3)
camera.lookAt(0, 0, 0)

const renderer = new THREE.WebGLRenderer()
renderer.setSize(container.clientWidth, container.clientHeight)
container.appendChild(renderer.domElement)

const light = new THREE.DirectionalLight(0xffffff, 1)
light.position.set(10, 10, 10).normalize()
scene.add(light)

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(),
  new THREE.MeshLambertMaterial({ color: 0x00ff00 })
)
scene.add(cube)

function animate() {
  requestAnimationFrame(animate)
  cube.rotation.y += 0.01
  renderer.render(scene, camera)
}
animate()
