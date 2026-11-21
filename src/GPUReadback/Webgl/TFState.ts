import pc from "../../engine.js";

export type TTFElementType = "float32" | "uint32";

/**
 * One WebGL2 transform-feedback readback slot: the TF output buffer and a
 * STREAM_READ PBO. Shared by coverage pack and HZB flag readback.
 *
 * {@link beginRead} copies `outputBuffer` into the PBO, {@link read} pulls it
 * out with `getBufferSubData`. The slot has no fence of its own: that call
 * waits for every command recorded before it, not just this copy, so the
 * queue reads only behind a fence that covers the whole frame.
 *
 * {@link pending} is the whole slot state: a copy is in flight from
 * `beginRead()` until `read()` or `abortRead()`. The PBO object lives with the
 * slot, but `beginRead` reallocates its storage with `bufferData` every time,
 * so a copy never lands on bytes the GPU may still be reading or that
 * `getBufferSubData` has not pulled out yet — that write-before-read is the
 * ANGLE slow path.
 */
export class TFState {

    public outputBuffer: pc.VertexBuffer;
    public submitFrame = 0;
    /** A copy is in the PBO and not yet read or aborted. */
    public pending = false;
    /** Held for enqueue / fill between `acquire` and `submit`. */
    public reserved = false;

    private _device: pc.WebglGraphicsDevice;
    private _elementCount = 0;
    private _copyCount = 0;
    private _elementType: TTFElementType;
    private _pbo: WebGLBuffer | null = null;

    constructor(
        device: pc.WebglGraphicsDevice,
        elementCount: number,
        elementType: TTFElementType = "float32"
    ) {
        this._device = device;
        this._elementType = elementType;
        this.resize(elementCount);
    }

    public resize(elementCount: number) {
        this._elementCount = Math.max(0, elementCount | 0);
        this._deletePbo();
        this._destroyOutputBuffer();
        this.abortRead();
        this.submitFrame = 0;
        this._createOutputBuffer();
    }

    public destroy() {
        this._deletePbo();
        this._destroyOutputBuffer();
    }

    public beforeFill(): void {
        this._ensureOutputBuffer();
    }

    /**
     * Retire the copy without reading it. Keeps the PBO object — the next
     * {@link beginRead} reallocates its storage anyway.
     */
    public abortRead(): void {
        this.pending = false;
        this.reserved = false;
        this._copyCount = 0;
    }

    /**
     * Copy TF output into the PBO. Does not block the CPU. Call after TF has
     * written `outputBuffer`. Leaves the slot idle if anything is missing.
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

        this._copyCount = count;
        this.pending = true;
    }

    /**
     * Copy the PBO into `dest`. Call only once the frame fence after this
     * copy has signaled; before that `getBufferSubData` stalls.
     * Returns the number of elements read, `0` if nothing was copied.
     *
     * @param dstOffset - Element index in `dest` where the copy starts.
     */
    public read(dest: Float32Array | Uint32Array, dstOffset: number = 0): number {

        const gl = this._device.gl;
        const count = this._copyCount;
        const offset = dstOffset | 0;

        if (!gl || !this._pbo || count <= 0 || offset < 0 || dest.length - offset < count) {
            return 0;
        }

        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, dest, offset, count);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

        this.abortRead();
        return count;
    }

    /** Every GL handle is already invalid, so drop them without deleting. */
    public onDeviceLost() {
        this._pbo = null;
        this.abortRead();
    }

    private _ensureOutputBuffer() {
        if (!this.outputBuffer ||
            !this.outputBuffer.impl?.bufferId) {
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
        const pbo = this._pbo;
        if (!pbo) {
            return;
        }
        this._pbo = null;
        const gl = this._device.gl;
        if (gl && !this._device.isContextLost()) {
            gl.deleteBuffer(pbo);
        }
    }
}
