import pc from "../../engine.js";
import type { IHierarchicalZBuffer } from "../HZB/IHierarchicalZBuffer.js";

/**
 * Last pack that started a readback, and the last capture {@link ICoverageBuffer.frameUpdate} published.
 * A skipped capture leaves these values. Milliseconds.
 *
 * `packMs` is the CPU time to issue the pack. The GPU pack finishes inside `latencyMs`.
 * `readMs` is the copy into `cpuDepth`: WebGL `getBufferSubData`, or on WebGPU the mapped-range copy plus the publish copy.
 * `latencyMs` and `latencyFrames` run from that readback's submit until the copy finished.
 */
export interface ICoverageReadbackStats {
    packMs: number;
    readMs: number;
    latencyMs: number;
    latencyFrames: number;
}

/**
 * Packed CPU **view-space Z** (metres) taken from one mip of a hierarchical Z-buffer.
 * Shared by WebGL (transform feedback / PBO) and WebGPU (compute / mapAsync).
 *
 * Build the pyramid first (`update` / `updateSceneDepth`), then {@link capture}.
 * Each axis picks the stored mip nearest to the buffer's max resolution; the
 * coarser of the two is packed. If that mip's screen footprint, clamped to the
 * max, would still cover three or more source texels per packed pixel, the next
 * coarser mip is used. The CPU map is that footprint rounded to whole texels.
 * Pixel `i` covers screen UV `[i / cpuWidth, (i + 1) / cpuWidth]` (the same
 * on Y) and reads the HZB texels under that slice. Each packed texel is that
 * device Z, linearized to metres.
 */
export interface ICoverageBuffer {

    /**
     * Device that owns the pack and the readback ring.
     */
    readonly device: pc.GraphicsDevice;

    /**
     * Cap on the packed map width, in texels.
     * The published footprint is {@link cpuWidth}.
     */
    readonly width: number;

    /**
     * Cap on the packed map height, in texels.
     * The published footprint is {@link cpuHeight}.
     */
    readonly height: number;

    /**
     * True after {@link frameUpdate} has published a capture.
     * False before the first publish, after {@link resize} changes the packed
     * pixel count (`maxWidth * maxHeight`), and on WebGL after context loss.
     * A resize that keeps that count leaves a published map ready.
     */
    readonly cpuReady: boolean;

    /**
     * Bumped when {@link frameUpdate} publishes a capture, and when {@link resize}
     * changes the packed pixel count. Changing `readbackSlots` does not bump it.
     * The tester recopies {@link cpuDepth} when this differs from the copy it
     * last applied and {@link cpuReady} is set.
     */
    readonly cpuVersion: number;

    /**
     * View-space Z of the published capture, in metres.
     * Length is {@link width} × {@link height}. A publish writes a tightly packed
     * map of {@link cpuWidth} × {@link cpuHeight} into the front of the array
     * and leaves texels past that prefix untouched. Row 0 is the bottom of the screen.
     * Construct and a packed-size rebuild allocate a new array filled with `1e10`.
     */
    readonly cpuDepth: Float32Array;

    /**
     * Width of the published map, in texels. Screen footprint of the mip that
     * was packed, clamped to {@link width}. Reports {@link width} until the
     * first publish and after {@link resize} changes the packed pixel count.
     */
    readonly cpuWidth: number;

    /**
     * Height of the published map. See {@link cpuWidth}.
     */
    readonly cpuHeight: number;

    /**
     * View-projection of the camera packed into the published map
     * (`projection` × `view`, 16 column-major floats).
     * A packed-size rebuild replaces {@link cpuDepth} and leaves this matrix
     * unchanged until the next publish. Read it with the map while {@link cpuReady} is set.
     */
    readonly cpuViewProjection: Float32Array;

    /**
     * `Camera.fillShaderParams` of that same camera.
     * `x` is `1 / far`, `y` is far, `z` is near, `w` is `1` for an orthographic
     * camera and `0` for perspective. Same lifetime as {@link cpuViewProjection}.
     */
    readonly cpuCameraParams: Float32Array;

    /**
     * Stored HZB level selected by the last {@link capture} that took a readback slot.
     * Stays `0` until then. Level `0` is also a real mip.
     */
    readonly sourceMip: number;

    /**
     * Last pack and last published GPU read. See {@link ICoverageReadbackStats}.
     */
    readonly stats: ICoverageReadbackStats;

    /**
     * When false, {@link capture} does nothing. Defaults to true.
     */
    enabled: boolean;

    /**
     * When false, {@link capture} does not pack or start a readback.
     * {@link frameUpdate} still publishes a readback already in flight.
     * Defaults to true.
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
     * Select a mip of an already-built pyramid, pack it into the CPU map, and start
     * an async readback. The selected level is written to {@link sourceMip}.
     * Device Z is linearized in the pack.
     * No-op when this buffer or the pyramid is disabled, when {@link cpuReadback}
     * is off, or without a pyramid texture. Also no-op when no readback slot is
     * free, when a readback was already submitted this frame, or on a tick
     * that `readbackPeriod` skips.
     * Call after `hzb.update` / `hzb.updateSceneDepth`, once opaque depth is in the pyramid.
     */
    capture(hzb: IHierarchicalZBuffer, camera: pc.Camera): void;

    /**
     * Set the packed-map cap.
     * Omitted sizes keep the current cap.
     *
     * The readback ring holds `maxWidth * maxHeight` pixels and is rebuilt only
     * when that count changes. A same-count change keeps in-flight captures and
     * the published map. A rebuild drops them: {@link cpuReady} becomes false,
     * {@link cpuVersion} increments, and {@link cpuDepth} is filled with `1e10`.
     *
     * Screen size belongs to the HZB. A window resize does not call this, so
     * in-flight captures and the published map stay.
     */
    resize(maxWidth?: number, maxHeight?: number): void;

    /**
     * Release GPU resources, readback slots, and device event handlers.
     */
    destroy(): void;
}
