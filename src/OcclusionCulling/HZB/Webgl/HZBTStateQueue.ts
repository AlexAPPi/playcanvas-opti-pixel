import { IndexManager } from "../../../Extras/IndexManager.js";
import { HZBTFState } from "./HZBTFState.js";
import { OCCLUSION_UNKNOWN } from "../../IOcclusionCullingTester.js";
import pc from "../../../engine.js";
import { ReadbackQueue } from "../../../Extras/ReadbackQueue.js";

/*
let debugDiv: HTMLDivElement;

function createDebug(device: WebglGraphicsDevice) {
    debugDiv = document.createElement('div');
    debugDiv.style.position = 'absolute';
    debugDiv.style.top = '48px';
    debugDiv.style.left = '10px';
    debugDiv.style.color = 'white';
    debugDiv.style.fontSize = '12px';
    debugDiv.style.pointerEvents = 'none';
    debugDiv.style.display = 'flex';
    debugDiv.style.flexDirection = 'column';
    device.canvas.parentNode!.appendChild(debugDiv);
}
//*/

export class HZBTStateQueue extends ReadbackQueue<HZBTFState> {

    public readonly device: pc.WebglGraphicsDevice;
    public readonly indexManager: IndexManager;

    constructor(device: pc.WebglGraphicsDevice, indexManager: IndexManager, freeToUsedRatio: number = 2, historyLength: number = 60 * 3) {
        super(freeToUsedRatio, historyLength);
        this.device = device;
        this.indexManager = indexManager;
        // createDebug(device);
    }

    protected _createReader(): HZBTFState {
        return new HZBTFState(this.device, this.indexManager);
    }

    public next() {

        /*
        debugDiv.innerHTML = `
            <span>AVG: ${this.avgUsed}</span>
            <span>TRFR: ${this.targetFree}</span>
            <span>Free: ${this.freeCount}</span>
            <span>Queue: ${this.usedCount}</span>
            <span>All: ${this.allCount}</span>
        `;
        //*/

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