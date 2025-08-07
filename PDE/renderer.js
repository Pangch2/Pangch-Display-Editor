const THREE = require('three')

let scene, camera, renderer
let cubeList = []
let container = document.getElementById('viewport')

function init() {
  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000)
  camera.position.set(5, 5, 5)
  camera.lookAt(0, 0, 0)

  renderer = new THREE.WebGLRenderer()
  renderer.setSize(container.clientWidth, container.clientHeight)
  container.appendChild(renderer.domElement)

  const light = new THREE.DirectionalLight(0xffffff, 1)
  light.position.set(10, 10, 10).normalize()
  scene.add(light)

  animate()
}

function animate() {
  requestAnimationFrame(animate)
  renderer.render(scene, camera)
}

function addCube() {
  const geometry = new THREE.BoxGeometry()
  const material = new THREE.MeshLambertMaterial({ color: Math.random() * 0xffffff })
  const cube = new THREE.Mesh(geometry, material)
  cube.position.set(Math.floor(Math.random() * 5), 0, 0)
  scene.add(cube)
  cubeList.push(cube)

  const cubeItem = document.createElement('div')
  cubeItem.textContent = `Cube ${cubeList.length}`
  document.getElementById('cubeList').appendChild(cubeItem)
}

document.getElementById('addCube').addEventListener('click', addCube)

init()
