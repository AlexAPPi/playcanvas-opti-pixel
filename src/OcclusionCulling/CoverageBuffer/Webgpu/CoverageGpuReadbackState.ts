import pc from "../../../engine.js";

export type TCoverageReadbackPoll = "pending" | "ready" | "failed";

/**
 * One in-flight coverage pack. Compute writes float view-space Z into a
 * shared storage buffer; {@link beginRead} copies that into this slot's
 * persistent `MAP_READ | COPY_DST` staging buffer. {@link kickMap} calls
 * `mapAsync` on a later frame, after the copy has been submitted.
 * The staging buffer is not `STORAGE` — that combination cannot be mapped.
 */
export class CoverageGpuReadbackState {

    public vp = new Float32Array(16);
    public cameraParams = new Float32Array(4);
    public submitFrame = 0;
    public pending = false;
    /** Held between `acquire` and `submit`. */
    public reserved = false;

    private _device: pc.WebgpuGraphicsDevice;
    private _staging: pc.StorageBuffer | null = null;
    private _pixelCount = 0;
    private _scratch = new Float32Array(0);
    private _readGen = 0;
    private _submitVersion = -1;
    private _aborted = false;
    private _ready = false;
    private _failed = false;
    private _mapStarted = false;
    private _dead = false;

    constructor(device: pc.WebgpuGraphicsDevice, pixelCount: number) {
        this._device = device;
        this.resize(pixelCount);
    }

    public get pixelCount() { return this._pixelCount; }

    public resize(pixelCount: number) {
        this.abortRead();
        // The staging buffer goes away here, so ignore a map that is still
        // settling on the old one.
        this._readGen++;
        this._pixelCount = Math.max(0, pixelCount | 0);
        this._scratch = new Float32Array(this._pixelCount);
        this._destroyStaging();
        this.pending = false;
        this.reserved = false;
        this._mapStarted = false;
        this.submitFrame = 0;
        this._createStaging();
    }

    public destroy() {
        this._dead = true;
        this.abortRead();
        this._destroyStaging();
    }

    /**
     * Retire this capture without publishing it.
     *
     * An in-flight `mapAsync` cannot be cancelled, so the slot stays
     * {@link pending} until that promise settles — recording
     * `copyBufferToBuffer` on a staging buffer that is still map-pending is a
     * validation error. `_aborted` makes the handler drop the data.
     */
    public abortRead(): void {

        const mapInFlight = this.pending && this._mapStarted && !this._ready && !this._failed;

        this._aborted = true;
        this._failed = false;
        this._ready = false;
        this._unmap(this._gpuBuffer());

        if (mapInFlight) {
            return;
        }

        this._mapStarted = false;
        this.pending = false;
    }

    /**
     * Record a copy from the packed storage buffer into this slot's staging
     * buffer. Returns false if this slot is already in flight or the copy
     * was not recorded. Mapping is attempted once this stack returns, which in
     * the normal loop is after `frameEnd` has submitted the copy.
     */
    public beginRead(output: pc.StorageBuffer): boolean {

        this.reserved = false;

        if (this.pending) {
            return false;
        }

        const bytes = this._pixelCount * 4;
        this._aborted = false;
        this._failed = false;
        this._ready = false;
        this._mapStarted = false;
        this._readGen++;

        if (bytes <= 0 || !output) {
            this.pending = false;
            return false;
        }

        this._ensureStaging();
        const staging = this._staging;
        if (!staging) {
            this.pending = false;
            return false;
        }

        staging.copy(output, 0, 0, bytes);
        this._submitVersion = this._device.submitVersion;
        this.pending = true;

        const gen = this._readGen;
        setTimeout(() => {
            if (gen !== this._readGen || this._dead || !this.pending) {
                return;
            }
            this.kickMap();
        }, 0);

        return true;
    }

    /**
     * Start `mapAsync` once, but only after the copy has reached the queue.
     * A no-op until then, so it is safe to call every frame.
     * Resolving only fills scratch; `read()` publishes it.
     */
    public kickMap(): void {

        if (!this.pending || this._mapStarted || this._ready || this._failed) {
            return;
        }

        // Until the device submits, the copy is still on the open encoder and
        // mapping would turn that `copyBufferToBuffer` into a validation error.
        if (this._device.submitVersion <= this._submitVersion) {
            return;
        }

        const gpu = this._gpuBuffer();
        if (!gpu) {
            this._failed = true;
            this.pending = false;
            return;
        }

        this._mapStarted = true;
        const gen = this._readGen;
        const bytes = this._pixelCount * 4;

        gpu.mapAsync(GPUMapMode.READ).then(
            () => this._onMapOk(gen, gpu, bytes),
            () => this._onMapFail(gen)
        );
    }

    public poll(): TCoverageReadbackPoll {
        if (this._failed) { return "failed"; }
        if (this._ready) { return "ready"; }
        if (!this.pending) { return "failed"; }
        return "pending";
    }

    public read(dest: Float32Array, dstOffset: number = 0): number {
        const count = this._pixelCount;
        const offset = dstOffset | 0;
        if (count <= 0 || !this._ready || offset < 0 || dest.length - offset < count) {
            return 0;
        }

        dest.set(this._scratch.subarray(0, count), offset);
        this._ready = false;
        this._mapStarted = false;
        this.pending = false;
        return count;
    }

    private _onMapOk(gen: number, gpu: GPUBuffer, bytes: number) {

        if (gen !== this._readGen || this._dead) {
            this._unmap(gpu);
            return;
        }

        this._mapStarted = false;

        if (this._aborted) {
            this._unmap(gpu);
            this.pending = false;
            return;
        }

        try {
            this._scratch.set(new Float32Array(gpu.getMappedRange(0, bytes)));
            gpu.unmap();
        } catch {
            this._failed = true;
            this.pending = false;
            this._ready = false;
            return;
        }

        this._ready = true;
    }

    private _onMapFail(gen: number) {
        if (gen !== this._readGen || this._dead) {
            return;
        }
        this._mapStarted = false;
        this._failed = true;
        this.pending = false;
        this._ready = false;
    }

    private _gpuBuffer(): GPUBuffer | null {
        const gpu = this._staging?.impl?.buffer as GPUBuffer | null | undefined;
        return gpu ?? null;
    }

    private _unmap(gpu: GPUBuffer | null) {
        if (!gpu) {
            return;
        }
        try {
            if (gpu.mapState === "mapped") {
                gpu.unmap();
            }
        } catch {
            // Device loss, or the buffer was already destroyed.
        }
    }

    private _ensureStaging() {
        if (!this._staging || !this._staging.impl?.buffer) {
            this._destroyStaging();
            this._createStaging();
        }
    }

    private _createStaging() {
        const bytes = this._pixelCount * 4;
        if (bytes <= 0) {
            this._staging = null;
            return;
        }

        // MAP_READ cannot be combined with STORAGE. The 4th argument opts out.
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
