import pc from "../../../engine.js";

export type TCoverageReadbackPoll = "pending" | "ready" | "failed";

/**
 * One in-flight coverage pack. Compute writes float view-space Z into
 * `outputBuffer`; {@link beginRead} downloads with PlayCanvas
 * `StorageBuffer.read` (copy to a fresh MAP_READ staging, mapAsync after
 * the encoder is submitted). Do not keep a persistent MAP_READ buffer —
 * that is the WebGPU analogue of rewriting a STREAM_READ PBO before read.
 */
export class CoverageGpuReadbackState {

    public outputBuffer: pc.StorageBuffer;
    public vp = new Float32Array(16);
    public cameraParams = new Float32Array(4);
    public submitFrame = 0;
    public pending = false;

    private _device: pc.WebgpuGraphicsDevice;
    private _pixelCount = 0;
    private _scratch: Float32Array;
    private _readGen = 0;
    private _aborted = false;
    private _ready = false;
    private _failed = false;
    private _dead = false;

    constructor(device: pc.WebgpuGraphicsDevice, pixelCount: number) {
        this._device = device;
        this.resize(pixelCount);
    }

    public get pixelCount() { return this._pixelCount; }

    public resize(pixelCount: number) {
        this.abortRead();
        this._pixelCount = Math.max(0, pixelCount | 0);
        this._scratch = new Float32Array(this._pixelCount);
        this._destroyOutputBuffer();
        this.pending = false;
        this.submitFrame = 0;
        this._createOutputBuffer();
    }

    public destroy() {
        this._dead = true;
        this.abortRead();
        this._destroyOutputBuffer();
    }

    public beforeFill(): void {
        this._ensureOutputBuffer();
    }

    public abortRead(): void {
        this._aborted = true;
        this._failed = false;
        if (!this.pending) {
            this._ready = false;
            return;
        }
        if (this._ready) {
            this._ready = false;
            this.pending = false;
            return;
        }
        // In-flight StorageBuffer.read cannot be cancelled; ignore it when
        // the promise settles. Keep pending so acquire will not reuse the
        // output buffer until that copy has finished.
        this._ready = false;
    }

    /**
     * Download `outputBuffer` after the pack compute has written it.
     * Uses the engine read path so mapAsync runs on a throwaway staging
     * buffer after the frame encoder is submitted.
     */
    public beginRead(): void {

        if (this.pending && !this._ready) {
            return;
        }

        const count = this._pixelCount;
        this._aborted = false;
        this._failed = false;
        this._ready = false;

        if (count <= 0) {
            this.pending = false;
            return;
        }

        this._ensureOutputBuffer();
        const output = this.outputBuffer;
        if (!output) {
            this.pending = false;
            return;
        }

        this.pending = true;
        const gen = ++this._readGen;
        const dest = this._scratch;

        output.read(0, count * 4, dest).then(
            () => this._onReadOk(gen),
            () => this._onReadFail(gen)
        );
    }

    public poll(): TCoverageReadbackPoll {
        if (this._failed) {
            return "failed";
        }
        if (this._ready) {
            return "ready";
        }
        if (!this.pending) {
            return "failed";
        }
        return "pending";
    }

    public read(dest: Float32Array): number {
        const count = this._pixelCount;
        if (count <= 0 || !this._ready || dest.length < count) {
            return 0;
        }

        dest.set(this._scratch);
        this._ready = false;
        this.pending = false;
        return count;
    }

    private _onReadOk(gen: number) {
        if (gen !== this._readGen) {
            return;
        }
        if (this._dead || this._aborted) {
            this.pending = false;
            this._ready = false;
            return;
        }
        this._ready = true;
    }

    private _onReadFail(gen: number) {
        if (gen !== this._readGen) {
            return;
        }
        this._failed = true;
        this.pending = false;
        this._ready = false;
    }

    private _ensureOutputBuffer() {
        if (!this.outputBuffer || !this.outputBuffer.impl?.buffer) {
            this._destroyOutputBuffer();
            this._createOutputBuffer();
        }
    }

    private _createOutputBuffer() {
        const bytes = this._pixelCount * 4;
        if (bytes <= 0) {
            this.outputBuffer = null!;
            return;
        }

        this.outputBuffer = new pc.StorageBuffer(
            this._device,
            bytes,
            pc.BUFFERUSAGE_COPY_SRC
        );
    }

    private _destroyOutputBuffer() {
        this.outputBuffer?.destroy();
        this.outputBuffer = null!;
    }
}
