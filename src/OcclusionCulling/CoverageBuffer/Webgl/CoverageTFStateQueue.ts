import pc from "../../../engine.js";
import { TFState } from "../../../GPUReadback/Webgl/TFState.js";
import { TFStateQueue } from "../../../GPUReadback/Webgl/TFStateQueue.js";

/**
 * In-flight queue for coverage TF readback without waiting on the fence.
 *
 * Flow:
 *  - `acquire()` → a slot, only on a capture tick ({@link readbackPeriod})
 *  - TF writes into `slot.outputBuffer`
 *  - `slot.beginRead()` → `copyBufferSubData` + fence
 *  - `frameUpdate()` → `harvest()` every tick: newest ready capture, no wait
 *  - if `poll()` is `"ready"` and {@link minReadbackLag} has elapsed → `read()`
 *    into the CPU buffer; older ready slots are dropped after that commit
 *
 * A coverage slot is a full depth map, so a newer capture replaces older ones.
 * HZB stays on the base FIFO harvest: each HZB slot is a different AABB queue
 * and must not be skipped.
 *
 * Pending (unsignaled) slots are left alone — aborting them would rewrite
 * `outputBuffer` while `copyBufferSubData` may still be in flight.
 *
 * {@link readbackPeriod} is the capture cadence: the downsample chain is not
 * drawn idle, and unread STREAM_READ captures do not pile up in flight.
 */
export class CoverageTFStateQueue extends TFStateQueue<TFState> {

    private _cpuDepth: Float32Array;
    private _cpuVP = new Float32Array(16);
    private _cpuParams = new Float32Array(4);
    private _cpuReady = false;
    private _cpuVersion = 0;
    private _committedSubmitFrame = -1;

    public constructor(device: pc.WebglGraphicsDevice, pixelCount: number, slotCount: number = 4) {
        super(device, slotCount);
        this.resize(pixelCount);
    }

    public get cpuReady() { return this._cpuReady; }
    public get cpuVersion() { return this._cpuVersion; }
    public get cpuDepth() { return this._cpuDepth; }
    public get cpuViewProjection() { return this._cpuVP; }
    public get cpuCameraParams() { return this._cpuParams; }

    /**
     * Newest ready slot whose {@link minReadbackLag} has elapsed.
     * Older ready captures are dropped after a successful commit; in-flight
     * copies are not. Stale ready slots (older than the CPU depth) are
     * dropped even before the lag, so they do not pin the pool.
     *
     * `poll()` is idempotent: a `"ready"` fence is consumed only by `read()`
     * or `abortRead()`. Older ready candidates are not dropped until the
     * newest `_commit` succeeds, so they remain available next tick.
     */
    public override harvest() {

        const slots = this._slots;
        const minReadbackLag = this._minReadbackLag;
        const frameId = this._frameId;
        let committed = this._committedSubmitFrame;

        let newest = -1;

        for (let i = 0; i < slots.length; i++) {

            const slot = slots[i];

            if (!slot.pending) {
                continue;
            }

            const stale = slot.submitFrame <= committed;
            if (!stale && frameId - slot.submitFrame < minReadbackLag) {
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

            if (stale) {
                slot.abortRead();
                continue;
            }

            if (newest < 0 || slot.submitFrame > slots[newest].submitFrame) {
                newest = i;
            }
        }

        if (newest < 0) {
            return;
        }

        const slot = slots[newest];
        if (!this._commit(slot)) {
            slot.abortRead();
            return;
        }

        committed = slot.submitFrame;
        this._committedSubmitFrame = committed;

        for (let i = 0; i < slots.length; i++) {

            if (i === newest) {
                continue;
            }

            const other = slots[i];
            if (!other.pending || other.submitFrame > committed) {
                continue;
            }

            const status = other.poll();
            if (status === "pending") {
                continue;
            }

            other.abortRead();
        }
    }

    protected override _createSlot(device: pc.WebglGraphicsDevice, elementCount: number): TFState {
        return new TFState(device, elementCount, "float32");
    }

    protected override _commit(slot: TFState): boolean {
        const copied = slot.read(this._cpuDepth);
        if (copied <= 0) {
            return false;
        }
        this._cpuVP.set(slot.vp);
        this._cpuParams.set(slot.cameraParams);
        this._cpuReady = true;
        this._cpuVersion++;
        return true;
    }

    protected override _onResize(elementCount: number): void {
        this._cpuDepth = new Float32Array(elementCount);
        this._cpuDepth.fill(1e10);
        this._cpuReady = false;
        this._cpuVersion++;
        this._committedSubmitFrame = -1;
    }

    protected override _onDestroy(): void {
        this._cpuReady = false;
        this._committedSubmitFrame = -1;
    }

    protected override _onContextLost(): void {
        this._cpuReady = false;
        this._committedSubmitFrame = -1;
    }

    public resize(pixelCount: number) {
        this._resize(pixelCount);
    }
}
