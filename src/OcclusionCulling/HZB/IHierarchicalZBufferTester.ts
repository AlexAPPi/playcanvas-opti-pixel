import type { IOcclusionCullingTester } from "../IOcclusionCullingTester";
import type { IHierarchicalZBuffer } from "./IHierarchicalZBuffer";

export interface IDebugRectangle {
    x: number,
    y: number,
    width: number,
    height: number,
}

export interface IDebugInfo {
    inFrustum: boolean,
    lod: number,
    viewSize: pc.Vec2,
    boundingBox: {
        center: pc.Vec3,
        halfExtents: pc.Vec3,
    },
    rectangleScreen: IDebugRectangle,
}

export interface IHierarchicalZBufferTester extends IOcclusionCullingTester {

    hzb: IHierarchicalZBuffer;

    /** Advance the frame counter. Call on `frameupdate`. */
    frameUpdate(dt: number): void;

    /**
     * Publish the oldest WebGL readback whose frame fence has signaled.
     * Chromium signals that fence two frames after {@link frameEnd}.
     * Call on `framerender`, after scripts and before the GPU timer opens.
     * No-op on WebGPU.
     */
    frameRender(): void;

    /**
     * Fence everything this frame recorded. A later {@link frameRender}
     * publishes the capture once this fence has signaled. Call on `frameend`,
     * after the capture. No-op on WebGPU.
     */
    frameEnd(): void;

    getDebugInfo(index: number): IDebugInfo;
}