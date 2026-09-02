import pc from "../../../engine.js";
import { IndexManager } from "../../../Extras/IndexManager.js";
import { HZBTFState } from "./HZBTFState.js";
import { OCCLUSION_OCCLUDED, OCCLUSION_UNKNOWN, OCCLUSION_VISIBLE, TOcclusionResult } from "../../IOcclusionCullingTester.js";

export class HZBTStateQueue {

    private _readers: HZBTFState[] = [];
    private _freeReaders: HZBTFState[] = [];
    private _usedReaders: HZBTFState[] = [];
    private _tmpReader: HZBTFState | null = null;

    private _resultData: Uint32Array;
    private _resultGen: Uint32Array;
    private _resultEpoch = 1;
    private _hasResult = false;

    private _freeToUsedRatio = 2;
    private _historyLength = 60 * 3;
    private _maxInFlight = 4;
    private _minLatencyFrames = 2;
    private _freeShrinkHysteresis = 2;

    private _avgUsed = 0;
    private _alpha = 0;
    private _targetFree = 0;
    private _frameId = 0;

    public get avgUsed() { return this._avgUsed; }
    public get targetFree() { return this._targetFree; }
    public get allCount() { return this._readers.length; }
    public get usedCount() { return this._usedReaders.length; }
    public get freeCount() { return this._freeReaders.length; }
    public get frameId() { return this._frameId; }

    public get actual() { return this._tmpReader; }

    public get freeToUsedRatio() { return this._freeToUsedRatio; }
    public set freeToUsedRatio(value: number) {
        this._freeToUsedRatio = value;
    }

    public get historyLength() { return this._historyLength; }
    public set historyLength(value: number) {
        this._historyLength = value;
        this._alpha = 2 / (this._historyLength + 1);
    }

    public get maxInFlight() { return this._maxInFlight; }
    public set maxInFlight(value: number) {
        this._maxInFlight = value > 0 ? value : 1;
    }

    public get minLatencyFrames() { return this._minLatencyFrames; }
    public set minLatencyFrames(value: number) {
        this._minLatencyFrames = value > 0 ? value : 0;
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
        this._ensureAtlas();
    }

    protected _createReader(): HZBTFState {
        return new HZBTFState(this.device, this.indexManager);
    }

    public next(): HZBTFState | null {

        const currentReader = this._tmpReader;
        let update = true;

        if (currentReader) {
            if (currentReader.count > 0) {
                if (this._usedReaders.length >= this._maxInFlight) {
                    currentReader.clear();
                    update = false;
                } else {
                    currentReader.submitFrame = this._frameId;
                    this._usedReaders.push(currentReader);
                }
            } else {
                update = false;
            }
        }

        if (update) {
            let tmp = this._freeReaders.pop();
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
        this._ensureAtlas();
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
        this._hasResult = false;
    }

    public enqueue(index: number, extra?: number | number[]): number {
        return this.actual?.enqueue(index, extra) ?? -1;
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

    public shrinkFreePool(maxFreeCount: number = 5) {
        const free = this._freeReaders;
        const all = this._readers;
        while (free.length > maxFreeCount) {
            const reader = free.pop();
            if (!reader) {
                break;
            }
            reader.destroy();
            const index = all.indexOf(reader);
            if (index > -1) {
                all[index] = all[all.length - 1];
                all.pop();
            }
        }
    }

    public frameUpdate(_dt: number) {
        this._frameId++;
        this._harvest();
        this._optimizationOfConsumedResources();
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

    private _optimizationOfConsumedResources() {
        const used =
            this._usedReaders.length +
            (this._tmpReader ? 1 : 0);

        this._avgUsed += this._alpha * (used - this._avgUsed);
        this._targetFree = Math.floor(this._freeToUsedRatio * Math.max(used, this._avgUsed));

        if (this._freeReaders.length > this._targetFree + this._freeShrinkHysteresis) {
            this.shrinkFreePool(this._targetFree);
        }
    }

    private _recycleUsedAt(index: number) {
        const used = this._usedReaders;
        const reader = used[index];
        reader.abortRead();
        this._freeReaders.push(reader);
        used.splice(index, 1);
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

    private _adoptNewest(lastReadyIndex: number) {
        const used = this._usedReaders;
        const free = this._freeReaders;
        const newest = used[lastReadyIndex];
        const count = newest.read();
        if (count > 0) {
            this._commitSnapshot(newest, count);
        }

        for (let i = 0; i <= lastReadyIndex; i++) {
            used[i].abortRead();
            free.push(used[i]);
        }

        used.splice(0, lastReadyIndex + 1);
    }

    /**
     * Age-gated newest-ready: among slots submitted at least `minLatencyFrames` ago,
     * take the newest signaled fence. Older completed slots are discarded without CPU copy.
     */
    private _harvest() {
        const used = this._usedReaders;
        const minAge = this._minLatencyFrames;
        const frameId = this._frameId;

        while (used.length > 0) {
            const oldest = used[0];
            if (frameId - oldest.submitFrame < minAge) {
                return;
            }

            const status0 = oldest.poll();
            if (status0 === "failed") {
                this._recycleUsedAt(0);
                continue;
            }
            if (status0 === "pending") {
                return;
            }

            let lastEligible = 0;
            for (let i = 1; i < used.length; i++) {
                if (frameId - used[i].submitFrame < minAge) {
                    break;
                }
                lastEligible = i;
            }

            let lastReady = 0;
            for (let i = lastEligible; i > 0; i--) {
                const status = used[i].poll();
                if (status === "pending") {
                    continue;
                }
                if (status === "failed") {
                    this._recycleUsedAt(i);
                    continue;
                }
                lastReady = i;
                break;
            }

            this._adoptNewest(lastReady);
            return;
        }
    }
}
