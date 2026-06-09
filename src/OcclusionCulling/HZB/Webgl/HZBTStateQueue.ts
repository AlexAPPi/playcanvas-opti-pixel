import pc from "../../../engine.js";
import { IndexManager } from "../../../Extras/IndexManager.js";
import { HZBTFState } from "./HZBTFState.js";
import { OCCLUSION_UNKNOWN } from "../../IOcclusionCullingTester.js";
import { ReadbackQueue } from "../../../Extras/ReadbackQueue.js";

export class HZBTStateQueue extends ReadbackQueue<HZBTFState> {

    public readonly device: pc.WebglGraphicsDevice;
    public readonly indexManager: IndexManager;

    constructor(device: pc.WebglGraphicsDevice, indexManager: IndexManager, freeToUsedRatio: number = 2, historyLength: number = 60 * 3) {
        super(freeToUsedRatio, historyLength);
        this.device = device;
        this.indexManager = indexManager;
    }

    protected _createReader(): HZBTFState {
        return new HZBTFState(this.device, this.indexManager);
    }

    public next() {
        return super.next();
    }

    public enqueue(index: number, extra?: number | number[]): number {
        return this.actual?.enqueue(index, extra) ?? -1;
    }

    public getData(index: number) {
        return this.finished?.getData(index) ?? -1;
    }

    public getOcclusionStatus(index: number) {
        return this.finished?.getOcclusionStatus(index) ?? OCCLUSION_UNKNOWN;
    }
}