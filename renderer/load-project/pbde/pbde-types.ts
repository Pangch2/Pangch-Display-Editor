import type { BufferGeometry, Object3D, Quaternion, Vector3 } from 'three/webgpu';

export type AssetPayload = string | Uint8Array | ArrayBuffer | unknown;

export type TypedArrayConstructor = {
    new (length: number): {
        set(array: ArrayLike<number>, offset?: number): void;
        length: number;
        [index: number]: number;
    };
};

export interface HeadGeometrySet {
    base: BufferGeometry;
    layer: BufferGeometry;
    merged: BufferGeometry | null;
}

export interface GeometryMeta {
    itemId: number;
    transform: Float32Array | number[];
    modelMatrix: number[];
    geometryId: string;
    geometryBufferKey?: string;
    geometryIndex: number;
    texPath: string;
    atlasKey?: string;
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
    nbt?: string;
}

export interface GeometryInstanceMeta {
    transform: Float32Array | number[];
    modelTransform?: number[];
    partTints?: number[];
    uuid: string;
    groupId: string | null;
    name?: string | null;
    atlasUvTransform?: [number, number, number, number];
    atlasUvTransforms?: [number, number, number, number][];
    blockProps?: unknown;
    isItemDisplayModel?: boolean;
    itemDisplayType?: string | null;
    nbt?: string;
    brightness?: { sky?: number; block?: number };
}

export interface GeometryInstanceBatch {
    shapeKey?: string;
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
    mesh?: Object3D;
    instanceId?: number;
}

export interface GroupData {
    id: string;
    isCollection?: boolean;
    children: GroupChild[];
    parent: string | null;
    name: string;
    position: { x: number; y: number; z: number } | Vector3;
    quaternion: { x: number; y: number; z: number; w: number } | Quaternion;
    scale: { x: number; y: number; z: number } | Vector3;
    pivot?: [number, number, number] | number[] | Vector3;
    isCustomPivot?: boolean;
    nbt?: string;
}

export interface ProjectDetails {
    name: string;
    mainNBT: string;
    nbt: string;
    parentEntity: string;
    summonPosition: string;
    /** Animation export name; empty follows `name`. */
    datapackName?: string;
    /** Animation export dialog options (see StoredOptions in animation-export dialog). */
    animationExport?: Record<string, string | boolean>;
}

export interface WorkerMetadata {
    editorState?: import('../../save/pde-format').PdeEditorState;
    geometries: GeometryMeta[];
    geometryBatches?: GeometryInstanceBatch[];
    otherItems: OtherItem[];
    useUint32Indices?: boolean;
    atlas?: { key: string; width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> };
    groups?: Map<string, GroupData>;
    sceneOrder?: { type: 'group' | 'object'; id: string }[];
    projectDetails: ProjectDetails;
}
