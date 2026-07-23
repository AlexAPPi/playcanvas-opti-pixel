import pc from "../engine.js";

/**
 * Renderer for LOD objects using GPU instancing.
 *
 * Responsible for preparing meshes, collecting instances,
 * computing bounding boxes, and updating rendering parameters.
 */
export interface ILODRender {

    /**
     * Whether objects should be sorted before rendering.
     * Usually enabled for transparent materials.
     */
    readonly sortObjects: boolean;

    /**
     * The mesh instances used by this LOD renderer.
     * All meshes share the same instancing buffer.
     */
    readonly meshes: pc.MeshInstance[];

    /**
     * Computes the combined bounding box for all meshes.
     *
     * If root is defined, the bounding box is converted to the root local space
     * so it can be used for frustum culling without updating matrices on the CPU.
     *
     * @returns The bounding box for all meshes, or null if there are no meshes.
     */
    computeMaxMeshBoundingBox(): pc.BoundingBox | null;

    /**
     * Starts collecting instances for the next render pass.
     * Clears the internal list of queued objects.
     */
    start(): void;

    /**
     * Enqueues an instance for rendering.
     *
     * @param index The instance index in the buffer.
     * @param opacity Opacity value in the range from 0 to 1.
     */
    enqueue(index: number, opacity: number): void;

    /**
     * Sorts the collected instances.
     *
     * @param reversed If true, sorts in reverse order.
     * @param buf Buffer of indices used during sorting.
     * @param depthStore Temporary buffer for depth values.
     */
    sort(reversed: boolean, buf: Uint32Array, depthStore: Uint32Array): void;

    /**
     * Finalizes the frame and applies the collected data to the meshes.
     *
     * Updates instancing counts and, when needed, local matrices
     * relative to the root entity.
     */
    end(): void;

    /**
     * Releases resources and disables the renderer.
     */
    destroy(): void;
}