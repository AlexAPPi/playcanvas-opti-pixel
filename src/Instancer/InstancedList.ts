import pc from "../engine.js";
import { GPUBufferTool } from "../Extras/GPUBufferTool.js";
import { radixSort } from "../Extras/RadixSort.js";

export const maxInstancedListCapacity = 2 ** 20 - 1;

function packDataToU32(index: number, extra: number) {
    return (index & 0xfffff) | ((extra & 0xff) << 20);
}

export class InstancedList {

    private _capacity: number = 0;
    private _count: number = 0;
    private _data: Uint32Array<ArrayBuffer>;
    //private _queueHash: number = 0;

    public get capacity() { return this._capacity; }
    public get data() { return this._data; }
    public get count() { return this._count; }
    //public get queueHash() { return this._queueHash; }

    public constructor(capacity: number) {

        // We support up to 1 million intsans,
        // which is quite enough for current tasks,
        // so that the remaining bits can be used for other useful purposes.
        if (capacity > maxInstancedListCapacity) {

            throw new Error("Instancing of this number of elements is not supported.");
        }

        this._resize(capacity);
    }

    protected _resize(newCapacity: number) {

        const oldIndexes = this._data;

        this._capacity = newCapacity;
        this._data  = new Uint32Array(newCapacity);

        if (oldIndexes) {
            this._data.set(oldIndexes, 0);
        }
    }

    public push(index: number, extra: number = 255) {
        const queueIndex = this._count++;
        const dataValue = packDataToU32(index, extra);
        this._data[queueIndex] = dataValue;
        //this._queueHash = Math.imul(this._queueHash, 4294967311) + dataValue;
    }

    public clear(): void {
        //this._queueHash = 0;
        this._count = 0;
    }

    public sort(reversed: boolean, buf: Uint32Array, depthStore: Uint32Array) {
        const count = this.count;
        // TODO: add other sort algorithm for small count < 1000
        if (count > 1) {
            radixSort(this._data, buf, count, reversed, (index) => depthStore[index & 0xfffff]);
        }
    }
}

export const instancingIndexSemantic = pc.SEMANTIC_ATTR11;

export class GPUInstancedList extends InstancedList {

    private _dataHash: number = 0;
    private _gpuInstancingBuffer: pc.VertexBuffer;

    public readonly device: pc.GraphicsDevice;

    public get hash() { return this._dataHash; }
    public get instancingBuffer() { return this._gpuInstancingBuffer; }

    public constructor(device: pc.GraphicsDevice, capacity: number) {
        super(capacity);
        this.device = device;
        this._recreateGPUBuffer();
    }

    protected _recreateGPUBuffer() {

        this._gpuInstancingBuffer?.destroy();

        const description: ConstructorParameters<typeof pc.VertexFormat>[1] = [
            { semantic: instancingIndexSemantic, components: 1, type: pc.TYPE_UINT32, normalize: false, asInt: true },
        ];

        const bufferFormat = new pc.VertexFormat(this.device, description);
        /* */ bufferFormat.instancing = true;

        this._gpuInstancingBuffer = new pc.VertexBuffer(this.device, bufferFormat, this.capacity, {
            usage: pc.BUFFER_DYNAMIC,
            data: this.data.buffer,
            storage: true
        });

        // Runtime create on gpu
        this._gpuInstancingBuffer.unlock();
    }

    public destroy() {
        this._gpuInstancingBuffer?.destroy();
    }

    public resize(newCapacity: number): void {
        super._resize(newCapacity);
        this._recreateGPUBuffer();
    }

    public update() {

        const count = this.count;
        const data = this.data;

        if (count > 0) { //&&
            //this._dataHash !== this.queueHash) {
            //this._dataHash = this.queueHash;
            GPUBufferTool.update(
                this._gpuInstancingBuffer,
                data,
                count
            );
        }
    }
}