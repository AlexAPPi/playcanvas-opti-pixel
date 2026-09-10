import pc from "../../../engine.js";
import { TFState } from "../../../GPUReadback/Webgl/TFState.js";
import { TFStateQueue } from "../../../GPUReadback/Webgl/TFStateQueue.js";

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
export class CoverageTFStateQueue extends TFStateQueue<TFState> {

    private _cpuDepth: Float32Array;
    private _cpuVP = new Float32Array(16);
    private _cpuParams = new Float32Array(4);
    private _cpuReady = false;
    private _cpuVersion = 0;

    public constructor(device: pc.WebglGraphicsDevice, pixelCount: number, slotCount: number = 4) {
        super(device, slotCount);
        this.resize(pixelCount);
    }

    public get cpuReady() { return this._cpuReady; }
    public get cpuVersion() { return this._cpuVersion; }
    public get cpuDepth() { return this._cpuDepth; }
    public get cpuViewProjection() { return this._cpuVP; }
    public get cpuCameraParams() { return this._cpuParams; }

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
    }

    protected override _onDestroy(): void {
        this._cpuReady = false;
    }

    protected override _onContextLost(): void {
        this._cpuReady = false;
    }

    public resize(pixelCount: number) {
        this._resize(pixelCount);
    }
}
