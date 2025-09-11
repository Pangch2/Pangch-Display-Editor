import * as pako from 'pako';
//import { requiredPrefixes } from './main.js';

/**
 * 두 개의 4x4 행렬(1차원 배열)을 곱합니다.
 * @param {number[]} parent - 부모 행렬 (16개 요소)
 * @param {number[]} child - 자식 행렬 (16개 요소)
 * @returns {number[]} 결과 행렬 (16개 요소)
 */
function apply_transforms(parent, child) {
    const result = new Array(16);
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            result[i * 4 + j] =
                parent[i * 4 + 0] * child[0 + j] +
                parent[i * 4 + 1] * child[4 + j] +
                parent[i * 4 + 2] * child[8 + j] +
                parent[i * 4 + 3] * child[12 + j];
        }
    }
    return result;
}

/**
 * JSON 데이터의 children 배열을 순회하며 조건에 맞게 데이터를 필터링하고 정제합니다.
 * @param {Array} children - 원본 children 배열
 * @returns {Array} 처리된 children 배열
 */


function split_children(children) {
    if (!children) return [];
    return children.map(item => {
        const newItem = {};

        // 조건 1: 특정 display 키 포함
        if (item.isCollection) newItem.isCollection = true;
        if (item.isItemDisplay) newItem.isItemDisplay = true;
        if (item.isBlockDisplay) newItem.isBlockDisplay = true;
        if (item.isTextDisplay) newItem.isTextDisplay = true;

        // 조건 2: name, nbt 항상 포함
        newItem.name = item.name || "";
        newItem.nbt = item.nbt || "";

        // 조건 3: brightness 조건부 포함
        if (item.brightness && (item.brightness.sky !== 15 || item.brightness.block !== 0)) {
            newItem.brightness = item.brightness;
        }

        // 조건 4: tagHead, options, paintTexture, textureValueList 조건부 포함
        if (item.tagHead) newItem.tagHead = item.tagHead;
        if (item.options) newItem.options = item.options;
        if (item.paintTexture) newItem.paintTexture = item.paintTexture;
        if (item.textureValueList) newItem.textureValueList = item.textureValueList;



        // 조건 5: transforms 항상 포함
        newItem.transforms = item.transforms || "";

        // 조건 6: children 재귀적 포함
        if (item.children) {
            newItem.children = split_children(item.children);
        }
        //console.log("split_children 결과:", JSON.stringify(newItem, null, 2));
        return newItem;
    });
}

/**
 * 재귀적으로 모델 계층을 순회하며 각 객체의 최종 월드 변환 행렬을 계산하여
 * 평탄화된 렌더링 목록을 생성합니다.
 * @param {Array} nodes - 처리할 노드 배열
 * @param {number[]} parentTransform - 부모의 월드 변환 행렬
 * @param {Array} renderList - 최종 렌더링 목록 (평탄화된 배열)
 */
function processNodesAndFlatten(nodes, parentTransform, renderList) {
    if (!nodes) return;

    for (const node of nodes) {
        const worldTransform = apply_transforms(parentTransform, node.transforms);

        if (node.isBlockDisplay || node.isItemDisplay || node.isTextDisplay) {
            const renderItem = {
                name: node.name,
                transform: worldTransform,
                nbt: node.nbt,
                isBlockDisplay: node.isBlockDisplay,
                isItemDisplay: node.isItemDisplay,
                isTextDisplay: node.isTextDisplay,
                options: node.options,
                brightness: node.brightness
            };

            // isItemDisplay가 player_head일 경우 텍스처 URL 처리 로직 추가
            if (node.isItemDisplay && node.name.toLowerCase().startsWith('player_head')) {
                let textureUrl = null;
                const defaultTextureValue = 'http://textures.minecraft.net/texture/d94e1686adb67823c7e5148c2c06e2d95c1b66374409e96b32dc1310397e1711';
                if (node.tagHead && node.tagHead.Value) {
                    try {
                        textureUrl = JSON.parse(atob(node.tagHead.Value)).textures.SKIN.url;
                    } catch (err) {
                        console.error("Worker: tagHead 처리 오류:", err);
                    }
                } else if (node.paintTexture) {
                    if (node.paintTexture.startsWith('data:image')) {
                        textureUrl = node.paintTexture;
                    } else {
                        textureUrl = `data:image/png;base64,${node.paintTexture}`;
                    }
                }

                if (!textureUrl) {
                    try {
                        textureUrl = defaultTextureValue;
                    } catch (err) {
                        console.error("Worker: 기본 텍스처 처리 오류:", err);
                    }
                }
                //textureUrl = textureUrl.replace('http://', 'https://');
                renderItem.textureUrl = textureUrl; // 계산된 URL 추가
            }

            // isBlockDisplay일 경우 blockstate JSON 파일 처리 로직 추가
            if (node.isBlockDisplay && node.name) {
                const baseName = node.name.split('[')[0].toLowerCase(); // [ 이전 부분만 사용
                const blockstatePath = `assets/minecraft/blockstates/${baseName}.json`;
                console.log(`✅ 콘솔 접근 성공: blockstatePath = ${blockstatePath}`);
            }


            renderList.push(renderItem);
        }

        if (node.children) {
            processNodesAndFlatten(node.children, worldTransform, renderList);
        }
    }
}
//워커 메시지 리스너
self.onmessage = (e) => {
    // e.data는 파일에서 읽은 텍스트 문자열입니다.
    const fileContent = e.data;
    let inflatedData, jsonData;

    try {
        // 1. Base64 디코딩
        const decodedData = atob(fileContent);

        // 2. 바이너리 문자열을 Uint8Array로 변환
        const uint8Array = new Uint8Array(decodedData.length);
        for (let i = 0; i < decodedData.length; i++) {
            uint8Array[i] = decodedData.charCodeAt(i);
        }

        // 3. Gzip 압축 해제
        inflatedData = pako.inflate(uint8Array, { to: 'string' });

        // 4. JSON 파싱
        jsonData = JSON.parse(inflatedData);

        // 5. 데이터 정제 (렌더링에 필요한 데이터만 필터링)
        const processedChildren = split_children(jsonData[0].children);
        
        // 6. 계층 구조를 평탄화하고 최종 변환 행렬 계산
        const flatRenderList = [];
        const identityMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; // 단위 행렬
        processNodesAndFlatten(processedChildren, identityMatrix, flatRenderList);

        // 7. 메인 스레드로 최종 결과 전송
        self.postMessage({ success: true, data: flatRenderList });

    } catch (error) {
        // 에러를 문자열로 변환하여 더 많은 정보를 포함시킵니다.
        self.postMessage({
            success: false,
            error: 'Worker Error: ' + String(error) + '\nStack: ' + (error ? error.stack : 'No stack available')
        });
    } finally {
        // 메모리 누수 방지를 위해 작업이 끝나면 주요 대용량 변수들의 참조를 명시적으로 해제합니다.
        // 이를 통해 가비지 컬렉터가 메모리를 더 빨리 회수하도록 유도합니다.
        inflatedData = null;
        jsonData = null;
    }
};