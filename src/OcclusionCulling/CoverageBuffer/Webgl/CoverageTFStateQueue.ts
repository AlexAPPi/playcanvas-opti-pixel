import pc from "../../../engine.js";
import { CoverageTFState } from "./CoverageTFState.js";

/**
 * In-flight queue for coverage TF readback without stalling on `clientWaitSync`.
 *
 * Flow:
 *  - `acquire()` → a slot, only on a capture tick ({@link readbackPeriod})
 *  - TF writes into `slot.outputBuffer`
 *  - `slot.beginRead()` → `copyBufferSubData` + fence
 *  - `frameUpdate()` → `harvest()` every tick: FIFO, one poll, no wait
 *  - if `poll()` is `"ready"` and {@link minReadbackLag} has elapsed → `read()` into the CPU buffer
 *
 * {@link readbackPeriod} is the capture cadence: the downsample chain is not
 * drawn idle, and unread STREAM_READ captures do not pile up in flight.
 */
export class CoverageTFStateQueue {

    private _device: pc.WebglGraphicsDevice;
    private _pixelCount = 0;
    private _slotCount = 4;
    private _minReadbackLag = 2;
    private _readbackPeriod = 1;
    private _frameId = 0;
    private _captureTick = 0;
    private _submitFrame = -1;
    private _slots: CoverageTFState[] = [];
    private _cpuDepth: Float32Array;
    private _cpuVP = new Float32Array(16);
    private _cpuParams = new Float32Array(4);
    private _cpuReady = false;
    private _cpuVersion = 0;

    public constructor(device: pc.WebglGraphicsDevice, pixelCount: number, slotCount: number = 4) {
        this._device = device;
        this._slotCount = Math.max(2, slotCount | 0);
        this.resize(pixelCount);
    }

    public get frameId() { return this._frameId; }
    public get cpuReady() { return this._cpuReady; }
    public get cpuVersion() { return this._cpuVersion; }
    public get cpuDepth() { return this._cpuDepth; }
    public get cpuViewProjection() { return this._cpuVP; }
    public get cpuCameraParams() { return this._cpuParams; }

    public get minReadbackLag() { return this._minReadbackLag; }
    public set minReadbackLag(value: number) {
        this._minReadbackLag = Math.max(0, value | 0);
    }

    public get slotCount() { return this._slotCount; }
    public set slotCount(value: number) {
        const next = Math.max(2, value | 0);
        if (next === this._slotCount) {
            return;
        }
        this._slotCount = next;
        this._rebuildSlots();
    }

    /**
     * Capture every N pack attempts. Harvest still polls every
     * {@link frameUpdate} so a finished fence is read on a different frame
     * than the next pack. `1` = every frame.
     */
    public get readbackPeriod() { return this._readbackPeriod; }
    public set readbackPeriod(value: number) {
        this._readbackPeriod = Math.max(1, value | 0);
    }

    /**
     * True when this tick will accept a new pack
     * (same predicate as {@link acquire}).
     */
    public canAcquire(): boolean {
        return this._findFreeSlot() !== null;
    }

    public resize(pixelCount: number) {
        this._pixelCount = Math.max(0, pixelCount | 0);
        this._cpuDepth = new Float32Array(this._pixelCount);
        this._cpuDepth.fill(1e10);
        this._cpuReady = false;
        this._cpuVersion++;
        this._submitFrame = -1;
        this._rebuildSlots();
    }

    public destroy() {
        this._disposeSlots();
        this._cpuReady = false;
        this._submitFrame = -1;
    }

    public onContextLost() {
        for (let i = 0; i < this._slots.length; i++) {
            this._slots[i].onContextLost();
        }
        this._cpuReady = false;
        this._submitFrame = -1;
    }

    public frameUpdate(dt: number) {
        this._frameId++;
        this.harvest();
    }

    /**
     * FIFO: poll the oldest eligible slot only. Never skip a fenced capture —
     * rewriting its PBO before getBufferSubData is what ANGLE warns about and
     * on Android turns the next read into a full GPU-process drain.
     */
    public harvest() {

        const slots = this._slots;
        const minReadbackLag = this._minReadbackLag;

        let oldest = -1;
        let oldestFrame = 0x7fffffff;

        for (let i = 0; i < slots.length; i++) {

            const slot = slots[i];

            if (!slot.pending) {
                continue;
            }

            if (this._frameId - slot.submitFrame < minReadbackLag) {
                continue;
            }

            if (slot.submitFrame < oldestFrame) {
                oldestFrame = slot.submitFrame;
                oldest = i;
            }
        }

        if (oldest < 0) {
            return;
        }

        const slot = slots[oldest];
        const status = slot.poll();

        if (status === "failed") {
            slot.abortRead();
            return;
        }

        if (status !== "ready") {
            return;
        }

        const copied = slot.read(this._cpuDepth);
        if (copied > 0) {
            this._cpuVP.set(slot.vp);
            this._cpuParams.set(slot.cameraParams);
            this._cpuReady = true;
            this._cpuVersion++;
        }
        else {
            slot.abortRead();
        }
    }

    /**
     * Free slot for a pack this frame.
     * `null` if this is not a capture tick, a slot was already submitted this
     * frame, or every slot is busy.
     */
    public acquire(): CoverageTFState | null {
        return this._findFreeSlot();
    }

    /**
     * Finish the slot: copy into the PBO and insert a fence.
     * Returns `true` if the readback was scheduled.
     */
    public submit(slot: CoverageTFState, vp: Float32Array, cameraParams: Float32Array): boolean {
        slot.vp.set(vp);
        slot.cameraParams.set(cameraParams);
        slot.submitFrame = this._frameId;
        slot.beginRead();

        if (!slot.pending) {
            return false;
        }

        this._submitFrame = this._frameId;
        return true;
    }

    private _isCaptureTick() {
        // Capture tick advances on acquire. Tick 1, 1+N, 1+2N, …
        // frameId (minReadbackLag) is incremented in frameUpdate.
        this._captureTick++;
        return ((this._captureTick - 1) % this._readbackPeriod) === 0;
    }

    private _findFreeSlot(): CoverageTFState | null {

        if (this._submitFrame === this._frameId) {
            return null;
        }

        if (!this._isCaptureTick()) {
            return null;
        }

        const slots = this._slots;
        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            if (!slot.pending && !slot.unread) {
                return slot;
            }
        }

        return null;
    }

    private _rebuildSlots() {
        this._disposeSlots();

        const n = this._slotCount;
        const pixels = this._pixelCount;
        this._slots = new Array(n);
        for (let i = 0; i < n; i++) {
            this._slots[i] = new CoverageTFState(this._device, pixels);
        }
    }

    private _disposeSlots() {
        for (let i = 0; i < this._slots.length; i++) {
            this._slots[i].destroy();
        }
        this._slots.length = 0;
    }
}
