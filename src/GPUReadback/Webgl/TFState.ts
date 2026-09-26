import pc from "../../engine.js";

export type TTFReadbackPoll = "pending" | "ready" | "failed";
export type TTFElementType = "float32" | "uint32";

/**
 * One in-flight WebGL2 transform-feedback slot: TF output buffer + STREAM_READ
 * PBO + fence. Shared by coverage pack and HZB flag readback.
 *
 * `beginRead()` copies and inserts a fence.
 * `poll()` checks the fence without waiting.
 * `read()` pulls data only after the fence is ready.
 *
 * {@link pending} is the whole slot state: a capture is in flight from
 * `beginRead()` until `read()` or `abortRead()`. The PBO object lives with the
 * slot, but `beginRead` reallocates its storage with `bufferData` every time,
 * so a copy never lands on bytes the GPU may still be reading or that
 * `getBufferSubData` has not pulled out yet — that write-before-read is the
 * ANGLE slow path.
 */
export class TFState {

    public outputBuffer: pc.VertexBuffer;
    public vp = new Float32Array(16);
    public cameraParams = new Float32Array(4);
    public submitFrame = 0;
    /** A capture is fenced and not yet read or aborted. */
    public pending = false;
    /** Held for enqueue / fill between `acquire` and `submit`. */
    public reserved = false;

    private _device: pc.WebglGraphicsDevice;
    private _elementCount = 0;
    private _copyCount = 0;
    private _elementType: TTFElementType;
    private _pbo: WebGLBuffer | null = null;
    private _sync: WebGLSync | null = null;

    constructor(
        device: pc.WebglGraphicsDevice,
        elementCount: number,
        elementType: TTFElementType = "float32"
    ) {
        this._device = device;
        this._elementType = elementType;
        this.resize(elementCount);
    }

    public get elementCount() { return this._elementCount; }

    public resize(elementCount: number) {
        this._elementCount = Math.max(0, elementCount | 0);
        this._deleteSync();
        this._deletePbo();
        this._destroyOutputBuffer();
        this.pending = false;
        this.reserved = false;
        this.submitFrame = 0;
        this._copyCount = 0;
        this._createOutputBuffer();
    }

    public destroy() {
        this._deleteSync();
        this._deletePbo();
        this._destroyOutputBuffer();
    }

    public beforeFill(): void {
        this._ensureOutputBuffer();
    }

    /**
     * Retire the capture without reading it. Keeps the PBO object — the next
     * {@link beginRead} reallocates its storage anyway.
     */
    public abortRead(): void {
        this._deleteSync();
        this.pending = false;
        this.reserved = false;
        this._copyCount = 0;
    }

    /**
     * Copy TF output into the STREAM_READ PBO and insert a fence.
     * Does not block the CPU. Call after TF has written `outputBuffer`.
     * Leaves the slot idle if anything is missing.
     *
     * @param copyCount - Elements to copy. Defaults to the full buffer.
     */
    public beginRead(copyCount?: number): void {

        const count = copyCount == null
            ? this._elementCount
            : Math.max(0, Math.min(this._elementCount, copyCount | 0));

        this.abortRead();

        if (count <= 0) {
            return;
        }

        this._ensurePbo();

        const gl = this._device.gl;
        const srcId = this.outputBuffer?.impl?.bufferId;
        if (!gl || !srcId || !this._pbo) {
            return;
        }

        const bytes = count * 4;
        gl.bindBuffer(gl.COPY_READ_BUFFER, srcId);
        gl.bindBuffer(gl.COPY_WRITE_BUFFER, this._pbo);
        gl.bufferData(gl.COPY_WRITE_BUFFER, bytes, gl.STREAM_READ);
        gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, 0, 0, bytes);
        gl.bindBuffer(gl.COPY_READ_BUFFER, null);
        gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);

        // No `gl.flush()`: on Android GLES a flush after the pack often stalls,
        // and the fence still completes at the end of the frame.
        this._sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (!this._sync) {
            return;
        }

        this._copyCount = count;
        this.pending = true;
    }

    /**
     * Check the fence without waiting. Idempotent: `"ready"` does not consume
     * the fence — `read()` / `abortRead()` delete it.
     * Uses `getSyncParameter` rather than `clientWaitSync(0)`: on some
     * ANGLE/Adreno drivers the latter still flushes.
     * `"pending"` — GPU has not reached it yet.
     * `"ready"` — safe to call `read()`.
     * `"failed"` — the fence is gone or the status is not signaled.
     */
    public poll(): TTFReadbackPoll {

        const gl = this._device.gl;
        if (!gl || !this._sync) {
            return "failed";
        }

        const status = gl.getSyncParameter(this._sync, gl.SYNC_STATUS);
        if (status === gl.UNSIGNALED) {
            return "pending";
        }
        if (status === gl.SIGNALED) {
            return "ready";
        }

        this._deleteSync();
        return "failed";
    }

    /**
     * Copy the PBO into `dest`.
     * Call only after `poll()` returns `"ready"`.
     * Returns the number of elements read, `0` if nothing was copied — the
     * slot then polls `"failed"` so the owner can abort it.
     */
    public read(dest: Float32Array | Uint32Array, dstOffset: number = 0): number {

        const gl = this._device.gl;
        const count = this._copyCount;
        const offset = dstOffset | 0;

        this._deleteSync();

        if (!gl || !this._pbo || count <= 0 || offset < 0 || dest.length - offset < count) {
            return 0;
        }

        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, dest, offset, count);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

        this.pending = false;
        this._copyCount = 0;
        return count;
    }

    /** Every GL handle is already invalid, so drop them without deleting. */
    public onContextLost() {
        this._sync = null;
        this._pbo = null;
        this.pending = false;
        this.reserved = false;
        this._copyCount = 0;
    }

    private _ensureOutputBuffer() {
        if (!this.outputBuffer || !this.outputBuffer.impl?.bufferId) {
            this._destroyOutputBuffer();
            this._createOutputBuffer();
        }
    }

    private _ensurePbo() {
        if (!this._pbo) {
            this._pbo = this._device.gl?.createBuffer() ?? null;
        }
    }

    private _createOutputBuffer() {
        const count = this._elementCount;
        if (count <= 0) {
            this.outputBuffer = null!;
            return;
        }

        const isUint = this._elementType === "uint32";
        const format = new pc.VertexFormat(this._device, [{
            semantic: pc.SEMANTIC_ATTR6,
            components: 1,
            type: isUint ? pc.TYPE_UINT32 : pc.TYPE_FLOAT32,
            normalize: false,
            asInt: isUint
        }]);

        this.outputBuffer = new pc.VertexBuffer(this._device, format, count, {
            usage: pc.BUFFER_GPUDYNAMIC
        });

        this.outputBuffer.unlock();
    }

    private _destroyOutputBuffer() {
        this.outputBuffer?.destroy();
        this.outputBuffer = null!;
    }

    private _deletePbo() {
        if (this._pbo) {
            this._device.gl?.deleteBuffer(this._pbo);
            this._pbo = null;
        }
    }

    private _deleteSync() {
        if (this._sync) {
            this._device.gl?.deleteSync(this._sync);
            this._sync = null;
        }
    }
}
