
import pc from "../engine.js";
import { GPUBufferTool } from "./GPUBufferTool.js";
import { IndexManager } from "./IndexManager.js";
import { IndexQueueEx } from "./IndexQueueEx.js";

export const positionSemantic = pc.SEMANTIC_POSITION;
export const instancingIndexSemantic = pc.SEMANTIC_ATTR11;
export const instancingExtraSemantic = pc.SEMANTIC_ATTR12;

export class GPUIndexQueue { 

    protected _device: pc.GraphicsDevice;
    protected _instancing: boolean;
    protected _indexQueue: IndexQueueEx;
    protected _buffer: pc.VertexBuffer;

    public get device() { return this._device; }
    public get buffer() { return this._buffer; }
    public get size() { return this._indexQueue.size; }
    public get dirty() { return this._indexQueue.dirty; }
    public get count() { return this._indexQueue.count; }
    public get indexes() { return this._indexQueue.indexes; }
    public get itemSize() { return this._indexQueue.itemSize; }
    public get extraSize() { return this._indexQueue.extraSize; }
    public get capacity() { return this._indexQueue.capacity; }
    public get isUint32() { return this._indexQueue.isUint32 }

    public constructor(device: pc.GraphicsDevice, indexManager: IndexManager, instancing: boolean, extraSize: number = 0) {
        this._device = device;
        this._instancing = instancing;
        this._indexQueue = new IndexQueueEx(indexManager, extraSize);
        this._recreateKeyBuffer();
    }

    protected _getBufferFormat() {

        const type = this._indexQueue.isUint32 ? pc.TYPE_UINT32 : pc.TYPE_UINT16;
        const semantic = this._instancing ? instancingIndexSemantic : positionSemantic;
        const description: ConstructorParameters<typeof pc.VertexFormat>[1] = [
            { semantic: semantic, components: 1, type: type, normalize: false, asInt: true },
        ];

        const extraSize = this._indexQueue.extraSize;
        if (extraSize > 0) {
            description.push({ semantic: instancingExtraSemantic, components: extraSize, type: type, normalize: false, asInt: true });
        }

        const bufferFormat = new pc.VertexFormat(this._device, description);

        if (this._instancing) {
            bufferFormat.instancing = true;
        }

        return bufferFormat;
    }

    protected _recreateKeyBuffer() {
        this._buffer?.destroy();
        const dataBuffer = this._indexQueue.indexes.buffer;
        const numVertices = this._indexQueue.capacity;
        const bufferFormat = this._getBufferFormat();
        this._buffer = new pc.VertexBuffer(this._device, bufferFormat, numVertices, {
            usage: pc.BUFFER_DYNAMIC,
            data: dataBuffer,
            storage: true
        });
        this._buffer.unlock();
    }

    public destroy() {
        this._buffer?.destroy();
        this._buffer = null!;
    }

    public resize() {
        this._indexQueue.resizeIndexes();
        this._recreateKeyBuffer();
    }

    public clear() {
        this._indexQueue.clear();
    }

    public enqueue(index: number, extra?: number | number[]): number {
        return this._indexQueue.enqueue(index, extra);
    }

    public update() {

        if (this._indexQueue.count > 0 &&
            this._indexQueue.dirty) {

            GPUBufferTool.update(
                this._buffer,
                this._indexQueue.indexes,
                this._indexQueue.size
            );
        }
    }
}