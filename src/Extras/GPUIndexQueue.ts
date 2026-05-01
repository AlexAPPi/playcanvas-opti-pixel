
import pc from "../engine.js";
import { GPUBufferTool } from "./GPUBufferTool.js";
import { IndexManager } from "./IndexManager.js";
import { IndexQueueEx } from "./IndexQueueEx.js";

export class GPUIndexQueue {

    protected _device: pc.GraphicsDevice;
    protected _instancing: boolean;
    protected _indexQueue: IndexQueueEx;
    protected _vertexBuffer: pc.VertexBuffer;

    public get device() { return this._device; }
    public get vertexBuffer() { return this._vertexBuffer; }
    public get size() { return this._indexQueue.size; }
    public get dirty() { return this._indexQueue.dirty; }
    public get count() { return this._indexQueue.count; }
    public get indexes() { return this._indexQueue.indexes; }
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
        const semantic = this._instancing ? pc.SEMANTIC_ATTR11 : pc.SEMANTIC_POSITION;
        const semantics = [pc.SEMANTIC_ATTR1, pc.SEMANTIC_ATTR2, pc.SEMANTIC_ATTR3, pc.SEMANTIC_ATTR4, pc.SEMANTIC_ATTR5, pc.SEMANTIC_ATTR6];
        const description: ConstructorParameters<typeof pc.VertexFormat>[1] = [
            { semantic: semantic, components: 1, type: type, normalize: false, asInt: true },
        ];

        for (let i = 0; i < this._indexQueue.extraSize; i++) {
            const extraSemantic = semantics[i];
            description.push({ semantic: extraSemantic, components: 1, type: type, normalize: false, asInt: true });
        }

        const bufferFormat = new pc.VertexFormat(this._device, description);

        if (this._instancing) {
            bufferFormat.instancing = true;
        }

        return bufferFormat;
    }

    protected _recreateKeyBuffer() {
        const dataBuffer = this._indexQueue.indexes.buffer;
        const bufferFormat = this._getBufferFormat();
        const numVertices = this._indexQueue.capacity;
        this._vertexBuffer?.destroy();
        this._vertexBuffer = new pc.VertexBuffer(this._device, bufferFormat, numVertices, {
            usage: pc.BUFFER_STREAM,
            data: dataBuffer
        });
        this._vertexBuffer.unlock();
    }

    public destroy() {
        this._vertexBuffer?.destroy();
        this._vertexBuffer = null!;
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
                this._vertexBuffer,
                this._indexQueue.indexes,
                this._indexQueue.size
            );
        }
    }
}