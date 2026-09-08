import pc from "../../../engine.js";

export type TCoverageReadbackPoll = "pending" | "ready" | "failed";

/**
 * One in-flight coverage pack: compute writes float view-space Z into a storage
 * buffer, then copyBufferToBuffer + mapAsync downloads it (WebGPU stand-in
 * for WebGL TF output + STREAM_READ PBO).
 */
export class CoverageGpuReadbackState {

    public outputBuffer: pc.StorageBuffer;
    public vp = new Float32Array(16);
    public cameraParams = new Float32Array(4);
    public submitFrame = 0;
    public pending = false;

    private _device: pc.WebgpuGraphicsDevice;
    private _pixelCount = 0;
    private _staging: pc.StorageBuffer | null = null;
    private _scratch: Float32Array;
    private _mapTimer: ReturnType<typeof setTimeout> | null = null;
    private _mappedGpu: GPUBuffer | null = null;
    private _mapping = false;
    private _unread = false;
    private _aborted = false;
    private _ready = false;
    private _failed = false;
    private _dead = false;

    private readonly _onMapTimeout = () => {
        this._mapTimer = null;
        this._startMap();
    };

    private readonly _onMapSuccess = () => {
        this._finishMapSuccess();
    };

    private readonly _onMapFail = () => {
        this._failed = true;
        this._mappedGpu = null;
        this._finishGpu(null);
    };

    constructor(device: pc.WebgpuGraphicsDevice, pixelCount: number) {
        this._device = device;
        this.resize(pixelCount);
    }

    public get unread() { return this._unread; }
    public get pixelCount() { return this._pixelCount; }

    public resize(pixelCount: number) {
        this.abortRead();
        this._pixelCount = Math.max(0, pixelCount | 0);
        this._scratch = new Float32Array(this._pixelCount);
        this._destroyOutputBuffer();
        this._destroyStaging();
        this.pending = false;
        this.submitFrame = 0;
        this._createOutputBuffer();
        this._createStaging();
    }

    public destroy() {
        this._dead = true;
        this.abortRead();
        if (this._mapTimer || this._mapping) {
            return;
        }
        this._destroyStaging();
        this._destroyOutputBuffer();
    }

    public beforeFill(): void {
        this._ensureOutputBuffer();
    }

    public abortRead(): void {
        this._aborted = true;
        this._ready = false;
        this._failed = false;
        this._unread = false;
        if (!this._mapTimer && !this._mapping) {
            this.pending = false;
        }
    }

    /**
     * Copy compute output into the MAP_READ staging buffer and start mapAsync
     * after the frame encoder is submitted (same deferral as PlayCanvas
     * `StorageBuffer.read`).
     */
    public beginRead(): void {

        if (this._mapTimer || this._mapping) {
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
        this._ensureStaging();

        const output = this.outputBuffer;
        const staging = this._staging;
        if (!output || !staging) {
            this.pending = false;
            return;
        }

        const bytes = count * 4;
        staging.copy(output, 0, 0, bytes);

        this._unread = true;
        this.pending = true;

        this._mapTimer = setTimeout(this._onMapTimeout);
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
        this._unread = false;
        this._ready = false;
        this.pending = false;
        return count;
    }

    /**
     * Hands the mapped scratch to the caller and recycles `recycle` as the
     * next map target. No 256×128 copy when lengths match.
     */
    public stealReady(recycle: Float32Array): Float32Array | null {
        const count = this._pixelCount;
        if (count <= 0 || !this._ready || recycle.length < count) {
            return null;
        }

        const out = this._scratch;
        this._scratch = recycle.length === count ? recycle : new Float32Array(count);
        this._unread = false;
        this._ready = false;
        this.pending = false;
        return out;
    }

    private _finishGpu(unmap: GPUBuffer | null) {

        this._mapping = false;

        if (unmap) {
            try {
                unmap.unmap();
            }
            catch {
                // device lost / already unmapped
            }
        }

        this.pending = false;
        this._unread = false;
        this._ready = false;

        if (this._dead) {
            this._destroyStaging();
            this._destroyOutputBuffer();
        }
    }

    private _startMap() {

        const staging = this._staging;
        const gpuBuffer = staging?.impl?.buffer as GPUBuffer | undefined;
        const count = this._pixelCount;

        if (!gpuBuffer || count <= 0) {
            this._failed = true;
            this._finishGpu(null);
            return;
        }

        this._mapping = true;
        this._mappedGpu = gpuBuffer;
        gpuBuffer.mapAsync(GPUMapMode.READ).then(this._onMapSuccess, this._onMapFail);
    }

    private _finishMapSuccess() {

        const gpuBuffer = this._mappedGpu;
        this._mappedGpu = null;
        const count = this._pixelCount;
        const bytes = count * 4;

        if (!gpuBuffer || this._dead || this._aborted || gpuBuffer !== (this._staging?.impl?.buffer as GPUBuffer | undefined)) {
            this._finishGpu(gpuBuffer);
            return;
        }

        this._scratch.set(new Float32Array(gpuBuffer.getMappedRange(0, bytes)));
        gpuBuffer.unmap();
        this._mapping = false;
        this._ready = true;
    }

    private _ensureOutputBuffer() {
        if (!this.outputBuffer || !this.outputBuffer.impl?.buffer) {
            this._destroyOutputBuffer();
            this._createOutputBuffer();
        }
    }

    private _ensureStaging() {
        if (!this._staging || !this._staging.impl?.buffer) {
            this._destroyStaging();
            this._createStaging();
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

    private _createStaging() {
        const bytes = this._pixelCount * 4;
        if (bytes <= 0) {
            this._staging = null;
            return;
        }

        this._staging = new pc.StorageBuffer(
            this._device,
            bytes,
            pc.BUFFERUSAGE_READ | pc.BUFFERUSAGE_COPY_DST,
            false
        );
    }

    private _destroyStaging() {
        this._staging?.destroy();
        this._staging = null;
    }
}
