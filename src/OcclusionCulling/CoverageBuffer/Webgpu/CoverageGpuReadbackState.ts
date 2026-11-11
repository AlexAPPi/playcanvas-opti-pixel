import pc from "../../../engine.js";

export type TCoverageReadbackPoll = "pending" | "ready" | "failed";

/**
 * One in-flight coverage pack. Compute writes float view-space Z into a
 * shared storage buffer; {@link beginRead} copies that into this slot's
 * persistent `MAP_READ | COPY_DST` staging buffer. {@link kickMap} calls
 * `mapAsync` once that copy has been submitted. `MAP_READ` cannot be combined
 * with `STORAGE`.
 *
 * The staging buffer stays mapped until {@link read} copies the range out,
 * or until {@link abortRead}. `unmap()` detaches that `ArrayBuffer`.
 */
export class CoverageGpuReadbackState {

    public vp = new Float32Array(16);
    public cameraParams = new Float32Array(4);
    public submitFrame = 0;

    /** `performance.now()` when the readback was submitted. `0` until then. */
    public submitTime = 0;

    /** CPU milliseconds of the copy in {@link read}. `0` until that copy finishes. */
    public mapMs = 0;

    public pending = false;

    /** Packed map width for this capture. */
    public width = 0;

    /** Packed map height for this capture. */
    public height = 0;

    /** Held between `acquire` and `submit`. */
    public reserved = false;

    private _device: pc.WebgpuGraphicsDevice;
    private _staging: pc.StorageBuffer | null = null;
    private _pixelCount = 0;
    private _copyCount = 0;

    /** View of `getMappedRange`. Valid only while the staging buffer stays mapped. */
    private _mapped: Float32Array | null = null;
    private _readGen = 0;
    private _submitVersion = -1;
    private _kickTimer: number | null = null;
    private _onKickTimer: () => void;
    private _aborted = false;
    private _ready = false;
    private _mapStarted = false;

    constructor(device: pc.WebgpuGraphicsDevice, pixelCount: number) {
        this._device = device;
        this._onKickTimer = () => {
            this._kickTimer = null;
            if (this.pending) {
                this.kickMap();
            }
        };
        this.resize(pixelCount);
    }

    public get pixelCount() { return this._pixelCount; }

    public resize(pixelCount: number) {
        this.abortRead();
        // The dropped staging buffer may still have a mapAsync in flight.
        this._readGen++;
        this._pixelCount = Math.max(0, pixelCount | 0);
        this._copyCount = 0;
        this.width = 0;
        this.height = 0;
        this._destroyStaging();
        this.pending = false;
        this.reserved = false;
        this._mapStarted = false;
        this.submitFrame = 0;
        this._createStaging();
    }

    public destroy() {
        this._readGen++;
        if (this._kickTimer !== null) {
            clearTimeout(this._kickTimer);
            this._kickTimer = null;
        }
        this.abortRead();
        this._destroyStaging();
    }

    /**
     * Retire this capture without publishing it.
     * An in-flight `mapAsync` cannot be cancelled, so the slot stays
     * {@link pending} until it settles: copying into a buffer that is still
     * map-pending is a validation error. `_aborted` drops the data.
     */
    public abortRead(): void {

        const mapInFlight = this.pending && this._mapStarted && !this._ready;

        this._aborted = true;
        this._ready = false;
        this._dropMapping();

        if (mapInFlight) {
            return;
        }

        this._mapStarted = false;
        this.pending = false;
    }

    /**
     * Record a copy from the packed storage buffer into this slot's staging
     * buffer. Returns false when the slot is already in flight or the copy
     * was not recorded. The timer from the constructor calls {@link kickMap}
     * after this stack returns.
     */
    public beginRead(output: pc.StorageBuffer, pixelCount?: number): boolean {

        this.reserved = false;

        if (this.pending) {
            return false;
        }

        // A failed publish can leave the staging buffer mapped.
        this._dropMapping();

        const count = pixelCount == null
            ? this._pixelCount
            : Math.max(0, Math.min(this._pixelCount, pixelCount | 0));

        this._aborted = false;
        this._ready = false;
        this._mapStarted = false;
        this._readGen++;
        this.mapMs = 0;

        if (count <= 0 || !output) {
            return false;
        }

        this._ensureStaging();
        const staging = this._staging;
        if (!staging) {
            return false;
        }

        staging.copy(output, 0, 0, count * 4);
        this._copyCount = count;
        this._submitVersion = this._device.submitVersion;
        this.pending = true;
        this._kickTimer ??= setTimeout(this._onKickTimer, 0);
        return true;
    }

    /**
     * Start `mapAsync` once the copy has reached the queue.
     * A no-op until then, so it is safe to call every frame.
     * The staging buffer stays mapped; {@link read} copies that range out.
     */
    public kickMap(): void {

        if (!this.pending || this._mapStarted || this._ready) {
            return;
        }

        // The copy is still on the open encoder. Mapping it now makes the
        // later submit fail validation.
        if (this._device.submitVersion <= this._submitVersion) {
            return;
        }

        const gpu = this._gpuBuffer();
        if (!gpu) {
            this.pending = false;
            return;
        }

        this._mapStarted = true;
        void this._awaitMap(gpu, this._readGen, this._copyCount * 4);
    }

    public poll(): TCoverageReadbackPoll {
        if (this._ready) {
            return "ready";
        }
        return this.pending ? "pending" : "failed";
    }

    public read(dest: Float32Array, dstOffset: number = 0): number {

        const count = this._copyCount;
        const offset = dstOffset | 0;
        const mapped = this._mapped;

        if (count <= 0 || !this._ready || mapped == null || mapped.length < count ||
            offset < 0 || dest.length - offset < count) {
            return 0;
        }

        this._ready = false;
        this.pending = false;

        try {
            const t0 = performance.now();
            dest.set(mapped.subarray(0, count), offset);
            this.mapMs = performance.now() - t0;
            return count;
        } finally {
            this._dropMapping();
        }
    }

    private async _awaitMap(gpu: GPUBuffer, gen: number, bytes: number): Promise<void> {

        let mapped = false;
        try {
            await gpu.mapAsync(GPUMapMode.READ);
            mapped = true;
        } catch {
            // Device loss, or the staging buffer was destroyed.
        }

        if (gen !== this._readGen) {
            if (mapped) {
                this._unmap(gpu);
            }
            return;
        }

        this._mapStarted = false;

        if (!mapped || this._aborted) {
            if (mapped) {
                this._unmap(gpu);
            }
            this._mapped = null;
            this._ready = false;
            this.pending = false;
            return;
        }

        try {
            // A view, not a copy. `unmap()` detaches it.
            this._mapped = new Float32Array(gpu.getMappedRange(0, bytes));
            this._ready = true;
        } catch {
            this._unmap(gpu);
            this._mapped = null;
            this._ready = false;
            this.pending = false;
        }
    }

    private _gpuBuffer(): GPUBuffer | null {
        return (this._staging?.impl?.buffer as GPUBuffer | undefined) ?? null;
    }

    /** Drop the mapped view, then return the staging buffer to the GPU. */
    private _dropMapping() {
        this._mapped = null;
        this._unmap(this._gpuBuffer());
    }

    private _unmap(gpu: GPUBuffer | null) {
        if (!gpu || gpu.mapState !== "mapped") {
            return;
        }

        try {
            gpu.unmap();
        } catch {
            // Device loss, or the buffer was already destroyed.
        }
    }

    private _ensureStaging() {
        if (!this._staging?.impl?.buffer) {
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
