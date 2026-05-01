import { IndexManager } from "../../../Extras/IndexManager";
import { HZBTFState } from "./HZBTFState";
import { OCCLUSION_UNKNOWN } from "../../IOcclusionCullingTester";
import pc from "../../../engine";

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

export class HZBTStateQueue {

    public device: pc.WebglGraphicsDevice;
    public indexManager: IndexManager;

    private _states: HZBTFState[] = [];
    private _free: HZBTFState[] = [];
    private _queue: HZBTFState[] = [];
    private _tmpFrame: HZBTFState | null = null;
    private _finishFrame: HZBTFState | null = null;

    private _avgUsed: number = 0;
    private _alpha: number = 0;
    private _targetFree: number = 0;

    public get actual() { return this._tmpFrame; }

    constructor(device: pc.WebglGraphicsDevice, indexManager: IndexManager, historyLength: number = 60 * 3) {
        this.device = device;
        this.indexManager = indexManager;
        this._alpha = 2 / (historyLength + 1);
        // createDebug(device);
    }

    public resize() {

        for (let i = 0; i < this._states.length; i++) {
            const state = this._states[i];
            if (state) {
                state.resize();
            }
        }
    }

    public free() {

        for (let i = 0; i < this._states.length; i++) {
            const state = this._states[i];
            if (state) {
                state.destroy();
            }
        }

        this._states.length = 0;
        this._free.length = 0;
        this._queue.length = 0;
    }

    public shrinkFreePool(maxFreeCount: number = 5) {
        while (this._free.length > maxFreeCount) {
            const state = this._free.shift();
            if (state) {
                state.destroy();
                const index = this._states.indexOf(state);
                if (index > -1) {
                    this._states.splice(index, 1);
                }
            }
        }
    }

    public destroy() {
        this.free();
    }

    public test() {

        for (let i = this._queue.length - 1; i > -1; i--) {

            const state = this._queue[i];

            if (!state.lock) {

                this._finishFrame = state;

                // Skip test for prev frames states
                if (i > 0) {

                    for (let j = 0; j < i; j++) {

                        this._free.push(this._queue[j]);
                        this._queue[j].abortRead();
                    }

                    this._queue.splice(0, i);
                }

                break;
            }
        }

        const used = this._states.length - this._free.length;

        if (this._avgUsed === 0) {
            this._avgUsed = used;
        } else {
            this._avgUsed += this._alpha * (used - this._avgUsed);
        }

        this._targetFree = Math.floor(2 * Math.max(used, this._avgUsed));

        this.shrinkFreePool(this._targetFree);
    }

    public next() {

        const state = this._tmpFrame;

        let update = true;

        if (state) {

            if (state.count > 0) {
                this._queue.push(state);
            }
            else {
                update = false;
            }
        }

        if (update) {

            let tmp = this._free.shift();

            if (!tmp) {
                tmp = new HZBTFState(this.device, this.indexManager);
                this._states.push(tmp);
            }

            this._tmpFrame = tmp;
            this._tmpFrame.clear();
        }

        /*
        debugDiv.innerHTML = `
            <span>AVG: ${this._avgUsed}</span>
            <span>TRFR: ${this._targetFree}</span>
            <span>Free: ${this._free.length}</span>
            <span>Queue: ${this._queue.length}</span>
            <span>All: ${this._states.length}</span>
        `;
        //*/

        return state;
    }

    public enqueue(index: number, extra?: number | number[]): number {
        return this._tmpFrame?.enqueue(index, extra) ?? -1;
    }

    public getOcclusionStatus(index: number) {
        return this._finishFrame?.getOcclusionStatus(index) ?? OCCLUSION_UNKNOWN;
    }
}