import pc from "../engine.js";
import { GPUBufferTool } from "../Extras/GPUBufferTool.js";
import { radixSort } from "../Extras/RadixSort.js";

export class InstancedList {

    private _minZ: number =  Infinity;
    private _maxZ: number = -Infinity;
    private _capacity: number = 0;
    private _count: number = 0;
    private _indexes: Uint32Array<ArrayBuffer>;

    public get capacity() { return this._capacity; }
    public get indexes() { return this._indexes; }
    public get count() { return this._count; }

    public constructor(capacity: number) {
        this._resize(capacity);
    }

    protected _resize(newCapacity: number) {

        const oldIndexes = this._indexes;

        this._capacity = newCapacity;
        this._indexes  = new Uint32Array(newCapacity);

        if (oldIndexes) {
            this._indexes.set(oldIndexes, 0);
        }
    }

    public push(index: number, depth: number) {

        const queueIndex = this._count++;
        this._indexes[queueIndex] = index;

        if (this._minZ > depth) this._minZ = depth;
        if (this._maxZ < depth) this._maxZ = depth;
    }

    public clear(): void {
        this._count = 0;
        this._minZ =  Infinity;
        this._maxZ = -Infinity;
    }

    public sort(reversed: boolean, buf: Uint32Array, depthStore: Uint32Array) {
        const count = this.count;
        if (count > 1) {
            radixSort(this._indexes, buf, count, reversed, (index) => depthStore[index]);
        }
    }
}

export const instancingIndexSemantic = pc.SEMANTIC_ATTR11;

export class GPUInstancedList extends InstancedList {

    public readonly device: pc.GraphicsDevice;

    private _gpuInstancingBuffer: pc.VertexBuffer;
    private _indexesHash: number = 0;

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
            data: this.indexes.buffer,
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
        const indexes = this.indexes;

        /*
        let hash = 0;
        for (let i = 0; i < count; i++) {
            const index = indexes[i] >>> 0;
            hash = Math.imul(hash, 4294967311) + index;
        }
        */

        if (count > 1) {
            GPUBufferTool.update(
                this._gpuInstancingBuffer,
                indexes,
                count
            );
        }
    }
}