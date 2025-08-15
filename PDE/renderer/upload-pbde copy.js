    1 const loadedObjectGroup = new THREE.Group();
    2 scene.add(loadedObjectGroup);
    3
    4 // 텍스처 로더 및 캐시
    5 const textureLoader = new THREE.TextureLoader();
    6 const textureCache = new Map();
    7
    8 /**
    9  * 마인크래프트 머리 텍스처를 위한 재질 배열을 생성합니다.
   10  * 텍스처의 각 부분을 잘라내어 큐브의 6개 면에 매핑합니다.
   11  * @param {THREE.Texture} texture - 64x64 머리 텍스처
   12  * @param {boolean} isLayer - 오버레이 레이어(모자)인지 여부
   13  * @returns {THREE.MeshStandardMaterial[]} 큐브의 각 면에 적용될 6개의 재질 배열
   14  */
   15 function createHeadMaterials(texture, isLayer = false) {
   16     texture.colorSpace = THREE.SRGBColorSpace;
   17     texture.magFilter = THREE.NearestFilter;
   18     texture.minFilter = THREE.NearestFilter;
   19     const w = 64; // 텍스처 너비
   20     const h = 64; // 텍스처 높이
   21     // UV 좌표 계산 함수
   22     const uv = (x, y, width, height) => new THREE.Vector2(x / w, 1 - (y + height) / h);
   23     const uvSize = (width, height) => new THREE.Vector2(width / w, height / h);
   24     // 각 면의 UV 좌표 (x, y, 너비, 높이)
   25     const faceUVs = {
   26         right:  [0, 8, 8, 8],
   27         left:   [16, 8, 8, 8],
   28         top:    [8, 0, 8, 8],
   29         bottom: [16, 0, 8, 8],
   30         front:  [8, 8, 8, 8],
   31         back:   [24, 8, 8, 8]
   32     };
   33     const layerUVs = {
   34         right:  [32, 8, 8, 8],
   35         left:   [48, 8, 8, 8],
   36         top:    [40, 0, 8, 8],
   37         bottom: [48, 0, 8, 8],
   38         front:  [40, 8, 8, 8],
   39         back:   [56, 8, 8, 8]
   40     };
   41     const uvs = isLayer ? layerUVs : faceUVs;
   42     const order = ['right', 'left', 'top', 'bottom', 'front', 'back'];
   43     return order.map(face => {
   44         const [x, y, width, height] = uvs[face];
   45         const material = new THREE.MeshStandardMaterial({
   46             map: texture.clone(),
   47             transparent: isLayer,
   48         });
   49         material.map.offset = uv(x, y, width, height);
   50         material.map.repeat = uvSize(width, height);
   51
   52         material.map.repeat.x *= -1;
   53         material.map.offset.x += (width / w);
   54
   55         return material;
   56     });
   57 }