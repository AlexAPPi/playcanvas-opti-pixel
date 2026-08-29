/**
 * Shared main <-> worker message shapes for software occlusion.
 * The blob worker cannot import values from this file at runtime
 * (`softwareOcclusionWorkerMain` is stringified); use `import type` only
 * and keep worker payloads structurally compatible.
 */

export interface ISoftwareOcclusionJobStats {
    clearUs: number;
    rasterUs: number;
    hizUs: number;
    aabbUs: number;
    totalUs: number;
    occluders: number;
    aabbs: number;
    occluded: number;
    visible: number;
}

export interface ISoftwareOcclusionReadyMessage {
    t: "ready";
}

export interface ISoftwareOcclusionResultMessage extends ISoftwareOcclusionJobStats {
    t: "result";
    flags: Uint32Array<ArrayBufferLike>;
    debugLines?: Float32Array;
    debugLineCount?: number;
}

export interface ISoftwareOcclusionResize {
    occluderCapacity: number;
    meshSlots: number;
    aabbCapacity?: number;
}

export interface ISoftwareOcclusionAabbFull {
    centers: Float32Array;
    halfExtents: Float32Array;
}

export interface ISoftwareOcclusionAabbUpserts {
    ids: Uint32Array;
    centers: Float32Array;
    halfExtents: Float32Array;
}

/**
 * AABB mirror fields written onto a frame message by SoftwareOcclusionTester.
 */
export interface ISoftwareOcclusionAabbSyncPatch {
    resize?: ISoftwareOcclusionResize;
    aabbFull?: ISoftwareOcclusionAabbFull;
    aabbUpserts?: ISoftwareOcclusionAabbUpserts;
}

export interface ISoftwareOcclusionMeshUpsert {
    id: number;
    vertices: Float32Array;
    indices: Uint32Array;
}

export interface ISoftwareOcclusionOccluderUpserts {
    ids: Uint32Array;
    types: Uint32Array;
    matrices: Float32Array;
    meshIds: Int32Array;
}

/** Dirty occluder/mesh/AABB patches applied before a job. */
export interface ISoftwareOcclusionFramePatches extends ISoftwareOcclusionAabbSyncPatch {
    meshUpserts?: ISoftwareOcclusionMeshUpsert[];
    meshRemoves?: number[];
    occluderUpserts?: ISoftwareOcclusionOccluderUpserts;
    occluderRemoves?: number[];
}

export interface ISoftwareOcclusionInitMessage {
    t: "init";
    width: number;
    height: number;
    occluderCapacity: number;
    meshSlots: number;
    aabbCapacity: number;
}

export interface ISoftwareOcclusionFrameMessage extends ISoftwareOcclusionFramePatches {
    t: "frame";
    vp: Float32Array;
    queueIds: Uint32Array;
    queueCount: number;
    flags?: Uint32Array<ArrayBufferLike>;
    debugOccluders?: boolean;
}

export type TSoftwareOcclusionWorkerInboundMessage =
    | ISoftwareOcclusionInitMessage
    | ISoftwareOcclusionFrameMessage;

export type TSoftwareOcclusionMessage =
    | ISoftwareOcclusionReadyMessage
    | ISoftwareOcclusionResultMessage;
