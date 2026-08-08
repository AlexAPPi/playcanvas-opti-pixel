import pc from "../engine.js";
import { BitSet } from "./BitSet.js";

type StorageTypedArrayType = Float32Array | Int32Array | Int16Array | Int8Array | Uint32Array | Uint16Array | Uint8Array;
type TypedArrayConstructorType<T extends StorageTypedArrayType> = new (count: number) => T;

export abstract class IndexedStorageBuffer<TData extends StorageTypedArrayType> {

    public readonly device: pc.WebgpuGraphicsDevice;
    public readonly elementsPerIndex: number;
    public readonly arrayConstructor: TypedArrayConstructorType<TData>;

    protected _data: TData;
    protected _buffer: pc.StorageBuffer | null = null;
    protected _bitSet: BitSet;
    protected _capacity: number = 0;
    protected _dirty: boolean = false;

    public get buffer() { return this._buffer; }
    public get capacity() { return this._capacity; }
    public get dirty() { return this._dirty; }

    public constructor(device: pc.WebgpuGraphicsDevice, arrayConstructor: TypedArrayConstructorType<TData>, elementsPerIndex: number = 1, capacity: number = 512) {
        this.device = device;
        this.elementsPerIndex = elementsPerIndex;
        this.arrayConstructor = arrayConstructor;
        this.resize(capacity);
    }

    public destroy() {
        this._buffer?.destroy();
        this._buffer = null;
    }

    public reset() {
        this._bitSet.clear();
        this._dirty = false;
    }

    public resize(capacity: number) {

        this.destroy();

        const oldData = this._data;
        const bytesPerElement = this.arrayConstructor.prototype.BYTES_PER_ELEMENT as number;
        const logicalBytes = capacity * this.elementsPerIndex * bytesPerElement;
        // WebGPU writeBuffer requires byte size / offset multiples of 4.
        const totalSize = Math.ceil(logicalBytes / 4) * 4;
        const allocElements = totalSize / bytesPerElement;
        const newData = new this.arrayConstructor(allocElements);

        if (oldData) {
            const minLength = Math.min(oldData.length, newData.length);
            newData.set(oldData.subarray(0, minLength));
        }

        this._capacity = capacity;
        this._data = newData;
        this._bitSet = new BitSet(capacity, false);
        this._buffer = new pc.StorageBuffer(this.device, totalSize, pc.BUFFERUSAGE_COPY_DST);

        // New GPU buffer is empty; CPU data was preserved — upload immediately.
        if (oldData) {
            this._writeBytes(0, totalSize);
        }

        this.reset();
    }

    protected _enqueueUpdate(index: number) {

        // Prev value false
        if (this._bitSet.exchange(index, true) === false) {
            this._dirty = true;
            return true;
        }

        return false;
    }

    private _gpuQueue(): GPUQueue {
        return ((this.device as any).wgpu as GPUDevice).queue;
    }

    private _writeBytes(byteOffset: number, byteSize: number) {

        // writeBuffer requires bufferOffset and size to be multiples of 4.
        const alignedOffset = byteOffset & ~3;
        const alignedEnd = Math.min(
            (byteOffset + byteSize + 3) & ~3,
            this._data.byteLength
        );
        const size = alignedEnd - alignedOffset;

        if (size <= 0) {
            return;
        }

        this._gpuQueue().writeBuffer(
            this._buffer!.impl.buffer as GPUBuffer,
            alignedOffset,
            this._data.buffer,
            this._data.byteOffset + alignedOffset,
            size
        );
    }

    private _writeIndexRange(startIndex: number, endIndexInclusive: number) {

        const bytesPerIndex = this.elementsPerIndex * this._data.BYTES_PER_ELEMENT;
        const offset = startIndex * bytesPerIndex;
        const size = (endIndexInclusive - startIndex + 1) * bytesPerIndex;

        this._writeBytes(offset, size);
    }

    public update(maxBatchSizeBytes: number = 1024) {

        if (!this._dirty) {
            return;
        }

        const bytesPerIndex = this.elementsPerIndex * this._data.BYTES_PER_ELEMENT;

        let startIndex = -1;
        let endIndex = -1;

        this._bitSet.forEachFilter(true, (index) => {

            if (startIndex === -1) {
                startIndex = index;
                endIndex = index;
                return;
            }

            const contiguous = index === endIndex + 1;
            const newBlockByteSize = (index - startIndex + 1) * bytesPerIndex;

            if (contiguous && newBlockByteSize <= maxBatchSizeBytes) {
                endIndex = index;
            }
            else {
                this._writeIndexRange(startIndex, endIndex);
                startIndex = index;
                endIndex = index;
            }
        });

        if (startIndex !== -1) {
            this._writeIndexRange(startIndex, endIndex);
        }

        this.reset();
    }
}
