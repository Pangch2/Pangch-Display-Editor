// 전역 광원: 가장 어두운 부분의 밝기를 조절합니다.
const ambientLight = new THREE.AmbientLight(0x404040, 1.0);
scene.add(ambientLight);
// 주 광원 (태양 역할): 가장 강한 빛
const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
keyLight.position.set(1, 1, 1); // 오른쪽 위에서
scene.add(keyLight);
// 보조 광원 (하늘 빛 역할): 그림자를 부드럽게 만듭니다.
const fillLight = new THREE.DirectionalLight(0xffffff, 0.6);
fillLight.position.set(-1, 0.5, -1); // 왼쪽 뒤에서
scene.add(fillLight);
// 하단 광원 (반사광 역할): 아랫면이 너무 어두워지는 것을 방지합니다.
const upLight = new THREE.DirectionalLight(0xffffff, 0.3);
upLight.position.set(0, -1, 0); // 정면 아래에서
scene.add(upLight);