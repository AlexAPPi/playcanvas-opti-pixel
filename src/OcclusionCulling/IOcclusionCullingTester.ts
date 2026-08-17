import pc from "../engine.js";
import type { OccluderStore } from "./Software/OccluderStore.js";

export type TUnicalId = number;
export type TUnicalQueueIndex = number;

export const SOME_ENQUEUE_PROBLEM = -1;

export const FRUSTUM_UNKNOWN    = -1;
export const FRUSTUM_OUTSIDE    = 0;
export const FRUSTUM_INTERSECTS = 1;
export const FRUSTUM_CONTAINED  = 2;

export const OCCLUSION_UNKNOWN  = -1;
export const OCCLUSION_VISIBLE  = 1;
export const OCCLUSION_OCCLUDED = 0;

export type TOcclusionResult = typeof OCCLUSION_UNKNOWN | typeof OCCLUSION_VISIBLE | typeof OCCLUSION_OCCLUDED;
export type TFrustumResult = typeof FRUSTUM_UNKNOWN | typeof FRUSTUM_OUTSIDE | typeof FRUSTUM_INTERSECTS | typeof FRUSTUM_CONTAINED;

export function isGPUOcclusionCullingTester(x: unknown): x is IOcclusionCullingTester {
    return !!x && (
        (x as any)._ocTesterType === "gpu2cpu_readback_oct"  ||
        (x as any)._ocTesterType === "gpu_indirect_draw_oct"
    );
}

export function isGPU2CPUReadbackOcclusionCullingTester(x: unknown): x is IGPU2CPUReadbackOcclusionCullingTester {
    return (x as any)?._ocTesterType === "gpu2cpu_readback_oct";
}

export function isGPUIndirectDrawOcclusionCullingTester(x: unknown): x is IGPUIndirectDrawOcclusionCullingTester {
    return (x as any)?._ocTesterType === "gpu_indirect_draw_oct";
}

export function isCPUSoftwareOcclusionCullingTester(x: unknown): x is ICPUSoftwareOcclusionCullingTester {
    return (x as any)?._ocTesterType === "cpu_software_oct";
}

/**
 * Interface for working with an occlusion culling testing system.
 * Allows registering BoundingBox objects, enqueueing them for testing,
 * and checking if the object is occluded by other scene geometry.
 */
export interface IOcclusionCullingTester {

    readonly _ocTesterType: string;

    /**
     * Registers a BoundingBox for subsequent occlusion testing.
     * @param boundingBox - The bounds of the object in local or world coordinates.
     * @param matrix - Optional transformation matrix (if a local BoundingBox is used).
     * @param extra1 - Optional extra data 1.
     * @param extra2 - Optional extra data 2.
     * @returns A unique identifier for the registered object.
     */
    lock(boundingBox: pc.BoundingBox, matrix?: pc.Mat4, extra1?: number, extra2?: number): TUnicalId;

    /**
     * Registers a BoundingBox for subsequent occlusion testing.
     * @param data - The array containing the bounding box data (min and max points) in local or world coordinates [minX, maxX, minY, maxY, minZ, maxZ].
     * @param offset - The offset in the array where the bounding box data starts.
     * @param matrix - Optional transformation matrix (if a local BoundingBox is used).
     * @param extra1 - Optional extra data 1.
     * @param extra2 - Optional extra data 2.
     * @returns A unique identifier for the registered object.
     */
    lockMinMaxScalars(data: ArrayLike<number>, offset: number, matrix?: pc.Mat4, extra1?: number, extra2?: number): TUnicalId;

    /**
     * Releases a previously registered identifier and removes associated data.
     * @param id - The unique identifier obtained from the lock() call.
     */
    unlock(id: TUnicalId): void;
}

/**
 * Base mesh primitive interface
 */
export interface IPrimitive {
    base: number,
    baseVertex: number,
    count: number,
    indexed?: boolean
}

/**
 * Interface for working with an occlusion culling testing system.
 * Allows registering BoundingBox objects, enqueueing them for testing,
 * and checking if the object is occluded by other scene geometry.
 */
export interface IGPUIndirectDrawOcclusionCullingTester extends IOcclusionCullingTester {

    readonly _ocTesterType: "gpu_indirect_draw_oct";

    /**
     * Adds the object to the queue for occlusion testing.
     * @param id - The unique identifier returned earlier by the lock() method.
     * @param slot - The slot value obtained from device.getIndirectDrawSlot or your internal index.
     * @param primitive - The mesh primitive for draw.
     * @param instanceCount - The number of instances to draw.
     * @param firstInstance - The first instance to draw.
     * @param extra - The extra data.
     * @returns A queue index, or -1 if internal verification inconsistencies occur (e.g., the tester is unavailable or waiting for synchronization).
     */
    enqueue(id: TUnicalId, slot: number, primitive: IPrimitive, instanceCount: number, firstInstance: number, extra?: number | number[]): TUnicalQueueIndex;

    /**
     * Runs an occlusion check for the specified camera.
     * @param camera - The camera
     * @param updateParams - When true, refresh view-projection (and related) uniforms from the camera.
     */
    execute(camera: pc.Camera, updateParams?: boolean): void;
}

/**
 * Interface for working with an occlusion culling testing system that uses readback.
 */
export interface IReadbackOcclusionCullingTester extends IOcclusionCullingTester {

    /**
     * Return the result of the last occlusion test for the specified object.
     * @param id - The unique identifier of the object.
     * @returns true if the object is occluded, otherwise false.
     */
    getOcclusionStatus(id: TUnicalId): TOcclusionResult;

    /**
     * Adds the object to the queue for occlusion testing.
     * @param id - The unique identifier returned earlier by the lock() method.
     * @param extra - The extra data
     * @returns A queue index or -1 (if internal verification inconsistencies occur, for example, the tester is unavailable or the tester is waiting for synchronization).
     */
    enqueue(id: TUnicalId, extra?: number | number[]): TUnicalQueueIndex;

    /**
     * Runs an occlusion check for the specified camera.
     * @param camera - The camera
     */
    execute(camera: pc.Camera): void;
}

/**
 * Interface for working with an occlusion culling testing system.
 * Allows registering BoundingBox objects, enqueueing them for testing,
 * and checking if the object is occluded by other scene geometry.
 */
export interface IGPU2CPUReadbackOcclusionCullingTester extends IReadbackOcclusionCullingTester {
    readonly _ocTesterType: "gpu2cpu_readback_oct";
}

/**
 * CPU software occlusion tester. Rasterizes primitive and mesh occluders and tests AABBs
 * on a worker thread. Hi-Z is built only inside the worker.
 */
export interface ICPUSoftwareOcclusionCullingTester extends IReadbackOcclusionCullingTester {

    readonly _ocTesterType: "cpu_software_oct";

    /**
     * Occluder store.
     */
    readonly occluders: OccluderStore;

    /**
     * Updates the tester.
     * @param dt - The delta time.
     */
    frameUpdate(dt?: number): void;
}