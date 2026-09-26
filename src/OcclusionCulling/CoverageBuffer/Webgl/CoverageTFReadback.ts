import pc from "../../../engine.js";
import { TFState } from "../../../GPUReadback/Webgl/TFState.js";
import { TFStateQueue } from "../../../GPUReadback/Webgl/TFStateQueue.js";

/**
 * In-flight coverage TF readbacks. Pack writes a slot's `outputBuffer`, then
 * {@link TFStateQueue.submit} copies into that slot's STREAM_READ PBO and
 * inserts a fence. {@link TFStateQueue.frameUpdate} copies the newest ready
 * slot into {@link cpuDepth} once {@link TFStateQueue.minReadbackLag} has
 * elapsed — one `getBufferSubData` per tick. The next pack takes any free slot.
 *
 * Do not harvest from `captureDepthGrab` / `captureSceneDepthMap` / postrender.
 */
export class CoverageTFReadback extends TFStateQueue<TFState> {

    private _cpuDepth: Float32Array;
    private _cpuVP = new Float32Array(16);
    private _cpuParams = new Float32Array(4);
    private _cpuReady = false;
    private _cpuVersion = 0;

    public constructor(device: pc.WebglGraphicsDevice, pixelCount: number, slotCount: number = 5) {
        super(device, slotCount);
        this._resize(Math.max(0, pixelCount | 0));
    }

    public get cpuReady() { return this._cpuReady; }
    public get cpuVersion() { return this._cpuVersion; }
    public get cpuDepth() { return this._cpuDepth; }
    public get cpuViewProjection() { return this._cpuVP; }
    public get cpuCameraParams() { return this._cpuParams; }

    /**
     * Rebuild the ring for a new packed size. A call that leaves the pixel
     * count alone is ignored: the ring depends on the pack size, not on the
     * screen, so a window resize keeps its in-flight captures and the last
     * published one instead of dropping coverage for a few frames every time
     * the depth source changes size.
     *
     * Context restore also lands here with an unchanged count and needs no
     * rebuild — {@link TFState.onContextLost} drops the fence and PBO for
     * `beginRead` to recreate, and the engine restores `outputBuffer` before
     * it fires `devicerestored`.
     */
    public resize(pixelCount: number) {
        const count = Math.max(0, pixelCount | 0);
        if (count === this._elementCount) {
            return;
        }

        this._resize(count);
        this._cpuVersion++;
    }

    protected override _createSlot(device: pc.WebglGraphicsDevice, elementCount: number): TFState {
        return new TFState(device, elementCount, "float32");
    }

    /**
     * Newest wins, unlike the FIFO base. Every coverage slot holds the same
     * full depth map, so an older capture has nothing unique to contribute.
     * Draining oldest-first keeps the ring full once a stall has filled it —
     * one slot freed and one captured per frame — which pins the published
     * capture at {@link TFStateQueue.slotCount} frames old instead of
     * {@link TFStateQueue.minReadbackLag}.
     *
     * Still one `getBufferSubData` per tick: only the published slot is read.
     * Retiring the older ones is free — `abortRead` just drops their fence.
     */
    public override harvest() {

        const slots = this._slots;
        const frameId = this._frameId;
        const minReadbackLag = this._minReadbackLag;

        let newest: TFState | null = null;

        for (let i = 0; i < slots.length; i++) {

            const slot = slots[i];

            if (!slot.pending || frameId - slot.submitFrame < minReadbackLag) {
                continue;
            }

            // `poll` is idempotent; a ready fence is consumed only by `read`.
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

        if (!this._commit(newest)) {
            newest.abortRead();
        }
    }

    protected override _commit(slot: TFState): boolean {
        if (slot.read(this._cpuDepth) <= 0) {
            return false;
        }

        this._cpuVP.set(slot.vp);
        this._cpuParams.set(slot.cameraParams);
        this._cpuReady = true;
        this._cpuVersion++;
        return true;
    }

    protected override _onResize(elementCount: number): void {
        this._resetCpu(elementCount);
    }

    protected override _onDestroy(): void {
        this._cpuReady = false;
    }

    protected override _onContextLost(): void {
        this._cpuReady = false;
    }

    private _resetCpu(pixelCount: number) {
        this._cpuDepth = new Float32Array(pixelCount);
        this._cpuDepth.fill(1e10);
        this._cpuReady = false;
    }
}
