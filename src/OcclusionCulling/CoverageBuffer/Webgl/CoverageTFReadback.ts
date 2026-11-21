import pc from "../../../engine.js";
import { TFStateQueue } from "../../../GPUReadback/Webgl/TFStateQueue.js";
import type { ICoverageReadbackStats } from "../ICoverageBuffer.js";
import { CoverageTFState } from "./CoverageTFState.js";

/**
 * Coverage ring. Pack writes a slot, {@link TFStateQueue.submit} copies it into
 * the PBO, and {@link TFStateQueue.frameRender} publishes the newest finished
 * map into {@link cpuDepth}. The next pack takes any free slot, and only on a
 * capture tick ({@link TFStateQueue.readbackPeriod}).
 *
 * Do not harvest from `capture` / postrender.
 */
export class CoverageTFReadback extends TFStateQueue<CoverageTFState> {

    private _cpuDepth: Float32Array;
    private _cpuVP = new Float32Array(16);
    private _cpuParams = new Float32Array(4);
    private _cpuWidth = 0;
    private _cpuHeight = 0;
    private _cpuReady = false;
    private _cpuFrame = 0;
    private _cpuVersion = 0;
    private _stats: ICoverageReadbackStats = {
        packMs: 0,
        readMs: 0,
        latencyMs: 0,
        latencyFrames: 0
    };

    public constructor(device: pc.WebglGraphicsDevice, pixelCount: number, slotCount: number = 2) {
        super(device, slotCount);
        this._resize(Math.max(0, pixelCount | 0));
    }

    /** A map is published and no older than {@link TFStateQueue.maxResultAge}. */
    public get cpuReady() { return this._cpuReady && this._isFresh(this._cpuFrame); }
    public get cpuVersion() { return this._cpuVersion; }
    public get cpuDepth() { return this._cpuDepth; }
    public get cpuViewProjection() { return this._cpuVP; }
    public get cpuCameraParams() { return this._cpuParams; }
    public get stats() { return this._stats; }

    /** Width of the harvested map. `0` before the first one and after a resize. */
    public get cpuWidth() { return this._cpuWidth; }

    /** Height of the harvested map. `0` before the first one and after a resize. */
    public get cpuHeight() { return this._cpuHeight; }

    /**
     * Rebuild the ring for a new packed size. A call that leaves the pixel
     * count alone is ignored: the ring depends on the pack size, not on the
     * screen, so a window resize keeps its in-flight captures and the last
     * published one instead of dropping coverage for a few frames every time
     * the depth source changes size.
     *
     * A device restore also lands here with an unchanged count and needs no
     * rebuild — {@link CoverageTFState.onDeviceLost} drops the PBO for
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

    protected override _createSlot(device: pc.WebglGraphicsDevice, elementCount: number): CoverageTFState {
        return new CoverageTFState(device, elementCount);
    }

    /**
     * Newest eligible map. Every slot is a full depth map, so an older one has
     * nothing the newest lacks. FIFO would keep the ring full after a stall —
     * one slot freed and one captured per frame — and pin the published map
     * at {@link TFStateQueue.slotCount} frames instead of {@link TFStateQueue.minReadbackLag}.
     */
    protected override _pickSlot(): CoverageTFState | null {
        const slots = this._slots;
        let newest: CoverageTFState | null = null;
        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            if (this._isEligible(slot) && (!newest || slot.submitFrame > newest.submitFrame)) {
                newest = slot;
            }
        }
        return newest;
    }

    /**
     * Drop maps older than the one about to be published. A newer map replaces
     * them, so they must not keep a slot busy.
     */
    protected override _dropSuperseded(picked: CoverageTFState): void {
        const slots = this._slots;
        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            if (slot !== picked && slot.pending && slot.submitFrame < picked.submitFrame) {
                slot.abortRead();
            }
        }
    }

    protected override _commit(slot: CoverageTFState): boolean {
        const t0 = performance.now();
        const count = slot.read(this._cpuDepth);
        const now = performance.now();
        const n = slot.width * slot.height;
        if (count <= 0 || n <= 0 || count !== n) {
            return false;
        }

        this._cpuWidth = slot.width;
        this._cpuHeight = slot.height;
        this._cpuVP.set(slot.vp);
        this._cpuParams.set(slot.cameraParams);
        this._cpuReady = true;
        this._cpuFrame = slot.submitFrame;
        this._cpuVersion++;

        const stats = this._stats;
        stats.readMs = now - t0;
        stats.latencyMs = slot.submitTime > 0 ? now - slot.submitTime : 0;
        stats.latencyFrames = this._frameId - slot.submitFrame;
        return true;
    }

    protected override _onResize(elementCount: number): void {
        this._resetCpu(elementCount);
    }

    protected override _onDestroy(): void {
        this._cpuReady = false;
    }

    protected override _onDeviceLost(): void {
        this._cpuReady = false;
    }

    private _resetCpu(pixelCount: number) {
        this._cpuDepth = new Float32Array(pixelCount);
        this._cpuDepth.fill(1e10);
        this._cpuWidth = 0;
        this._cpuHeight = 0;
        this._cpuReady = false;
    }
}
