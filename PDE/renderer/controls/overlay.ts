import * as THREE from 'three/webgpu';
import { attribute, mat4, positionLocal, vec3 } from 'three/tsl';
import { SelectedItem, getSelectedItems } from './select';

// ─── 디스플레이 타입별 오버레이 색상 ─────────────────────────────────────────
const OVERLAY_COLOR: Record<string, THREE.Color> = {
    item_display:  new THREE.Color(0x2E87EC),
    block_display: new THREE.Color(0xFFD147),
    default:       new THREE.Color(0x00ff00),
};

function getOverlayColor(mesh: THREE.Object3D, instanceId: number): THREE.Color {
    const anyMesh = mesh as any;
    let type: string | undefined;
    if (anyMesh.isBatchedMesh && anyMesh.userData?.displayTypes) {
        type = anyMesh.userData.displayTypes.get(instanceId);
    } else {
        type = anyMesh.userData?.displayType;
    }
    return OVERLAY_COLOR[type ?? ''] ?? OVERLAY_COLOR['default'];
}

// ─── 유닛 큐브 엣지 지오메트리 (12 edges × 2 vertices = 24 vertices) ──────────
// modelMatrix = identity이므로 이 좌표가 곧 로컬 스페이스 기준점

// 핫 패스 할당 방지용 재사용 상수
const _UNIT3 = new THREE.Vector3(1, 1, 1);
const EDGE_VERTICES = new Float32Array([
    // Bottom
    -0.5, -0.5, -0.5,  0.5, -0.5, -0.5,
     0.5, -0.5, -0.5,  0.5, -0.5,  0.5,
     0.5, -0.5,  0.5, -0.5, -0.5,  0.5,
    -0.5, -0.5,  0.5, -0.5, -0.5, -0.5,
    // Top
    -0.5,  0.5, -0.5,  0.5,  0.5, -0.5,
     0.5,  0.5, -0.5,  0.5,  0.5,  0.5,
     0.5,  0.5,  0.5, -0.5,  0.5,  0.5,
    -0.5,  0.5,  0.5, -0.5,  0.5, -0.5,
    // Verticals
    -0.5, -0.5, -0.5, -0.5,  0.5, -0.5,
     0.5, -0.5, -0.5,  0.5,  0.5, -0.5,
     0.5, -0.5,  0.5,  0.5,  0.5,  0.5,
    -0.5, -0.5,  0.5, -0.5,  0.5,  0.5,
]);

// ─── 타입 정의 ────────────────────────────────────────────────────────────────

/**
 * TSL 인스턴싱을 위한 청크 단위 구조체.
 *
 * mat4를 4개의 vec4 열(column)로 분리해 InstancedBufferAttribute에 저장한다.
 * Three.js Matrix4.elements는 컬럼 메이저:
 *   col0 = e[0..3], col1 = e[4..7], col2 = e[8..11], col3 = e[12..15]
 */
interface OverlayChunk {
    lines: THREE.LineSegments<THREE.InstancedBufferGeometry, THREE.LineBasicNodeMaterial>;
    col0: THREE.InstancedBufferAttribute;
    col1: THREE.InstancedBufferAttribute;
    col2: THREE.InstancedBufferAttribute;
    col3: THREE.InstancedBufferAttribute;
    colColor: THREE.InstancedBufferAttribute; // vec3 RGB, 인스턴스별 색상
    count: number;
}

// ─── OverlayManager ──────────────────────────────────────────────────────────

/**
 * TSL positionNode 오버라이드 방식으로 인스턴싱된 엣지 외곽선을 렌더링하는 클래스.
 *
 * 작동 원리:
 *  - LineSegments의 modelMatrix를 identity로 고정.
 *  - 인스턴스 트랜스폼(mat4)을 4개의 vec4 InstancedBufferAttribute로 저장.
 *  - TSL positionNode: instanceMat * positionLocal → 카메라 MVP 파이프라인 진입.
 *    최종 변환: projectionMatrix × viewMatrix × instanceMat × localPos
 */
export class OverlayManager {
    private scene: THREE.Scene;
    private chunks: OverlayChunk[] = [];
    private readonly INSTANCES_PER_CHUNK = 4096;

    // 이벤트 리스너 참조 보관 (dispose 시 제거용)
    private readonly _onSelectionChanged = () => this.updateFromSelection();

    // 가비지 컬렉션 방지용 재사용 객체
    private readonly _WORLD_MAT  = new THREE.Matrix4();
    private readonly _BOX_MAT    = new THREE.Matrix4();
    private readonly _FINAL_MAT  = new THREE.Matrix4();
    private readonly _SIZE   = new THREE.Vector3();
    private readonly _CENTER = new THREE.Vector3();
    private readonly _BOX    = new THREE.Box3();

    constructor(scene: THREE.Scene) {
        this.scene = scene;
        window.addEventListener('pde:selection-changed', this._onSelectionChanged);
    }

    // ─── 청크 생성 ────────────────────────────────────────────────────────────

    private createChunk(): OverlayChunk {
        const N = this.INSTANCES_PER_CHUNK;

        // 기본 BufferGeometry (유닛 큐브 엣지) → InstancedBufferGeometry 래핑
        const baseGeo = new THREE.BufferGeometry();
        baseGeo.setAttribute('position', new THREE.BufferAttribute(EDGE_VERTICES.slice(), 3));

        const geo = new THREE.InstancedBufferGeometry();
        geo.attributes['position'] = baseGeo.attributes['position'];
        geo.instanceCount = 0;

        // InstancedBufferGeometry에 attribute를 복사한 뒤 원본 baseGeo는 즉시 해제
        baseGeo.dispose();

        // mat4 컬럼 분리 저장
        const col0 = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
        const col1 = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
        const col2 = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
        const col3 = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
        col0.setUsage(THREE.DynamicDrawUsage);
        col1.setUsage(THREE.DynamicDrawUsage);
        col2.setUsage(THREE.DynamicDrawUsage);
        col3.setUsage(THREE.DynamicDrawUsage);

        // 인스턴스별 색상 어트리뷰트 (RGB float32)
        const colColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
        colColor.setUsage(THREE.DynamicDrawUsage);

        geo.setAttribute('instanceMatrix0', col0);
        geo.setAttribute('instanceMatrix1', col1);
        geo.setAttribute('instanceMatrix2', col2);
        geo.setAttribute('instanceMatrix3', col3);
        geo.setAttribute('instanceColor',   colColor);

        // TSL: positionNode = instanceMat * positionLocal
        const instanceMat = mat4(
            attribute('instanceMatrix0'),
            attribute('instanceMatrix1'),
            attribute('instanceMatrix2'),
            attribute('instanceMatrix3'),
        );
        const transformedPosition = instanceMat.mul(positionLocal.toVec4(1.0)).xyz;

        // TSL: colorNode = instanceColor (vec3)
        const instanceColorNode = vec3(attribute('instanceColor'));

        const material = new THREE.LineBasicNodeMaterial({
            depthTest: true,
            transparent: true,
            opacity: 0.8,
        });
        // positionNode 오버라이드: modelMatrix(=I) 이후 MVP 체인에 진입하기 전 적용
        (material as any).positionNode = transformedPosition;
        // colorNode 오버라이드: 인스턴스별 색상
        (material as any).colorNode = instanceColorNode;

        const lines = new THREE.LineSegments(geo, material);
        lines.frustumCulled = false;
        lines.matrixAutoUpdate = false;
        lines.matrix.identity(); // modelMatrix = I

        this.scene.add(lines);
        return { lines, col0, col1, col2, col3, colColor, count: 0 };
    }

    // ─── 인스턴스 행렬 쓰기 ──────────────────────────────────────────────────

    private setChunkMatrix(chunk: OverlayChunk, index: number, mat: THREE.Matrix4): void {
        const e = mat.elements; // 컬럼 메이저
        chunk.col0.setXYZW(index, e[0],  e[1],  e[2],  e[3]);
        chunk.col1.setXYZW(index, e[4],  e[5],  e[6],  e[7]);
        chunk.col2.setXYZW(index, e[8],  e[9],  e[10], e[11]);
        chunk.col3.setXYZW(index, e[12], e[13], e[14], e[15]);
    }

    private setChunkColor(chunk: OverlayChunk, index: number, color: THREE.Color): void {
        chunk.colColor.setXYZ(index, color.r, color.g, color.b);
    }

    // ─── 공개 API ─────────────────────────────────────────────────────────────

    public updateFromSelection(): void {
        this.update(getSelectedItems());
    }

    /**
     * 드래그 중 저비용 경로: mesh/bbox 재탐색 없이 버퍼에 저장된
     * overlay 행렬에 delta 를 직접 곱해 GPU 업로드만 수행한다.
     * - getMatrixAt × 0, bbox 재계산 × 0, colColor needsUpdate × 0
     */
    public applyDelta(delta: THREE.Matrix4): void {
        const de = delta.elements; // column-major
        for (const chunk of this.chunks) {
            if (!chunk.lines.visible || chunk.count === 0) continue;

            const a0 = chunk.col0.array as Float32Array;
            const a1 = chunk.col1.array as Float32Array;
            const a2 = chunk.col2.array as Float32Array;
            const a3 = chunk.col3.array as Float32Array;

            for (let i = 0; i < chunk.count; i++) {
                const b = i * 4; // itemSize = 4

                // 현재 버퍼에서 column-major 행렬 복원
                const e0=a0[b],   e1=a0[b+1], e2=a0[b+2],  e3=a0[b+3];
                const e4=a1[b],   e5=a1[b+1], e6=a1[b+2],  e7=a1[b+3];
                const e8=a2[b],   e9=a2[b+1], e10=a2[b+2], e11=a2[b+3];
                const e12=a3[b],  e13=a3[b+1],e14=a3[b+2], e15=a3[b+3];

                // result = delta * current  (premultiply)
                a0[b]   = de[0]*e0 + de[4]*e1 + de[8]*e2  + de[12]*e3;
                a0[b+1] = de[1]*e0 + de[5]*e1 + de[9]*e2  + de[13]*e3;
                a0[b+2] = de[2]*e0 + de[6]*e1 + de[10]*e2 + de[14]*e3;
                a0[b+3] = de[3]*e0 + de[7]*e1 + de[11]*e2 + de[15]*e3;

                a1[b]   = de[0]*e4 + de[4]*e5 + de[8]*e6  + de[12]*e7;
                a1[b+1] = de[1]*e4 + de[5]*e5 + de[9]*e6  + de[13]*e7;
                a1[b+2] = de[2]*e4 + de[6]*e5 + de[10]*e6 + de[14]*e7;
                a1[b+3] = de[3]*e4 + de[7]*e5 + de[11]*e6 + de[15]*e7;

                a2[b]   = de[0]*e8  + de[4]*e9  + de[8]*e10  + de[12]*e11;
                a2[b+1] = de[1]*e8  + de[5]*e9  + de[9]*e10  + de[13]*e11;
                a2[b+2] = de[2]*e8  + de[6]*e9  + de[10]*e10 + de[14]*e11;
                a2[b+3] = de[3]*e8  + de[7]*e9  + de[11]*e10 + de[15]*e11;

                a3[b]   = de[0]*e12 + de[4]*e13 + de[8]*e14  + de[12]*e15;
                a3[b+1] = de[1]*e12 + de[5]*e13 + de[9]*e14  + de[13]*e15;
                a3[b+2] = de[2]*e12 + de[6]*e13 + de[10]*e14 + de[14]*e15;
                a3[b+3] = de[3]*e12 + de[7]*e13 + de[11]*e14 + de[15]*e15;
            }

            // 색상은 바뀌지 않으므로 colColor.needsUpdate 생략
            chunk.col0.needsUpdate = true;
            chunk.col1.needsUpdate = true;
            chunk.col2.needsUpdate = true;
            chunk.col3.needsUpdate = true;
        }
    }

    public update(items: SelectedItem[]): void {
        const totalCount = items.length;
        const requiredChunks = totalCount === 0 ? 0 : Math.ceil(totalCount / this.INSTANCES_PER_CHUNK);

        while (this.chunks.length < requiredChunks) {
            this.chunks.push(this.createChunk());
        }

        for (let c = 0; c < this.chunks.length; c++) {
            const chunk = this.chunks[c];

            if (c >= requiredChunks) {
                chunk.lines.visible = false;
                chunk.lines.geometry.instanceCount = 0;
                chunk.count = 0;
                continue;
            }

            chunk.lines.visible = true;
            const startIdx = c * this.INSTANCES_PER_CHUNK;
            const endIdx   = Math.min(startIdx + this.INSTANCES_PER_CHUNK, totalCount);
            const chunkCount = endIdx - startIdx;
            chunk.count = chunkCount;

            for (let i = 0; i < chunkCount; i++) {
                const item = items[startIdx + i];
                const mesh = item.mesh;

                // 월드 행렬 취득
                if ((mesh as any).isInstancedMesh) {
                    (mesh as THREE.InstancedMesh).getMatrixAt(item.instanceId, this._WORLD_MAT);
                    this._WORLD_MAT.premultiply(mesh.matrixWorld);
                } else if ((mesh as any).isBatchedMesh) {
                    (mesh as any).getMatrixAt(item.instanceId, this._WORLD_MAT);
                    this._WORLD_MAT.premultiply(mesh.matrixWorld);
                } else {
                    this._WORLD_MAT.copy(mesh.matrixWorld);
                }

                // 바운딩 박스 취득
                let boxFound = false;

                if ((mesh as any).isBatchedMesh) {
                    const geomId: number | undefined = (mesh as any).userData?.instanceGeometryIds?.[item.instanceId];
                    const box: THREE.Box3 | undefined = geomId !== undefined
                        ? (mesh as any).userData?.geometryBounds?.get?.(geomId)
                        : undefined;
                    if (box) { this._BOX.copy(box); boxFound = true; }
                }

                if (!boxFound) {
                    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
                    if (mesh.geometry.boundingBox) { this._BOX.copy(mesh.geometry.boundingBox); boxFound = true; }
                }

                // player_head 레이어 크기 보정:
                //   hasHat[instanceId] === false → 1레이어(base): 1×1×1 고정
                //   hasHat[instanceId] === true  → 2레이어(hat):  지오메트리 bbox 그대로 사용
                if (boxFound) {
                    const anyMesh = mesh as any;
                    const hasHatMap = anyMesh.userData?.hasHat;
                    if (hasHatMap && hasHatMap[item.instanceId] === false) {
                        this._BOX.getCenter(this._CENTER);
                        this._BOX.setFromCenterAndSize(this._CENTER, _UNIT3);
                    }
                }

                if (!boxFound) {
                    this._FINAL_MAT.makeScale(0, 0, 0);
                } else {
                    this._BOX.getSize(this._SIZE);
                    this._BOX.getCenter(this._CENTER);
                    this._BOX_MAT.makeTranslation(this._CENTER.x, this._CENTER.y, this._CENTER.z);
                    this._BOX_MAT.scale(this._SIZE);
                    this._FINAL_MAT.multiplyMatrices(this._WORLD_MAT, this._BOX_MAT);
                }

                this.setChunkMatrix(chunk, i, this._FINAL_MAT);
                this.setChunkColor(chunk, i, getOverlayColor(mesh, item.instanceId));
            }

            chunk.lines.geometry.instanceCount = chunkCount;
            chunk.col0.needsUpdate = true;
            chunk.col1.needsUpdate = true;
            chunk.col2.needsUpdate = true;
            chunk.col3.needsUpdate = true;
            chunk.colColor.needsUpdate = true;
        }
    }

    public dispose(): void {
        // window 이벤트 리스너 해제 (메모리 누수 방지)
        window.removeEventListener('pde:selection-changed', this._onSelectionChanged);
        for (const chunk of this.chunks) {
            this.scene.remove(chunk.lines);
            chunk.lines.geometry.dispose();
            (chunk.lines.material as THREE.Material).dispose();
        }
        this.chunks = [];
    }
}

// ─── MultiAABBOverlay ─────────────────────────────────────────────────────────

/**
 * 다중 선택 시 전체 선택 범위를 감싸는 하나의 월드-스페이스 AABB 와이어프레임을 렌더링한다.
 *
 * 작동 원리:
 *  - items.length >= 2 일 때만 표시.
 *  - 각 인스턴스의 로컬 바운딩박스 → worldMat 으로 Box3.applyMatrix4() → 유니온 누적.
 *  - 유니온 AABB의 center + size 를 LineSegments 의 position / scale 에 적용.
 *  - depthTest: false 로 항상 전면에 표시.
 */
export class MultiAABBOverlay {
    private scene: THREE.Scene;
    private lines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicNodeMaterial>;

    // 가비지 컬렉션 방지용 재사용 객체
    private readonly _unionBox   = new THREE.Box3();
    private readonly _refBox     = new THREE.Box3(); // 드래그 시작 시 스냅샷 (불변)
    private readonly _scratchBox = new THREE.Box3(); // applyDelta 계산용 임시 박스
    private readonly _totalDelta = new THREE.Matrix4(); // 드래그 시작 이후 누적 변환
    private readonly _itemBox    = new THREE.Box3();
    private readonly _worldMat   = new THREE.Matrix4();
    private readonly _center     = new THREE.Vector3();
    private readonly _size       = new THREE.Vector3();

    /** 다중 선택 AABB 색상 (흰색) */
    private static readonly COLOR = new THREE.Color(0xffffff);

    constructor(scene: THREE.Scene) {
        this.scene = scene;

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(EDGE_VERTICES.slice(), 3));

        const mat = new THREE.LineBasicNodeMaterial({
            color:       MultiAABBOverlay.COLOR,
            depthTest:   true,
            transparent: true,
            opacity:     0.5,
        });

        this.lines = new THREE.LineSegments(geo, mat);
        this.lines.frustumCulled  = false;
        this.lines.visible        = false;
        this.lines.renderOrder    = 999; // 항상 최상단
        this.scene.add(this.lines);
    }

    // ─── 공개 API ─────────────────────────────────────────────────────────────

    public updateFromSelection(): void {
        this.update(getSelectedItems());
    }

    public update(items: SelectedItem[]): void {
        if (items.length < 2) {
            this.lines.visible = false;
            return;
        }

        this._unionBox.makeEmpty();

        for (const { mesh, instanceId } of items) {
            // 1. 월드 행렬 취득
            if ((mesh as any).isInstancedMesh) {
                (mesh as THREE.InstancedMesh).getMatrixAt(instanceId, this._worldMat);
                this._worldMat.premultiply(mesh.matrixWorld);
            } else if ((mesh as any).isBatchedMesh) {
                (mesh as any).getMatrixAt(instanceId, this._worldMat);
                this._worldMat.premultiply(mesh.matrixWorld);
            } else {
                this._worldMat.copy(mesh.matrixWorld);
            }

            // 2. 지오메트리 바운딩 박스 취득
            let boxFound = false;

            if ((mesh as any).isBatchedMesh) {
                const geomId: number | undefined = (mesh as any).userData?.instanceGeometryIds?.[instanceId];
                const box: THREE.Box3 | undefined = geomId !== undefined
                    ? (mesh as any).userData?.geometryBounds?.get?.(geomId)
                    : undefined;
                if (box) { this._itemBox.copy(box); boxFound = true; }
            }

            if (!boxFound) {
                const geo = (mesh as any).geometry;
                if (geo) {
                    if (!geo.boundingBox) geo.computeBoundingBox();
                    if (geo.boundingBox) { this._itemBox.copy(geo.boundingBox); boxFound = true; }
                }
            }

            if (!boxFound) continue;

            // 3. player_head 1-레이어 크기 보정 (OverlayManager 와 동일 로직)
            const hasHatMap = (mesh as any).userData?.hasHat;
            if (hasHatMap && hasHatMap[instanceId] === false) {
                this._itemBox.getCenter(this._center);
                this._itemBox.setFromCenterAndSize(this._center, _UNIT3);
            }

            // 4. OBB → 월드 스페이스 AABB 로 변환 후 유니온 누적
            //    applyMatrix4 는 8개 코너를 world 공간으로 투영한 최소 AABB 를 반환
            this._itemBox.applyMatrix4(this._worldMat);
            this._unionBox.union(this._itemBox);
        }

        if (this._unionBox.isEmpty()) {
            this.lines.visible = false;
            return;
        }

        this._unionBox.getCenter(this._center);
        this._unionBox.getSize(this._size);

        this.lines.position.copy(this._center);
        this.lines.scale.copy(this._size);
        // 드래그 시작점 기준 스냅샷 저장 및 누적 행렬 초기화
        this._refBox.copy(this._unionBox);
        this._totalDelta.identity();
        this.lines.visible = true;
    }

    /**
     * 드래그 중 저비용 경로.
     *
     * 핵심 원리: AABB에 회전 delta를 반복 적용하면
     *   AABB → applyMatrix4 → 더 큰 AABB → 또 applyMatrix4 → ...
     * 로 누적 팽창이 발생한다.
     *
     * 해결: _totalDelta 에 delta를 누산하고,
     * 매 프레임 항상 초기 스냅샷(_refBox)에 _totalDelta를 한 번만 적용해
     * 팽창 없이 현재 AABB를 재계산한다.
     */
    public applyDelta(delta: THREE.Matrix4): void {
        if (!this.lines.visible) return;
        this._totalDelta.premultiply(delta);
        this._scratchBox.copy(this._refBox).applyMatrix4(this._totalDelta);
        this._scratchBox.getCenter(this._center);
        this._scratchBox.getSize(this._size);
        this.lines.position.copy(this._center);
        this.lines.scale.copy(this._size);
    }

    public dispose(): void {
        this.scene.remove(this.lines);
        this.lines.geometry.dispose();
        this.lines.material.dispose();
    }
}
