import { GPUIndexQueue } from "../../../Extras/GPUIndexQueue.js";
import { IndexManager } from "../../../Extras/IndexManager.js";
import { OCCLUSION_OCCLUDED, OCCLUSION_UNKNOWN, OCCLUSION_VISIBLE, TOcclusionResult } from "../../IOcclusionCullingTester.js";
import { WebglReadbackBuffer } from "../../../Extras/WebglReadbackBuffer.js";
import pc from "../../../engine.js";

export const FLAG_OK = 1;

export class HZBTFState {

    private _lock: boolean;

    public data: Uint32Array;
    public flags: Uint8Array;

    public indexQueue: GPUIndexQueue;
    public outputBuffer: WebglReadbackBuffer<Uint32Array<ArrayBuffer>>;

    public get lock() { return this._lock; }
    public get count() { return this.indexQueue.count; }

    constructor(device: pc.WebglGraphicsDevice, indexManager: IndexManager) {
        this.indexQueue = new GPUIndexQueue(device, indexManager, false, 0);
        this.resize();
        this._lock = false;
    }

    public resize() {

        this.indexQueue.resize();
        this.data = new Uint32Array(this.indexQueue.capacity);
        this.flags = new Uint8Array(this.indexQueue.capacity);
        this.outputBuffer?.destroy();

        const device = this.indexQueue.device as pc.WebglGraphicsDevice;
        const capacity = this.indexQueue.capacity;

        this.outputBuffer = new WebglReadbackBuffer(device, capacity, 4, Uint32Array);
    }

    public destroy() {
        this.outputBuffer?.destroy();
        this.indexQueue?.destroy();
        this.outputBuffer = null!;
        this.indexQueue = null!;
    }

    public clear() {
        this.abortRead();
        this.indexQueue.clear();
        this.flags.fill(0);
    }

    public enqueue(index: number, extra?: number | number[]): number {

        if (this._lock) {
            return -1;
        }

        return this.indexQueue.enqueue(index, extra);
    }

    public getData(index: number): number {
        if ((this.flags[index] & FLAG_OK) === 0) {
            return -1;
        }
        return this.data[index];
    }

    public getOcclusionStatus(index: number): TOcclusionResult {

        if ((this.flags[index] & FLAG_OK) === 0) {
            return OCCLUSION_UNKNOWN;
        }

        // See shader function getFlags
        const value = this.data[index] & 0x3;
        if (value === 1) {
            return OCCLUSION_OCCLUDED;
        }

        return OCCLUSION_VISIBLE;
    }

    public abortRead() {
        this.outputBuffer.abortRead();
        this._lock = false;
    }

    protected _fillFromBuffer(resultCount: number) {

        const indexes = this.indexQueue.indexes;
        const outData = this.outputBuffer.storageData;

        for (let i = 0; i < resultCount; i++) {
            const dataIndex = indexes[i];
            this.data[dataIndex] = outData[i];
            this.flags[dataIndex] |= FLAG_OK;
        }
    }

    public beginRead(): void {

        if (this._lock) {
            throw new Error("Reading started earlier");
        }

        const targetResultCount = Math.min(this.indexQueue.count, this.data.length);

        // Skip empty read
        if (targetResultCount > 0) {
            this.outputBuffer.beginRead(targetResultCount);
            this._lock = true;
        }
    }

    public frameUpdate(): number {

        if (this._lock) {

            const resultCount = this.outputBuffer.checkRead();

            if (resultCount !== -1) {

                this._lock = false;
                this._fillFromBuffer(resultCount);

                return resultCount;
            }
        }

        return -1;
    }

    public async read(intervalMs: number) {

        try {

            this._lock = true;

            let resultCount = Math.min(this.indexQueue.count, this.data.length);

            if (resultCount > 0) {

                resultCount = await this.outputBuffer.read(resultCount, intervalMs);

                if (this._lock) {

                    this._fillFromBuffer(resultCount);
                }
            }

            return resultCount;
        }
        finally {

            this._lock = false;
        }
    }
}