import pc from "../../engine.js";
import { IHierarchicalZBuffer } from "../HZB/IHierarchicalZBuffer.js";

/**
 * GPU coverage downsample + packed CPU **view-space Z** (metres). Shared by WebGL (TF/PBO) and
 * WebGPU (compute / mapAsync) so {@link CoverageBufferTester} can sit on either.
 */
export interface ICoverageBuffer extends IHierarchicalZBuffer {
    readonly device: pc.GraphicsDevice;
    readonly resizePending: boolean;
    readonly cpuReady: boolean;
    readonly cpuVersion: number;
    readonly cpuDepth: Float32Array;
    readonly cpuWidth: number;
    readonly cpuHeight: number;
    readonly cpuViewProjection: Float32Array;
    /** Capture `camera_params`: (1/far, far, near, ortho). Packed CPU depth is view-space Z. */
    readonly cpuCameraParams: Float32Array;
    readonly cpuUvFactor: [number, number];
    cpuReadback: boolean;
    frameUpdate(): void;
    update(camera: pc.Camera): void;
    resize(width?: number, height?: number, maxWidth?: number, maxHeight?: number): void;
    destroy(): void;
}
