import { GPUIndexQueue } from "../../../Extras/GPUIndexQueue.js";
import { IndexManager } from "../../../Extras/IndexManager.js";
import pc from "../../../engine.js";

export type TReadbackPoll = "pending" | "ready" | "failed";

export class HZBTFState {

    public indexQueue: GPUIndexQueue;
    public outputBuffer: pc.VertexBuffer;
    public packed: Uint32Array;
    public submitFrame = 0;

    private _device: pc.WebglGraphicsDevice;
    private _pbo: WebGLBuffer | null = null;
    private _pboBytes = 0;
    private _sync: WebGLSync | null = null;
    private _copyCount = 0;
    private _unread = false;
    private _onDestroy: pc.EventHandle;
    private _onContextLost: pc.EventHandle;

    public get count() { return this.indexQueue.count; }

    constructor(device: pc.WebglGraphicsDevice, indexManager: IndexManager) {
        this._device = device;
        this.indexQueue = new GPUIndexQueue(device, indexManager, false, 0);
        this._onDestroy = device.on("destroy", this.destroy, this);
        this._onContextLost = device.on("contextlost", this._onDeviceContextLost, this);
        this.resize();
    }

    public get device() { return this._device; }

    public resize() {
        this.indexQueue.resize();
        this.packed = new Uint32Array(this.indexQueue.capacity);
        this._destroyOutputBuffer();
        this._deletePbo();
        this._deleteSync();
        this._copyCount = 0;
        this._unread = false;
        this._createOutputBuffer();
        this._createPbo();
    }

    public destroy() {
        this._onDestroy?.off();
        this._onContextLost?.off();
        this._deleteSync();
        this._deletePbo();
        this._destroyOutputBuffer();
        this.indexQueue?.destroy();
        this.outputBuffer = null!;
        this.indexQueue = null!;
    }

    public clear() {
        this.abortRead();
        this.indexQueue.clear();
        this._copyCount = 0;
        this.submitFrame = 0;
    }

    public enqueue(index: number, extra?: number | number[]): number {
        return this.indexQueue.enqueue(index, extra);
    }

    public beforeFill(): void {
        this.indexQueue.update();
        this._ensureOutputBuffer();
    }

    public abortRead(): void {
        this._deleteSync();
        if (this._unread) {
            this._deletePbo();
        }
    }

    public beginRead(): void {
        const count = Math.min(this.indexQueue.count, this.packed.length);
        this._copyCount = count;
        this._deleteSync();

        if (count <= 0) {
            return;
        }

        this._ensureOutputBuffer();

        if (this._unread) {
            this._deletePbo();
        }

        this._clearPbo();

        const gl = this._device.gl;
        const srcId = this.outputBuffer?.impl?.bufferId;
        if (!gl || !srcId || !this._pbo) {
            return;
        }

        const bytes = count * 4;
        gl.bindBuffer(gl.COPY_READ_BUFFER, srcId);
        gl.bindBuffer(gl.COPY_WRITE_BUFFER, this._pbo);
        gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, 0, 0, bytes);
        gl.bindBuffer(gl.COPY_READ_BUFFER, null);
        gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);

        this._sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        this._unread = true;
        gl.flush();
    }

    public poll(): TReadbackPoll {
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

    public read(): number {
        const count = this._copyCount;
        if (count <= 0 || !this._pbo) {
            return 0;
        }

        const gl = this._device.gl;
        gl.bindBuffer(gl.COPY_READ_BUFFER, this._pbo);
        gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, this.packed, 0, count);
        gl.bindBuffer(gl.COPY_READ_BUFFER, null);

        this._unread = false;
        this._copyCount = 0;
        return count;
    }

    private _onDeviceContextLost() {
        this._deleteSync();
        this._deletePbo();
    }

    private _ensureOutputBuffer() {
        if (!this.outputBuffer || !this.outputBuffer.impl?.bufferId) {
            this._destroyOutputBuffer();
            this._createOutputBuffer();
        }
    }

    private _clearPbo() {
        if (!this._pbo) {
            this._createPbo();
            return;
        }

        const gl = this._device.gl;
        gl.bindBuffer(gl.COPY_WRITE_BUFFER, this._pbo);
        gl.bufferData(gl.COPY_WRITE_BUFFER, this._pboBytes, gl.STREAM_READ);
        gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
    }

    private _createOutputBuffer() {
        const format = new pc.VertexFormat(this._device, [{
            semantic: pc.SEMANTIC_ATTR6,
            components: 1,
            type: pc.TYPE_UINT32,
            normalize: false,
            asInt: true
        }]);

        this.outputBuffer = new pc.VertexBuffer(this._device, format, this.indexQueue.capacity, {
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
        const bytes = this.indexQueue.capacity * 4;
        const pbo = gl.createBuffer();
        this._pbo = pbo;
        this._pboBytes = bytes;

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
            this._pboBytes = 0;
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
