import pc from "../../../engine.js";
import { IndexManager } from "../../../Extras/IndexManager.js";
import { TFStateQueue } from "../../../GPUReadback/Webgl/TFStateQueue.js";
import { HZBTFState } from "./HZBTFState.js";
import { OCCLUSION_OCCLUDED, OCCLUSION_UNKNOWN, OCCLUSION_VISIBLE, TOcclusionResult } from "../../IOcclusionCullingTester.js";

/**
 * HZB GPU->CPU flag download on the same PBO/fence slots as coverage.
 * Harvest stays FIFO: each slot is a different AABB queue and must not be skipped.
 *
 * A fill slot is reserved on {@link frameUpdate} (or the first {@link enqueue})
 * so AABB ids can be queued before {@link submitFill}. Harvest is FIFO, one
 * fence poll per tick, no `gl.flush()`.
 */
export class HZBTStateQueue extends TFStateQueue<HZBTFState> {

    private _fill: HZBTFState | null = null;
    private _fillAttemptFrame = -1;
    private _resultData: Uint32Array;
    private _resultGen: Uint32Array;
    private _resultEpoch = 1;
    private _hasResult = false;
    private _destroyHandle: pc.EventHandle;
    private _contextLostHandle: pc.EventHandle;

    public readonly indexManager: IndexManager;

    public constructor(
        device: pc.WebglGraphicsDevice,
        indexManager: IndexManager,
        slotCount: number = 4
    ) {
        super(device, slotCount);
        this.indexManager = indexManager;
        this.resize();
        this._destroyHandle = device.on("destroy", this.destroy, this);
        this._contextLostHandle = device.on("contextlost", this.onContextLost, this);
    }

    public get actual() { return this._fill; }

    protected override _createSlot(device: pc.WebglGraphicsDevice, _elementCount: number): HZBTFState {
        return new HZBTFState(device, this.indexManager);
    }

    public override frameUpdate(dt: number) {
        super.frameUpdate(dt);
        this._ensureFill();
    }

    public enqueue(index: number, extra?: number | number[]): number {
        return this._ensureFill()?.enqueue(index, extra) ?? -1;
    }

    public getData(index: number) {
        if (!this._isCurrentResult(index)) {
            return -1;
        }
        return this._resultData[index];
    }

    public getOcclusionStatus(index: number): TOcclusionResult {
        if (!this._isCurrentResult(index)) {
            return OCCLUSION_UNKNOWN;
        }

        // See shader function getFlags
        const value = this._resultData[index] & 0x3;
        if (value === 1) {
            return OCCLUSION_OCCLUDED;
        }

        return OCCLUSION_VISIBLE;
    }

    /**
     * Slot currently accepting {@link enqueue}. `null` until a capture tick
     * gives a free slot.
     */
    public get fillSlot(): HZBTFState | null {
        return this._fill;
    }

    /**
     * Copy TF flags into the PBO and insert a fence. Call after the fill
     * slot's transform feedback has written `outputBuffer`.
     */
    public submitFill(): boolean {
        const slot = this._fill;
        if (!slot || slot.count <= 0) {
            return false;
        }

        const copyCount = Math.min(
            slot.count,
            slot.packed.length,
            slot.outputBuffer ? slot.outputBuffer.numVertices : 0
        );
        if (copyCount <= 0) {
            this.releaseFill();
            return false;
        }

        const ok = this.submit(slot, copyCount);
        this._fill = null;
        return ok;
    }

    /**
     * Drop an unused fill slot without a GPU copy. Does not start a new
     * capture this frame ({@link readbackPeriod} already advanced on acquire).
     */
    public releaseFill(): void {
        const slot = this._fill;
        if (!slot) {
            return;
        }
        slot.reserved = false;
        slot.indexQueue.clear();
        this._fill = null;
    }

    public resize() {
        this._fill = null;
        this._fillAttemptFrame = -1;
        this._resize(this.indexManager.capacity);
        this._ensureAtlas();
    }

    public override destroy() {
        this._destroyHandle?.off();
        this._contextLostHandle?.off();
        this._fill = null;
        this._hasResult = false;
        super.destroy();
    }

    protected override _commit(slot: HZBTFState): boolean {
        const count = slot.read(slot.packed);
        if (count <= 0) {
            return false;
        }
        this._commitSnapshot(slot, count);
        return true;
    }

    protected override _onResize(_elementCount: number): void {
        this._hasResult = false;
    }

    protected override _onDestroy(): void {
        this._hasResult = false;
    }

    protected override _onContextLost(): void {
        this._fill = null;
        this._fillAttemptFrame = -1;
        this._hasResult = false;
    }

    protected override _onSlotsDisposed(): void {
        this._fill = null;
        this._fillAttemptFrame = -1;
    }

    private _ensureFill(): HZBTFState | null {
        if (this._fill) {
            return this._fill;
        }

        if (this._fillAttemptFrame === this._frameId) {
            return null;
        }

        this._fillAttemptFrame = this._frameId;
        const slot = this.acquire();
        if (!slot) {
            return null;
        }

        slot.indexQueue.clear();
        this._fill = slot;
        return slot;
    }

    private _isCurrentResult(index: number) {
        return this._hasResult &&
            index >= 0 &&
            index < this._resultGen.length &&
            this._resultGen[index] === this._resultEpoch;
    }

    private _ensureAtlas() {
        const cap = this.indexManager.capacity;
        if (this._resultData?.length === cap) {
            return;
        }
        this._resultData = new Uint32Array(cap);
        this._resultGen = new Uint32Array(cap);
        this._resultEpoch = 1;
        this._hasResult = false;
    }

    private _commitSnapshot(reader: HZBTFState, count: number) {
        this._ensureAtlas();

        let epoch = (this._resultEpoch + 1) >>> 0;
        if (epoch === 0) {
            this._resultGen.fill(0);
            epoch = 1;
        }
        this._resultEpoch = epoch;

        const indexes = reader.indexQueue.indexes;
        const packed = reader.packed;
        const data = this._resultData;
        const gen = this._resultGen;
        const cap = data.length;

        for (let i = 0; i < count; i++) {
            const dataIndex = indexes[i];
            if (dataIndex >= cap) {
                continue;
            }
            data[dataIndex] = packed[i];
            gen[dataIndex] = epoch;
        }

        this._hasResult = true;
    }
}
