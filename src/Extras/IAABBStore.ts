import pc from "../engine.js";
import { IndexManager } from "./IndexManager";

/**
 * Interface for AABB (Axis-Aligned Bounding Box) store management
 */
export interface IAABBStore {

    /**
     * Maximum number of AABBs the store can hold.
     */
    readonly capacity: number;

    /**
     * Index manager
     */
    readonly indexManager: IndexManager;

    /**
     * Texture containing AABB centers.
     */
    readonly centersTexture: pc.Texture;

    /**
     * Texture containing AABB half extents.
     */
    readonly halfExtentsTexture: pc.Texture;

    /**
     * Updates the stored data and synchronizes it across all sources when needed,
     * including CPU, GPU, and any other backing representations.
     */
    update(): void;

    /**
     * Locks a bounding box and returns its index
     * 
     * @param boundingBox - The bounding box to lock
     * @param matrix - Optional transformation matrix
     * @param extra1 - Extra parameter 1 (usage depends on implementation)
     * @param extra2 - Extra parameter 2 (usage depends on implementation)
     * @returns Index of the locked bounding box
     */
    lock(boundingBox: pc.BoundingBox, matrix?: pc.Mat4, extra1?: number, extra2?: number): number;

    /**
     * Unlocks a bounding box by its index
     * 
     * @param index - Index of the bounding box to unlock
     */
    unlock(index: number): void;

    /**
     * Enqueues an update for a bounding box
     * 
     * @param index - Index of the bounding box to update
     * @param boundingBox - New bounding box data
     * @param matrix - Optional transformation matrix
     * @param extra1 - Extra parameter 1
     * @param extra2 - Extra parameter 2
     */
    enqueueUpdate(index: number, boundingBox: pc.BoundingBox, matrix?: pc.Mat4, extra1?: number, extra2?: number): void;

    /**
     * Gets the bounding box data by its index
     * 
     * @param index - Index of the bounding box
     * @param boundingBox - Bounding box object to store the result
     * @returns The bounding box
     */
    get(index: number, boundingBox: pc.BoundingBox): pc.BoundingBox;

    /**
     * Gets the transformation matrix data for a bounded box
     * 
     * @param index - Index of the bounding box
     * @param matrixData - Float32Array to store the matrix data
     */
    getMatrix(index: number, matrixData: Float32Array): void;
}