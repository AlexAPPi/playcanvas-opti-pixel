import pc from "../engine.js";
import { IndexManager } from "./IndexManager.js";
import { SquareDataTexture, type TChannelSize, type TTypedArray, type TTypedArrayConstructor } from "./SquareDataTexture.js";

export class GPUElementsStore<TTTypedArray extends TTypedArray> {

    protected _device: pc.GraphicsDevice;
    protected _instancing: boolean;
    protected _dataStore: SquareDataTexture<TTTypedArray>;
    protected _indexManager: IndexManager;

    public get device() { return this._device; }
    public get capacity() { return this._indexManager.capacity; }
    public get instancing() { return this._instancing; }
    public get dataTexture() { return this._dataStore.texture; }

    constructor(device: pc.GraphicsDevice, instancing: boolean, arrayConstructor: TTypedArrayConstructor<TTTypedArray>, channels: TChannelSize, pixelsPerInstance: number, capacity?: number) {
        this._device = device;
        this._instancing = instancing;
        this._indexManager = new IndexManager(capacity, instancing ? false : true);
        this._dataStore = new SquareDataTexture(device, arrayConstructor, channels, pixelsPerInstance, capacity);
    }

    public destroy() {
        this._dataStore?.destroy();
        this._dataStore = null!;
    }

    public lockSegment(data: TTTypedArray, offset: number = 0) {
        const index = this._indexManager.reserve();
        this._dataStore.enqueueDataUpdate(index, data, offset);
        return index;
    }

    public unlock(index: number) {
        this._indexManager.free(index);
    }

    public resize(count: number) {
        this._indexManager.resize(count);
        this._dataStore.resize(count);
    }

    public update() {
        this._dataStore.update();
    }
}