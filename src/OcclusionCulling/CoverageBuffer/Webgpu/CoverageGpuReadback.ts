import pc from "../../../engine.js";
import type { ICoverageReadbackStats } from "../ICoverageBuffer.js";
import { CoverageGpuReadbackState } from "./CoverageGpuReadbackState.js";

/**
 * In-flight coverage readbacks. Compute writes {@link outputBuffer}, then
 * {@link submit} copies into a slot's staging buffer. `mapAsync` starts as
 * soon as the frame holding that copy has been submitted, and {@link frameUpdate}
 * retries any slot that is not mapping yet. The newest ready slot is copied
 * into {@link cpuDepth} once {@link minReadbackLag} has elapsed. The next pack
 * takes any free slot, and only on a capture tick ({@link readbackPeriod}).
 *
 * Do not harvest from `capture` / postrender.
 */
export class CoverageGpuReadback {

    private _device: pc.WebgpuGraphicsDevice;
    private _slots: CoverageGpuReadbackState[] = [];
    private _output: pc.StorageBuffer | null = null;
    private _pixelCount = 0;
    private _slotCount = 5;
    private _minReadbackLag = 2;
    private _readbackPeriod = 1;
    private _captureTick = 0;
    private _frameId = 0;
    private _submitFrame = -1;
    private _cpuDepth: Float32Array;
    private _cpuVP = new Float32Array(16);
    private _cpuParams = new Float32Array(4);
    private _cpuWidth = 0;
    private _cpuHeight = 0;
    private _cpuReady = false;
    private _cpuVersion = 0;
    private _stats: ICoverageReadbackStats = {
        packMs: 0,
        readMs: 0,
        latencyMs: 0,
        latencyFrames: 0
    };

    /** Shared pack target (`STORAGE | COPY_SRC`). Staging slots copy out of this. */
    public get outputBuffer() { return this._output; }

    constructor(device: pc.WebgpuGraphicsDevice, pixelCount: number, slotCount: number = 5) {
        this._device = device;
        const count = Math.max(0, pixelCount | 0);
        this._pixelCount = count;
        this._slotCount = Math.max(2, slotCount | 0);
        this._resetCpu(count);
        this._createOutput();
        this._createSlots();
    }

    /** In-flight staging slots. Clamped to at least `2`. */
    public get slotCount() { return this._slotCount; }
    public set slotCount(value: number) {
        const next = Math.max(2, value | 0);
        if (next === this._slotCount) {
            return;
        }
        this._slotCount = next;
        this._submitFrame = -1;
        this._disposeSlots();
        this._createSlots();
    }

    public get cpuReady() { return this._cpuReady; }
    public get cpuVersion() { return this._cpuVersion; }
    public get cpuDepth() { return this._cpuDepth; }
    public get cpuViewProjection() { return this._cpuVP; }
    public get cpuCameraParams() { return this._cpuParams; }
    public get stats() { return this._stats; }

    /** Width of the harvested map. `0` before the first one and after a resize. */
    public get cpuWidth() { return this._cpuWidth; }

    /** Height of the harvested map. `0` before the first one and after a resize. */
    public get cpuHeight() { return this._cpuHeight; }

    public get minReadbackLag() { return this._minReadbackLag; }
    public set minReadbackLag(value: number) {
        this._minReadbackLag = Math.max(0, value | 0);
    }

    /**
     * Submit a packed capture every N {@link acquire} attempts while a slot
     * is free. Harvest still polls every {@link frameUpdate}. Default `1`.
     */
    public get readbackPeriod() { return this._readbackPeriod; }
    public set readbackPeriod(value: number) {
        this._readbackPeriod = Math.max(1, value | 0);
    }

    /**
     * Rebuild the ring and {@link outputBuffer} for a new packed size. A call
     * that leaves the pixel count alone is ignored: both depend on the pack
     * size, not on the screen, so a window resize keeps its in-flight captures
     * and the last published one instead of dropping coverage for a few frames
     * every time the depth source changes size.
     */
    public resize(pixelCount: number) {
        const count = Math.max(0, pixelCount | 0);
        if (count === this._pixelCount) {
            return;
        }

        this._submitFrame = -1;
        this._pixelCount = count;
        this._disposeSlots();
        this._destroyOutput();
        this._resetCpu(count);
        this._cpuVersion++;
        this._createOutput();
        this._createSlots();
    }

    public destroy() {
        this._disposeSlots();
        this._destroyOutput();
        this._cpuReady = false;
        this._submitFrame = -1;
    }

    public frameUpdate(_dt: number) {
        this._frameId++;
        this.harvest();
    }

    /**
     * Publish the newest ready capture and retire the older ones.
     *
     * Every capture replaces the whole depth map, so an older one is only
     * staler. Draining FIFO would pin the latency at {@link slotCount} — once
     * the ring is full each tick frees exactly one slot and the next pack
     * refills it, so the oldest capture never gets any younger.
     */
    public harvest() {
        const slots = this._slots;
        const frameId = this._frameId;
        const minReadbackLag = this._minReadbackLag;

        // Retry for slots whose `beginRead` timer fired before the frame was
        // submitted. `kickMap` gates itself on the device submit counter, so
        // this is a no-op for everything already mapping.
        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            if (slot.pending) {
                slot.kickMap();
            }
        }

        let newest: CoverageGpuReadbackState | null = null;

        for (let i = 0; i < slots.length; i++) {

            const slot = slots[i];

            if (!slot.pending || frameId - slot.submitFrame < minReadbackLag) {
                continue;
            }

            const status = slot.poll();

            if (status === "failed") {
                slot.abortRead();
                continue;
            }

            if (status !== "ready") {
                continue;
            }

            if (!newest || slot.submitFrame > newest.submitFrame) {
                newest = slot;
            }
        }

        if (!newest) {
            return;
        }

        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            if (slot !== newest && slot.pending && slot.submitFrame < newest.submitFrame) {
                slot.abortRead();
            }
        }

        // The only CPU copy runs inside `read`, so this interval is the whole cost.

        const copyStart = performance.now();
        const count = newest.read(this._cpuDepth);
        const now = performance.now();
        const readMs = now - copyStart;
        const n = newest.width * newest.height;
        if (count <= 0 || n <= 0 || count !== n) {
            newest.abortRead();
            return;
        }

        this._cpuWidth = newest.width;
        this._cpuHeight = newest.height;
        this._cpuVP.set(newest.vp);
        this._cpuParams.set(newest.cameraParams);
        this._cpuReady = true;
        this._cpuVersion++;

        const stats = this._stats;
        stats.readMs = readMs;
        stats.latencyMs = newest.submitTime > 0 ? now - newest.submitTime : 0;
        stats.latencyFrames = frameId - newest.submitFrame;
    }

    /**
     * A free staging slot on a capture tick, or `null`. A skipped tick advances
     * the period. A full ring does not. The slot stays
     * {@link CoverageGpuReadbackState.reserved} until {@link submit} or {@link release}.
     * The period counts the capture in {@link submit}, so a released slot is not a capture.
     */
    public acquire(): CoverageGpuReadbackState | null {
        if (this._submitFrame === this._frameId) {
            return null;
        }

        if ((this._captureTick % this._readbackPeriod) !== 0) {
            this._captureTick++;
            return null;
        }

        const slots = this._slots;
        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            if (!slot.pending && !slot.reserved) {
                slot.reserved = true;
                return slot;
            }
        }

        return null;
    }

    /** Give back a slot taken by {@link acquire} without packing it. */
    public release(slot: CoverageGpuReadbackState): void {
        slot.reserved = false;
    }

    public submit(
        slot: CoverageGpuReadbackState,
        vp: Float32Array,
        cameraParams: Float32Array,
        pixelCount?: number
    ): boolean {
        const output = this._output;
        if (!output || !slot.beginRead(output, pixelCount)) {
            slot.reserved = false;
            return false;
        }

        slot.vp.set(vp);
        slot.cameraParams.set(cameraParams);
        slot.submitFrame = this._frameId;
        this._submitFrame = this._frameId;
        this._captureTick++;
        return true;
    }

    private _resetCpu(pixelCount: number) {
        this._cpuDepth = new Float32Array(pixelCount);
        this._cpuDepth.fill(1e10);
        this._cpuWidth = 0;
        this._cpuHeight = 0;
        this._cpuReady = false;
    }

    private _createSlots() {
        const n = this._slotCount;
        this._slots = new Array(n);
        for (let i = 0; i < n; i++) {
            this._slots[i] = new CoverageGpuReadbackState(this._device, this._pixelCount);
        }
    }

    private _disposeSlots() {
        for (let i = 0; i < this._slots.length; i++) {
            this._slots[i].destroy();
        }
        this._slots.length = 0;
    }

    private _createOutput() {
        const bytes = this._pixelCount * 4;
        if (bytes <= 0) {
            this._output = null;
            return;
        }

        this._output = new pc.StorageBuffer(
            this._device,
            bytes,
            pc.BUFFERUSAGE_COPY_SRC
        );
    }

    private _destroyOutput() {
        this._output?.destroy();
        this._output = null;
    }
}
