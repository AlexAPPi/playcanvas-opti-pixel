import pc from "../engine.js";
import { IPrimitive } from "../OcclusionCulling/IOcclusionCullingTester.js";
import { IndexedStorageBuffer } from "./IndexedStorageBuffer.js";

export interface DrawIndirectData {
    indexOrVertexCount: number;
    instanceCount: number;
    firstIndexOrVertex: number;
    baseVertexOrNonIndexedSign: number;
    firstInstance: number;
}

export const defaultNonIndexedSign = -2147483648 >>> 0;
export const elementsPerIndex = 5;
export const bytesPerIndex = elementsPerIndex * Uint32Array.BYTES_PER_ELEMENT;

export class IndirectDataBuffer extends IndexedStorageBuffer<Uint32Array> {

    public readonly nonIndexedSign: number;

    private _minQueueIndex: number;
    private _maxQueueIndex: number;

    public constructor(device: pc.WebgpuGraphicsDevice, capacity: number = 512, nonIndexedSign: number = defaultNonIndexedSign) {
        super(device, Uint32Array, elementsPerIndex, capacity);
        this.nonIndexedSign = nonIndexedSign;
    }

    public override reset() {
        super.reset();
        this._minQueueIndex = Number.MAX_SAFE_INTEGER;
        this._maxQueueIndex = Number.MIN_SAFE_INTEGER;
    }

    protected override _enqueueUpdate(index: number) {

        if (this._minQueueIndex > index) this._minQueueIndex = index;
        if (this._maxQueueIndex < index) this._maxQueueIndex = index;

        return super._enqueueUpdate(index);
    }

    public tryEnqueueUpdate(index: number, primitive: IPrimitive, instanceCount: number = 1, firstInstance: number = 0) {

        let differences = false;

        const dataIndex = index * elementsPerIndex;
        const data = this._data;

        const indexOrVertexCount = primitive.count;
        const firstIndexOrVertex = primitive.base;
        const baseVertexOrNonIndexedSign = (primitive.indexed ? primitive.baseVertex >>> 0 : this.nonIndexedSign);

        if (data[dataIndex] !== indexOrVertexCount) {
            data[dataIndex] = indexOrVertexCount;
            differences = true;
        }

        if (data[dataIndex + 1] !== instanceCount) {
            data[dataIndex + 1] = instanceCount;
            differences = true;
        }

        if (data[dataIndex + 2] !== firstIndexOrVertex) {
            data[dataIndex + 2] = firstIndexOrVertex;
            differences = true;
        }

        if (data[dataIndex + 3] !== baseVertexOrNonIndexedSign) {
            data[dataIndex + 3] !== baseVertexOrNonIndexedSign;
            differences = true;
        }

        if (data[dataIndex + 4] !== firstInstance) {
            data[dataIndex + 4] = firstInstance;
            differences = true;
        }

        if (differences) {
            this._enqueueUpdate(index);
        }

        return differences;
    }
}