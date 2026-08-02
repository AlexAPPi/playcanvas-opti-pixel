import pc from "../../../engine.js";
import { IndexManager } from "../../../Extras/IndexManager.js";
import { HZBTFState } from "./HZBTFState.js";
import { OCCLUSION_UNKNOWN } from "../../IOcclusionCullingTester.js";

export class HZBTStateQueue {

    private _readers: HZBTFState[] = [];
    private _freeReaders: HZBTFState[] = [];
    private _usedReaders: HZBTFState[] = [];
    private _tmpReader: HZBTFState | null = null;
    private _finishedReader: HZBTFState | null = null;

    private _freeToUsedRatio = 2;
    private _historyLength = 60 * 3;

    private _avgUsed = 0;
    private _alpha = 0;
    private _targetFree = 0;

    public get avgUsed() { return this._avgUsed; }
    public get targetFree() { return this._targetFree; }
    public get allCount() { return this._readers.length; }
    public get usedCount() { return this._usedReaders.length; }
    public get freeCount() { return this._freeReaders.length; }

    public get actual() { return this._tmpReader; }
    public get finished() { return this._finishedReader; }

    public get freeToUsedRatio() { return this._freeToUsedRatio; }
    public set freeToUsedRatio(value: number) {
        this._freeToUsedRatio = value;
    }

    public get historyLength() { return this._historyLength; }
    public set historyLength(value: number) {
        this._historyLength = value;
        this._alpha = 2 / (this._historyLength + 1);
    }

    public readonly device: pc.WebglGraphicsDevice;
    public readonly indexManager: IndexManager;

    constructor(
        device: pc.WebglGraphicsDevice,
        indexManager: IndexManager,
        freeToUsedRatio: number = 2,
        historyLength: number = 60 * 3
    ) {
        this.device = device;
        this.indexManager = indexManager;
        this.freeToUsedRatio = freeToUsedRatio;
        this.historyLength = historyLength;
    }

    protected _createReader(): HZBTFState {
        return new HZBTFState(this.device, this.indexManager);
    }

    public next(): HZBTFState | null {

        const currentReader = this._tmpReader;
        let update = true;

        if (currentReader) {
            if (currentReader.count > 0) {
                this._usedReaders.push(currentReader);
            } else {
                update = false;
            }
        }

        if (update) {
            let tmp = this._freeReaders.shift();
            if (!tmp) {
                tmp = this._createReader();
                this._readers.push(tmp);
            }

            this._tmpReader = tmp;
            this._tmpReader.clear();
        }

        return currentReader;
    }

    public resize() {
        for (let i = 0; i < this._readers.length; i++) {
            this._readers[i]?.resize();
        }
    }

    public destroy() {
        for (let i = 0; i < this._readers.length; i++) {
            this._readers[i]?.destroy();
        }
        this._readers.length = 0;
        this._freeReaders.length = 0;
        this._usedReaders.length = 0;
        this._tmpReader = null;
        this._finishedReader = null;
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

    public shrinkFreePool(maxFreeCount: number = 5) {
        while (this._freeReaders.length > maxFreeCount) {
            const reader = this._freeReaders.shift();
            if (reader) {
                reader.destroy();
                const index = this._readers.indexOf(reader);
                if (index > -1) this._readers.splice(index, 1);
            }
        }
    }

    protected _optimizationOfConsumedResources() {
        const used =
            this._usedReaders.length +
            (this._tmpReader ? 1 : 0) +
            (this._finishedReader ? 1 : 0);

        this._avgUsed += this._alpha * (used - this._avgUsed);
        this._targetFree = Math.floor(this._freeToUsedRatio * Math.max(used, this._avgUsed));

        this.shrinkFreePool(this._targetFree);
    }

    public frameUpdate(dt: number) {

        const gl = this.device.gl;
        const freeReaders = this._freeReaders;
        const usedReaders = this._usedReaders;

        let len = usedReaders.length;
        let lastReadyIndex = -1;

        for (let itemIndex = 0; itemIndex < len; itemIndex++) {

            const item = usedReaders[itemIndex];
            const res = item.zeroSync();

            if (res === gl.TIMEOUT_EXPIRED) {
                break;
            }

            if (res === gl.WAIT_FAILED) {
                item.abortRead();
                usedReaders.splice(itemIndex, 1);
                freeReaders.push(item);
                itemIndex--;
                len--;
                continue;
            }

            lastReadyIndex = itemIndex;
        }

        if (lastReadyIndex !== -1) {

            const reader = usedReaders[lastReadyIndex];
            const prevFinishReader = this._finishedReader;

            reader.read();
            this._finishedReader = reader;

            if (prevFinishReader) {
                freeReaders.push(prevFinishReader);
            }

            for (let prevIndex = lastReadyIndex - 1; prevIndex >= 0; prevIndex--) {
                const prevReader = usedReaders[prevIndex];
                prevReader.abortRead();
                freeReaders.push(prevReader);
            }

            usedReaders.splice(0, lastReadyIndex + 1);
        }

        this._optimizationOfConsumedResources();
    }
}