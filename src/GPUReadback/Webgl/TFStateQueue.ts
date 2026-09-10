import pc from "../../engine.js";
import { TFState } from "./TFState.js";

export type TTFSlotFactory<TSlot extends TFState> = (
    device: pc.WebglGraphicsDevice,
    elementCount: number
) => TSlot;

/**
 * In-flight queue for WebGL2 TF readback without stalling on `clientWaitSync`.
 *
 * Used by coverage pack and HZB flag download.
 *
 * Flow:
 *  - `acquire()` → a slot, only on a capture tick ({@link readbackPeriod})
 *  - TF writes into `slot.outputBuffer`
 *  - `slot.beginRead()` → `copyBufferSubData` + fence
 *  - `frameUpdate()` → `harvest()` every tick: FIFO, one poll, no wait
 *  - if `poll()` is `"ready"` and {@link minReadbackLag} has elapsed → `_commit(slot)`
 *
 * {@link readbackPeriod} is the capture cadence: unread STREAM_READ captures
 * do not pile up in flight.
 */
export abstract class TFStateQueue<TSlot extends TFState = TFState> {

    protected _device: pc.WebglGraphicsDevice;
    protected _elementCount = 0;
    protected _slotCount = 4;
    protected _minReadbackLag = 2;
    protected _readbackPeriod = 1;
    protected _frameId = 0;
    protected _captureTick = 0;
    protected _submitFrame = -1;
    protected _slots: TSlot[] = [];

    public constructor(device: pc.WebglGraphicsDevice, slotCount: number) {
        this._device = device;
        this._slotCount = Math.max(2, slotCount | 0);
    }

    public get frameId() { return this._frameId; }

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

    protected abstract _createSlot(device: pc.WebglGraphicsDevice, elementCount: number): TSlot;

    /**
     * True when the next {@link acquire} would return a slot.
     * Does not consume a capture tick — call {@link acquire} to take the slot
     * (and to advance {@link readbackPeriod}).
     */
    public canAcquire(): boolean {
        return this._peekFreeSlot() !== null;
    }

    protected _resize(elementCount: number) {
        this._elementCount = Math.max(0, elementCount | 0);
        this._submitFrame = -1;
        this._onResize(this._elementCount);
        this._rebuildSlots();
    }

    public destroy() {
        this._disposeSlots();
        this._submitFrame = -1;
        this._onDestroy();
    }

    public onContextLost() {
        for (let i = 0; i < this._slots.length; i++) {
            this._slots[i].onContextLost();
        }
        this._submitFrame = -1;
        this._onContextLost();
    }

    public frameUpdate(_dt: number) {
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

        if (!this._commit(slot)) {
            slot.abortRead();
        }
    }

    /**
     * Free slot for a pack this frame. The returned slot is {@link TFState.reserved}
     * until {@link submit} or the caller clears `reserved`.
     * `null` if this is not a capture tick, a slot was already submitted this
     * frame, or every slot is busy.
     *
     * A non-capture tick still advances {@link readbackPeriod}. A capture tick
     * with no free slot does **not** — so a later attempt can still pack once
     * harvest frees a PBO.
     */
    public acquire(): TSlot | null {
        if (this._submitFrame === this._frameId) {
            return null;
        }

        const isCapture = (this._captureTick % this._readbackPeriod) === 0;
        if (!isCapture) {
            this._captureTick++;
            return null;
        }

        const slot = this._physicalFreeSlot();
        if (!slot) {
            return null;
        }

        this._captureTick++;
        slot.reserved = true;
        return slot;
    }

    /**
     * Finish the slot: copy into the PBO and insert a fence.
     * Returns `true` if the readback was scheduled.
     */
    public submit(slot: TSlot, copyCount?: number): boolean {
        slot.reserved = false;
        slot.submitFrame = this._frameId;
        slot.beginRead(copyCount);

        if (!slot.pending) {
            return false;
        }

        this._submitFrame = this._frameId;
        return true;
    }

    protected _commit(_slot: TSlot): boolean {
        return false;
    }

    protected _onResize(_elementCount: number): void {
    }

    protected _onDestroy(): void {
    }

    protected _onContextLost(): void {
    }

    protected _onSlotsDisposed(): void {
    }

    private _peekFreeSlot(): TSlot | null {
        if (this._submitFrame === this._frameId) {
            return null;
        }

        // Next acquire treats `(captureTick % period) === 0` as a capture.
        if ((this._captureTick % this._readbackPeriod) !== 0) {
            return null;
        }

        return this._physicalFreeSlot();
    }

    private _physicalFreeSlot(): TSlot | null {
        const slots = this._slots;
        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            if (!slot.pending && !slot.unread && !slot.reserved) {
                return slot;
            }
        }
        return null;
    }

    private _rebuildSlots() {
        this._disposeSlots();

        const n = this._slotCount;
        const count = this._elementCount;
        this._slots = new Array(n);
        for (let i = 0; i < n; i++) {
            this._slots[i] = this._createSlot(this._device, count);
        }
    }

    private _disposeSlots() {
        this._onSlotsDisposed();
        for (let i = 0; i < this._slots.length; i++) {
            this._slots[i].destroy();
        }
        this._slots.length = 0;
    }
}
