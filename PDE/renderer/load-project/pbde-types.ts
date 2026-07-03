import type * as THREE from 'three/webgpu';

export type AssetPayload = string | Uint8Array | ArrayBuffer | unknown;

export type TypedArrayConstructor = {
    new (length: number): {
        set(array: ArrayLike<number>, offset?: number): void;
        length: number;
        [index: number]: number;
    };
};

export interface HeadGeometrySet {
    base: THREE.BufferGeometry;
    layer: THREE.BufferGeometry;
    merged: THREE.BufferGeometry | null;
}

export interface GeometryMeta {
    itemId: number;
    transform: Float32Array | number[];
    modelMatrix: number[];
    geometryId: string;
    geometryBufferKey?: string;
    geometryIndex: number;
    texPath: string;
    tintHex?: number;
    uvTransform?: [number, number, number, number];
    isItemDisplayModel: boolean;
    posByteOffset: number;
    posLen: number;
    normByteOffset: number;
    normLen: number;
    uvByteOffset: number;
    uvLen: number;
    indicesByteOffset: number;
    indicesLen: number;
    uuid: string;
    groupId: string | null;
    name?: string | null;
    blockProps?: unknown;
    itemDisplayType?: string;
}

export interface GeometryInstanceMeta {
    transform: Float32Array | number[];
    uuid: string;
    groupId: string | null;
    name?: string | null;
    atlasUvTransform?: [number, number, number, number];
    blockProps?: unknown;
    isItemDisplayModel?: boolean;
    itemDisplayType?: string | null;
}

export interface GeometryInstanceBatch {
    parts: GeometryMeta[];
    instances: GeometryInstanceMeta[];
}

export interface OtherItem {
    type: string;
    uuid: string;
    groupId: string | null;
    textureUrl?: string;
    transform: number[];
    displayType?: string;
    name?: string;
    [key: string]: unknown;
}

export interface GroupChild {
    type: 'group' | 'object';
    id?: string;
    mesh?: THREE.Object3D;
    instanceId?: number;
}

export interface GroupData {
    id: string;
    isCollection?: boolean;
    children: GroupChild[];
    parent: string | null;
    name: string;
    position: { x: number; y: number; z: number } | THREE.Vector3;
    quaternion: { x: number; y: number; z: number; w: number } | THREE.Quaternion;
    scale: { x: number; y: number; z: number } | THREE.Vector3;
    pivot?: [number, number, number] | number[];
}

export interface WorkerMetadata {
    geometries: GeometryMeta[];
    geometryBatches?: GeometryInstanceBatch[];
    otherItems: OtherItem[];
    useUint32Indices?: boolean;
    atlas?: { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> };
    groups?: Map<string, GroupData>;
    sceneOrder?: { type: 'group' | 'object'; id: string }[];
}
