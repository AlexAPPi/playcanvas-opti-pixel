import pc from "../engine.js";
import { GPUElementsStore } from "./GPUElementsStore.js";
import { GPUIndexQueue } from "./GPUIndexQueue.js";
import { type TypedArrayType, type TypedArrayConstructorType } from "./TypedArray.js";
import { type TChannelSize } from "./SquareDataTexture.js";

export class GPUElementQueue<TArray extends TypedArrayType> extends GPUElementsStore<TArray> {

    protected _indexQueue: GPUIndexQueue;

    public get count() { return this._indexQueue.count; }
    public get vertexBuffer() { return this._indexQueue.buffer; }

    constructor(device: pc.GraphicsDevice, instancing: boolean, arrayConstructor: TypedArrayConstructorType<TArray>, channels: TChannelSize, pixelsPerInstance: number, indexExtraSize: number = 0, capacity?: number) {
        super(device, instancing, arrayConstructor, channels, pixelsPerInstance, capacity);
        this._indexQueue = new GPUIndexQueue(device, this._indexManager, instancing, indexExtraSize);
    }

    public destroy() {
        super.destroy();
        this._indexQueue?.destroy();
        this._indexQueue = null!;
    }

    public resize(count: number) {
        super.resize(count);
        this._indexQueue.resize();
    }

    public clear() {
        this._indexQueue.clear();
    }

    public enqueue(index: number, extra?: number | number[]): number {
        return this._indexQueue.enqueue(index, extra);
    }

    public update() {
        super.update();
        this._indexQueue.update();
    }
}