import pc from "../engine.js";

export type TUnicalId = number;

export const FRUSTUM_UNKNOWN    = -1;
export const FRUSTUM_OUTSIDE    = 0;
export const FRUSTUM_INTERSECTS = 1;
export const FRUSTUM_CONTAINED  = 2;

export const OCCLUSION_UNKNOWN  = -1;
export const OCCLUSION_VISIBLE  = 1;
export const OCCLUSION_OCCLUDED = 0;

export type TOcclusionResult = typeof OCCLUSION_UNKNOWN | typeof OCCLUSION_VISIBLE | typeof OCCLUSION_OCCLUDED;
export type TFrustumResult = typeof FRUSTUM_UNKNOWN | typeof FRUSTUM_OUTSIDE | typeof FRUSTUM_INTERSECTS | typeof FRUSTUM_CONTAINED;

export function isGPUOcclusionCulling<TProvider = unknown>(x: IOcclusionCullingTester | IGPUOcclusionCullingTester<TProvider> | null | undefined): x is IGPUOcclusionCullingTester<TProvider> {
    return !!x && x.supportGCPUReadback !== undefined;
}

export function isGPU2CPUReadbackOcclusionCulling(x: IOcclusionCullingTester | null | undefined): x is IGPU2CPUReadbackOcclusionCullingTester {
    return isGPUOcclusionCulling(x) && x.supportGCPUReadback;
}

/**
 * Interface for working with an occlusion culling testing system.
 * Allows registering BoundingBox objects, enqueueing them for testing,
 * and checking if the object is occluded by other scene geometry.
 */
export interface IOcclusionCullingTester {

    readonly supportGCPUReadback: boolean;

    /**
     * Registers a BoundingBox for subsequent occlusion testing.
     * @param boundingBox - The bounds of the object in local or world coordinates.
     * @param matrix - Optional transformation matrix (if a local BoundingBox is used).
     * @returns A unique identifier for the registered object.
     */
    lock(boundingBox: pc.BoundingBox, matrix?: pc.Mat4): TUnicalId;

    /**
     * Releases a previously registered identifier and removes associated data.
     * @param id - The unique identifier obtained from the lock() call.
     */
    unlock(id: TUnicalId): void;

    /**
     * Adds the object to the queue for occlusion testing.
     * @param id - The unique identifier returned earlier by the lock() method.
     * @param extra - The extra data
     * @returns A queue index.
     */
    enqueue(id: TUnicalId, extra?: number | number[]): void;
}

export interface IGPUOcclusionCullingTester<TProvider> extends IOcclusionCullingTester {

    readonly supportGCPUReadback: false;
    
    execute(camera: pc.Camera, provider: TProvider): void;
}

export interface IGPU2CPUReadbackOcclusionCullingTester extends IOcclusionCullingTester {

    readonly supportGCPUReadback: true;

    /**
     * Return the result of the last occlusion test for the specified object.
     * @param id - The unique identifier of the object.
     * @returns true if the object is occluded, otherwise false.
     */
    getOcclusionStatus(id: TUnicalId): TOcclusionResult;

    execute(camera: pc.Camera): void;
}