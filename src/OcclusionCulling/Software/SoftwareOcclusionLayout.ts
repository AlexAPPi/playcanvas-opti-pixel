import {
    SO_AABB_STRIDE,
    SO_CONTROL_I32_COUNT
} from "./SoftwareOcclusionConstants.js";

export interface ISoftwareOcclusionOffsets {
    control: number;
    vp: number;
    occluderTypes: number;
    occluderMatrices: number;
    occluderMeshRanges: number;
    meshVertices: number;
    meshIndices: number;
    queueIds: number;
    aabbCenters: number;
    aabbHalfExtents: number;
    flags0: number;
    flags1: number;
    byteLength: number;
}

export interface ISoftwareOcclusionShared {
    sab: SharedArrayBuffer;
    offsets: ISoftwareOcclusionOffsets;
    control: Int32Array;
    vp: Float32Array;
    occluderTypes: Uint32Array;
    occluderMatrices: Float32Array;
    occluderMeshRanges: Uint32Array;
    meshVertices: Float32Array;
    meshIndices: Uint32Array;
    queueIds: Uint32Array;
    aabbCenters: Float32Array;
    aabbHalfExtents: Float32Array;
    flags0: Uint32Array;
    flags1: Uint32Array;
}

export interface ISoftwareOcclusionSharedSizes {
    aabbCapacity: number;
    occluderTypesLength: number;
    occluderMatricesLength: number;
    occluderMeshRangesLength: number;
    meshVerticesLength: number;
    meshIndicesLength: number;
}

function align4(value: number): number {
    return (value + 3) & ~3;
}

export function computeSoftwareOcclusionOffsets(
    sizes: ISoftwareOcclusionSharedSizes
): ISoftwareOcclusionOffsets {

    const {
        aabbCapacity,
        occluderTypesLength,
        occluderMatricesLength,
        occluderMeshRangesLength,
        meshVerticesLength,
        meshIndicesLength
    } = sizes;

    let offset = 0;

    const control = offset;
    offset += SO_CONTROL_I32_COUNT * 4;

    const vp = offset;
    offset += 16 * 4;

    const occluderTypes = offset;
    offset = align4(offset + occluderTypesLength * 4);

    const occluderMatrices = offset;
    offset = align4(offset + occluderMatricesLength * 4);

    const occluderMeshRanges = offset;
    offset = align4(offset + occluderMeshRangesLength * 4);

    const meshVertices = offset;
    offset = align4(offset + meshVerticesLength * 4);

    const meshIndices = offset;
    offset = align4(offset + meshIndicesLength * 4);

    const queueIds = offset;
    offset = align4(offset + aabbCapacity * 4);

    const aabbCenters = offset;
    offset = align4(offset + aabbCapacity * SO_AABB_STRIDE * 4);

    const aabbHalfExtents = offset;
    offset = align4(offset + aabbCapacity * SO_AABB_STRIDE * 4);

    const flags0 = offset;
    offset = align4(offset + aabbCapacity * 4);

    const flags1 = offset;
    offset = align4(offset + aabbCapacity * 4);

    return {
        control,
        vp,
        occluderTypes,
        occluderMatrices,
        occluderMeshRanges,
        meshVertices,
        meshIndices,
        queueIds,
        aabbCenters,
        aabbHalfExtents,
        flags0,
        flags1,
        byteLength: offset
    };
}

export function createSoftwareOcclusionShared(
    sizes: ISoftwareOcclusionSharedSizes
): ISoftwareOcclusionShared {

    const offsets = computeSoftwareOcclusionOffsets(sizes);
    const sab = new SharedArrayBuffer(offsets.byteLength);

    return {
        sab,
        offsets,
        control: new Int32Array(sab, offsets.control, SO_CONTROL_I32_COUNT),
        vp: new Float32Array(sab, offsets.vp, 16),
        occluderTypes: new Uint32Array(sab, offsets.occluderTypes, sizes.occluderTypesLength),
        occluderMatrices: new Float32Array(sab, offsets.occluderMatrices, sizes.occluderMatricesLength),
        occluderMeshRanges: new Uint32Array(sab, offsets.occluderMeshRanges, sizes.occluderMeshRangesLength),
        meshVertices: new Float32Array(sab, offsets.meshVertices, sizes.meshVerticesLength),
        meshIndices: new Uint32Array(sab, offsets.meshIndices, sizes.meshIndicesLength),
        queueIds: new Uint32Array(sab, offsets.queueIds, sizes.aabbCapacity),
        aabbCenters: new Float32Array(sab, offsets.aabbCenters, sizes.aabbCapacity * SO_AABB_STRIDE),
        aabbHalfExtents: new Float32Array(sab, offsets.aabbHalfExtents, sizes.aabbCapacity * SO_AABB_STRIDE),
        flags0: new Uint32Array(sab, offsets.flags0, sizes.aabbCapacity),
        flags1: new Uint32Array(sab, offsets.flags1, sizes.aabbCapacity)
    };
}

export function canUseSharedArrayBuffer(): boolean {
    try {
        return typeof SharedArrayBuffer !== "undefined" && new SharedArrayBuffer(4).byteLength === 4;
    }
    catch {
        return false;
    }
}
