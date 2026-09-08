import pc from "../../../engine.js";

export type TCoverageReadbackPoll = "pending" | "ready" | "failed";

/**
 * One in-flight coverage pack: TF output buffer + STREAM_READ PBO,
 * same copy / fence / getBufferSubData sequence as WebGL HZB TF readback.
 */
export class CoverageTFState {

    public outputBuffer: pc.VertexBuffer;
    public vp = new Float32Array(16);
    public cameraParams = new Float32Array(4);
    public submitFrame = 0;
    public pending = false;

    private _device: pc.WebglGraphicsDevice;
    private _pixelCount = 0;
    private _pbo: WebGLBuffer | null = null;
    private _sync: WebGLSync | null = null;
    private _unread = false;

    constructor(device: pc.WebglGraphicsDevice, pixelCount: number) {
        this._device = device;
        this.resize(pixelCount);
    }

    public get unread() { return this._unread; }
    public get pixelCount() { return this._pixelCount; }

    public resize(pixelCount: number) {
        this._pixelCount = Math.max(0, pixelCount | 0);
        this._destroyOutputBuffer();
        this._deletePbo();
        this._deleteSync();
        this.pending = false;
        this.submitFrame = 0;
        this._createOutputBuffer();
        this._createPbo();
    }

    public destroy() {
        this._deleteSync();
        this._deletePbo();
        this._destroyOutputBuffer();
    }

    public beforeFill(): void {
        this._ensureOutputBuffer();
    }

    public abortRead(): void {
        this._deleteSync();
        if (this._unread) {
            this._deletePbo();
        }
        this.pending = false;
    }

    /**
     * Copy TF output into the STREAM_READ PBO and insert a fence.
     * Recycled slots reuse the existing PBO (no `bufferData` orphan).
     * `flush` is off by default: Android GLES often stalls on `gl.flush`
     * after a pack; the fence still completes at the end of the frame.
     */
    public beginRead(flush = false): void {
        const count = this._pixelCount;
        this._deleteSync();

        if (count <= 0) {
            this.pending = false;
            return;
        }

        // Do not recreate outputBuffer here:
        // the caller just wrote TF into it.
        if (this._unread) {
            this._deletePbo();
        }

        this._ensurePbo();

        const gl = this._device.gl;
        const srcId = this.outputBuffer?.impl?.bufferId;
        if (!gl || !srcId || !this._pbo) {
            this.pending = false;
            return;
        }

        const bytes = count * 4;
        gl.bindBuffer(gl.COPY_READ_BUFFER, srcId);
        gl.bindBuffer(gl.COPY_WRITE_BUFFER, this._pbo);
        gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, 0, 0, bytes);
        gl.bindBuffer(gl.COPY_READ_BUFFER, null);
        gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);

        this._sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);

        if (!this._sync) {
            this._deletePbo();
            this.pending = false;
            return;
        }

        this._unread = true;
        this.pending = true;

        if (flush) {
            gl.flush();
        }
    }

    public poll(): TCoverageReadbackPoll {
        if (!this._sync) {
            return "failed";
        }

        const gl = this._device.gl;
        const res = gl.clientWaitSync(this._sync, 0, 0);

        if (res === gl.TIMEOUT_EXPIRED) {
            return "pending";
        }

        this._deleteSync();
        return res === gl.WAIT_FAILED ? "failed" : "ready";
    }

    public read(dest: Float32Array): number {
        const count = this._pixelCount;
        if (count <= 0 || !this._pbo || dest.length < count) {
            return 0;
        }

        const gl = this._device.gl;
        gl.bindBuffer(gl.COPY_READ_BUFFER, this._pbo);
        gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, dest, 0, count);
        gl.bindBuffer(gl.COPY_READ_BUFFER, null);

        this._unread = false;
        return count;
    }

    public onContextLost() {
        this._deleteSync();
        this._pbo = null;
        this._unread = false;
        this.pending = false;
    }

    private _ensureOutputBuffer() {
        if (!this.outputBuffer || !this.outputBuffer.impl?.bufferId) {
            this._destroyOutputBuffer();
            this._createOutputBuffer();
        }
    }

    private _ensurePbo() {
        if (!this._pbo) {
            this._createPbo();
        }
    }

    private _createOutputBuffer() {
        const count = this._pixelCount;
        if (count <= 0) {
            this.outputBuffer = null!;
            return;
        }

        const format = new pc.VertexFormat(this._device, [{
            semantic: pc.SEMANTIC_ATTR6,
            components: 1,
            type: pc.TYPE_FLOAT32,
            normalize: false
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

    private _createPbo() {
        const gl = this._device.gl;
        const bytes = this._pixelCount * 4;
        if (!gl || bytes <= 0) {
            this._pbo = null;
            return;
        }

        const pbo = gl.createBuffer();
        this._pbo = pbo;

        if (pbo) {
            gl.bindBuffer(gl.COPY_WRITE_BUFFER, pbo);
            gl.bufferData(gl.COPY_WRITE_BUFFER, bytes, gl.STREAM_READ);
            gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
        }
    }

    private _deletePbo() {
        if (this._pbo) {
            this._device.gl?.deleteBuffer(this._pbo);
            this._pbo = null;
        }
        this._unread = false;
    }

    private _deleteSync() {
        if (this._sync) {
            this._device.gl?.deleteSync(this._sync);
            this._sync = null;
        }
    }
}
