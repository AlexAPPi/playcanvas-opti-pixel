import pc from "../../engine.js";
import { TFState } from "./TFState.js";
import { WebglFrameFence } from "./WebglFrameFence.js";

/**
 * In-flight WebGL2 transform-feedback readbacks. Coverage pack and HZB flags
 * share this ring.
 *
 * The owner calls, every frame:
 * - {@link frameUpdate} on `frameupdate` — advances the frame counter.
 * - {@link frameRender} on `framerender` — publishes one slot. The only place
 *   `getBufferSubData` runs: after scripts, before PlayCanvas opens its GPU
 *   timer in `frameStart`.
 * - {@link frameEnd} on `frameend`, after this frame's capture — fences the frame.
 *
 * `acquire` takes a free slot on a capture tick. After TF writes its
 * `outputBuffer`, `submit` copies that into the slot PBO.
 *
 * A slot is copied out only once a fence inserted after its copy has signaled
 * (see {@link WebglFrameFence}). That is not the previous frame: Chromium
 * signals the fence two frames after {@link frameEnd}. Until then the slot
 * stays pending. Nothing forces a copy. A result that cannot be read in time
 * ages out instead ({@link maxResultAge}).
 *
 * The pick is FIFO: each HZB slot is a different AABB queue and must not be
 * skipped. Coverage overrides it — every slot is a full depth map, so the
 * newest one replaces the rest.
 *
 * {@link readbackPeriod} is the capture cadence, {@link slotCount} the ring
 * depth. A capture is skipped when every slot is still in flight.
 */
export abstract class TFStateQueue<TSlot extends TFState = TFState> {

    protected _device: pc.WebglGraphicsDevice;
    protected _elementCount = 0;
    protected _slotCount = 2;
    protected _minReadbackLag = 1;
    protected _readbackPeriod = 1;
    protected _maxResultAge = 10;
    protected _frameId = 0;
    protected _captureTick = 0;
    protected _submitFrame = -1;
    protected _slots: TSlot[] = [];

    /** Newest frame whose fence has signaled. `-1` until the first one. */
    private _coveredFrame = -1;
    private _frameFence: WebglFrameFence;
    private _deviceLostHandle: pc.EventHandle | null;

    public constructor(device: pc.WebglGraphicsDevice, slotCount: number) {
        this._device = device;
        this._slotCount = Math.max(2, slotCount | 0);
        this._frameFence = new WebglFrameFence(device);
        this._deviceLostHandle = device.on(pc.GraphicsDevice.EVENT_DEVICELOST, this.onDeviceLost, this);
    }

    public get frameId() { return this._frameId; }

    public get readbackPeriod() { return this._readbackPeriod; }
    public set readbackPeriod(value: number) {
        this._readbackPeriod = Math.max(1, value | 0);
    }

    /**
     * Frames from a capture to the earliest copy. `1` is the minimum, since the
     * frame fence goes in after the capture. Chromium signals that fence two
     * frames later, and the copy waits for it. A larger lag only adds latency,
     * and needs a ring of at least lag + 1 slots to keep capturing every frame.
     */
    public get minReadbackLag() { return this._minReadbackLag; }
    public set minReadbackLag(value: number) {
        this._minReadbackLag = Math.max(1, value | 0);
    }

    /**
     * Frames, counted from the capture, a published result stays valid. Past
     * that it reads as unknown. Never shorter than {@link minReadbackLag} +
     * {@link readbackPeriod}, the age a result reaches before the next capture
     * replaces it.
     */
    public get maxResultAge() { return this._maxResultAge; }
    public set maxResultAge(value: number) {
        this._maxResultAge = Math.max(1, value | 0);
    }

    /**
     * Ring depth, at least `2`. Coverage acquires after {@link frameRender}
     * frees a slot, so two are enough. HZB reserves its slot in
     * {@link frameUpdate}, before that free, and needs one more.
     */
    public get slotCount() { return this._slotCount; }
    public set slotCount(value: number) {
        const next = Math.max(2, value | 0);
        if (next === this._slotCount) {
            return;
        }
        this._slotCount = next;
        this._submitFrame = -1;
        this._rebuildSlots();
    }

    protected abstract _createSlot(device: pc.WebglGraphicsDevice, elementCount: number): TSlot;

    /** Copy the slot out and publish it. `false` aborts the slot. */
    protected abstract _commit(slot: TSlot): boolean;

    protected _resize(elementCount: number) {
        this._elementCount = Math.max(0, elementCount | 0);
        this._submitFrame = -1;
        this._onResize(this._elementCount);
        this._rebuildSlots();
    }

    public destroy() {
        this._deviceLostHandle?.off();
        this._deviceLostHandle = null;
        this._frameFence.destroy();
        this._disposeSlots();
        this._submitFrame = -1;
        this._onDestroy();
    }

    public onDeviceLost() {
        this._frameFence.onDeviceLost();
        this._coveredFrame = -1;
        for (let i = 0; i < this._slots.length; i++) {
            this._slots[i].onDeviceLost();
        }
        this._submitFrame = -1;
        this._onDeviceLost();
    }

    public frameUpdate(_dt: number) {
        this._frameId++;
    }

    /**
     * Publish one slot. Call on `framerender`: after scripts, before the GPU
     * timer. The copy runs only when a fence inserted after that slot's copy
     * has signaled; otherwise the slot waits for a later frame.
     */
    public frameRender(): void {
        this._coveredFrame = this._frameFence.signaledFrame();

        const slot = this._pickSlot();
        if (!slot) {
            return;
        }

        this._dropSuperseded(slot);

        if (!this._commit(slot)) {
            slot.abortRead();
        }
    }

    /**
     * Fence this frame. Call on `frameend`, once this frame's capture is
     * recorded. The fence goes in after the rest of this task.
     */
    public frameEnd(): void {
        this._frameFence.seal(this._frameId);
    }

    /**
     * Slot to publish next, or `null`. FIFO: the oldest pending slot, once it
     * is eligible. A younger slot never jumps it.
     */
    protected _pickSlot(): TSlot | null {
        const slots = this._slots;
        let oldest: TSlot | null = null;
        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            if (slot.pending && (!oldest || slot.submitFrame < oldest.submitFrame)) {
                oldest = slot;
            }
        }
        return oldest && this._isEligible(oldest) ? oldest : null;
    }

    /** Retire slots the pick makes useless. */
    protected _dropSuperseded(_picked: TSlot): void {
    }

    /**
     * Old enough for {@link minReadbackLag}, and covered by a fence that has
     * signaled. Chromium signals that fence two frames after it was inserted,
     * so the previous frame is not enough.
     */
    protected _isEligible(slot: TSlot): boolean {
        return slot.pending
            && slot.submitFrame <= this._coveredFrame
            && this._frameId - slot.submitFrame >= this._minReadbackLag;
    }

    /** True while a result captured on `submitFrame` is within {@link maxResultAge}. */
    protected _isFresh(submitFrame: number): boolean {
        const limit = Math.max(this._maxResultAge, this._minReadbackLag + this._readbackPeriod);
        return this._frameId - submitFrame <= limit;
    }

    protected _onResize(_elementCount: number): void {
    }

    protected _onDestroy(): void {
    }

    protected _onDeviceLost(): void {
    }

    protected _onSlotsDisposed(): void {
    }

    /**
     * Free slot for a pack this frame. The returned slot is {@link TFState.reserved}
     * until {@link submit} or {@link release}.
     * `null` if this is not a capture tick, a slot was already submitted this
     * frame, or every slot is busy.
     *
     * A non-capture tick still advances {@link readbackPeriod}. A capture tick
     * with no free slot does **not** — so a later attempt can still pack once
     * a slot is published.
     */
    public acquire(): TSlot | null {
        if (this._submitFrame === this._frameId) {
            return null;
        }

        if (!this._isCaptureTick()) {
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
     * Give back a slot taken by {@link acquire} without packing it. Refunds the
     * capture tick, so {@link readbackPeriod} does not count this as a capture.
     */
    public release(slot: TSlot): void {
        if (!slot.reserved) {
            return;
        }
        slot.reserved = false;
        this._refundCaptureTick();
    }

    /**
     * Finish the slot: copy its TF output into the PBO.
     * Returns `true` if the readback was scheduled.
     */
    public submit(slot: TSlot, copyCount?: number): boolean {
        slot.beginRead(copyCount);
        if (!slot.pending) {
            this._refundCaptureTick();
            return false;
        }

        slot.submitFrame = this._frameId;
        this._submitFrame = this._frameId;
        return true;
    }

    private _refundCaptureTick() {
        if (this._captureTick > 0) {
            this._captureTick--;
        }
    }

    private _isCaptureTick(): boolean {
        return (this._captureTick % this._readbackPeriod) === 0;
    }

    private _physicalFreeSlot(): TSlot | null {
        const slots = this._slots;
        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            if (!slot.pending &&
                !slot.reserved) {
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
