import pc from "../../engine.js";

/**
 * GPU coverage downsample + packed CPU **view-space Z** (metres).
 * Shared by WebGL (TF/PBO) and WebGPU (compute / mapAsync) so a coverage worker tester can sit on either.
 */
export interface ICoverageBuffer {

    readonly device: pc.GraphicsDevice;
    readonly screenWidth: number;
    readonly screenHeight: number;
    readonly width: number;
    readonly height: number;
    readonly resizePending: boolean;
    readonly cpuReady: boolean;
    readonly cpuVersion: number;
    readonly cpuDepth: Float32Array;
    readonly cpuWidth: number;
    readonly cpuHeight: number;
    readonly cpuViewProjection: Float32Array;
    readonly cpuCameraParams: Float32Array;
    readonly cpuUvFactor: [number, number];

    /**
     * Whether the coverage buffer is enabled.
     */
    enabled: boolean;

    /**
     * Whether to pack view-space metres and start an async readback.
     */
    cpuReadback: boolean;

    /**
     * Harvest the newest finished readback whose lag has elapsed into {@link cpuDepth},
     * {@link cpuViewProjection}, and {@link cpuCameraParams}, then bump {@link cpuVersion}.
     * Captures older than that one are dropped unread.
     * Call every frame before tests. Does not start a capture.
     * @param dt Frame delta in seconds. Unused by the harvest itself; kept for the frame callback.
     */
    frameUpdate(dt: number): void;

    /**
     * Max-downsample the hardware depth grab (`requestSceneDepthMap` / `renderPassDepthGrab`)
     * and, when {@link cpuReadback} is on, pack view-space metres and start an async readback.
     * Device Z is linearized in the pack pass. No-op without a grab texture, when disabled,
     * while every readback slot is busy, or on a tick that will not pack
     * (`readbackPeriod`, WebGL).
     * Call from `postrender`, after opaque depth. Resizes if the grab size changed.
     */
    captureDepthGrab(camera: pc.Camera): void;

    /**
     * Same chain as {@link captureDepthGrab}, from `camera.sceneDepthMap`.
     * Use with CameraFrame (`rendering.sceneDepthMap`, or a post effect that publishes scene depth).
     * Linear and reciprocal encodings are decoded to view-space metres before the max chain.
     * No-op until the map is published, and while every readback slot is busy.
     * Call from `postrender`.
     */
    captureSceneDepthMap(camera: pc.Camera): void;

    /**
     * Rebuild the downsample chain and clear {@link resizePending}.
     * Omitted sizes keep the current screen and packed resolution.
     *
     * The readback ring and {@link cpuDepth} only follow the packed resolution,
     * so a screen-only resize leaves the in-flight captures and the last
     * published one alone. Changing `maxWidth` / `maxHeight` rebuilds both and
     * invalidates the previous capture (`cpuReady` becomes false).
     */
    resize(width?: number, height?: number, maxWidth?: number, maxHeight?: number): void;

    /**
     * Release GPU resources, readback slots, and device event handlers.
     */
    destroy(): void;
}
