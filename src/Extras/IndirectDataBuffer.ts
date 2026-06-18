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

    public constructor(device: pc.WebgpuGraphicsDevice, capacity: number = 512, nonIndexedSign: number = defaultNonIndexedSign) {
        super(device, Uint32Array, elementsPerIndex, capacity);
        this.nonIndexedSign = nonIndexedSign;
    }

    public tryEnqueueUpdate(index: number, primitive: IPrimitive, instanceCount: number = 1, firstInstance: number = 0) {

        let differences = false;

        const dataIndex = index * elementsPerIndex;
        const data = this._data;

        const indexOrVertexCount = primitive.count;
        const firstIndexOrVertex = primitive.base;
        const baseVertexOrNonIndexedSign = (primitive.indexed ? primitive.baseVertex >>> 0 : this.nonIndexedSign);

        const dataIndex0 = dataIndex;
        const dataIndex1 = dataIndex + 1;
        const dataIndex2 = dataIndex + 2;
        const dataIndex3 = dataIndex + 3;
        const dataIndex4 = dataIndex + 4;

        if (data[dataIndex0] !== indexOrVertexCount) {
            data[dataIndex0] = indexOrVertexCount;
            data[dataIndex1] = instanceCount;
            data[dataIndex2] = firstIndexOrVertex;
            data[dataIndex3] = baseVertexOrNonIndexedSign;
            data[dataIndex4] = firstInstance;
            differences = true;
        }
        else if (data[dataIndex1] !== instanceCount) {
            data[dataIndex1] = instanceCount;
            data[dataIndex2] = firstIndexOrVertex;
            data[dataIndex3] = baseVertexOrNonIndexedSign;
            data[dataIndex4] = firstInstance;
            differences = true;
        }
        else if (data[dataIndex2] !== firstIndexOrVertex) {
            data[dataIndex2] = firstIndexOrVertex;
            data[dataIndex3] = baseVertexOrNonIndexedSign;
            data[dataIndex4] = firstInstance;
            differences = true;
        }
        else if (data[dataIndex3] !== baseVertexOrNonIndexedSign) {
            data[dataIndex3] = baseVertexOrNonIndexedSign;
            data[dataIndex4] = firstInstance;
            differences = true;
        }
        else if (data[dataIndex4] !== firstInstance) {
            data[dataIndex4] = firstInstance;
            differences = true;
        }

        if (differences) {
            this._enqueueUpdate(index);
        }

        return differences;
    }
}