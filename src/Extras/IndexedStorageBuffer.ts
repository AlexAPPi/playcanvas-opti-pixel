import pc from "../engine.js";
import { BitSet } from "./BitSet.js";

type StorageTypedArrayType = Float32Array | Int32Array | Int16Array | Int8Array | Uint32Array | Uint16Array | Uint8Array;
type TypedArrayConstructorType<T extends StorageTypedArrayType> = new (count: number) => T;

export abstract class IndexedStorageBuffer<TData extends StorageTypedArrayType> {

    public readonly device: pc.WebgpuGraphicsDevice;
    public readonly elementsPerIndex: number;
    public readonly arrayConstructor: TypedArrayConstructorType<TData>;

    protected _data: TData;
    protected _buffer: pc.StorageBuffer;
    protected _bitSet: BitSet;
    protected _capacity: number;
    protected _count: number;

    public get buffer() { return this._buffer; }
    public get capacity() { return this._capacity; }
    public get count() { return this._count; }

    public constructor(device: pc.WebgpuGraphicsDevice, arrayConstructor: TypedArrayConstructorType<TData>, elementsPerIndex: number = 1, capacity: number = 512) {
        this.device = device;
        this.elementsPerIndex = elementsPerIndex;
        this.arrayConstructor = arrayConstructor;
        this.resize(capacity);
    }

    public destroy() {
        this._buffer?.destroy();
    }

    public reset() {
        this._bitSet.clear();
        this._count = 0;
    }

    public resize(capacity: number) {

        this.destroy();

        const oldData = this._data;
        const newData = new this.arrayConstructor(capacity * this.elementsPerIndex);
        const totalSize = newData.byteLength;

        if (oldData) {

            const minLength = Math.min(oldData.length, newData.length);
            const subData = oldData.subarray(0, minLength);

            newData.set(subData);
        }

        this._capacity = capacity;
        this._data   = newData;
        this._bitSet = new BitSet(capacity, false);
        this._buffer = new pc.StorageBuffer(this.device, totalSize, pc.BUFFERUSAGE_COPY_DST);

        this.reset();
    }

    protected _enqueueUpdate(index: number) {

        // Prev value false
        if (this._bitSet.exchange(index, true) === false) {
            this._count++;
            return true;
        }

        return false;
    }

    public update(maxBatchSizeBytes: number = 1024) {

        if (this._count < 1) {
            return;
        }

        // TODO: use engine wraps
        const gpuBuffer = this._buffer.impl.buffer as GPUBuffer;
        const gpuQueue = ((this.device as any).wgpu as GPUDevice).queue;

        const buffer = this._data.buffer;
        const bytesPerElement = this._data.BYTES_PER_ELEMENT;
        const elementsPerIndex = this.elementsPerIndex;
        const bytesPerIndex = elementsPerIndex * this._data.BYTES_PER_ELEMENT;

        /*
        if (1 === 1) {

            // TODO: update full
            gpuQueue.writeBuffer(gpuBuffer, 0, buffer, 0, this._data.byteLength);
            return;
        }
        */

        let startIndex = -1;
        let blockElementsCount = 0;

        this._bitSet.forEachFilter(true, (index) => {

            if (startIndex === -1) {
                startIndex = index;
                blockElementsCount = elementsPerIndex;
                return;
            }

            const len = (index - startIndex + 1);
            const newBlockByteSize = len * bytesPerIndex;

            if (newBlockByteSize <= maxBatchSizeBytes) {
                blockElementsCount = len * elementsPerIndex;
            } else {
                const offset = startIndex * bytesPerIndex;
                const size = blockElementsCount * bytesPerElement;
                gpuQueue.writeBuffer(gpuBuffer, offset, buffer, offset, size);
                startIndex = index;
                blockElementsCount = elementsPerIndex;
            }
        });

        if (startIndex !== -1) {
            const offset = startIndex * bytesPerIndex;
            const size = blockElementsCount * bytesPerElement;
            gpuQueue.writeBuffer(gpuBuffer, offset, buffer, offset, size);
        }

        this.reset();
    }
}