import pc from "../engine.js";
import { TypedArrayConstructorType, type TypedArrayType } from "./TypedArray.js";
import { type ISquareDataTextureWriter, type TChannelSize } from "./SquareDataTexture.js";

/**
 * Minimal surface a layer proxy needs from {@link SquareDataTextureArray}.
 * Implemented structurally by the array (no reverse import).
 */
export interface ISquareDataTextureArrayLayerHost<TArray extends TypedArrayType> {

    /**
     * If true, the texture will be updated only if the data has changed.
     */
    partialUpdate: boolean;

    /**
     * Maximum number of update calls per frame.
     */
    maxUpdateCalls: number;

    /**
     * Number of pixels per instance.
     */
    readonly pixelsPerInstance: number;

    /**
     * Number of channels per pixel.
     */
    readonly channels: TChannelSize;

    /**
     * Maximum number of instances that the texture can hold.
     */
    readonly capacity: number;

    /**
     * Texture.
     */
    readonly texture: pc.Texture;

    /**
     * Data for each layer.
     */
    readonly layerViews: InstanceType<TypedArrayConstructorType<TArray>>[];

    /**
     * Update data for specific layer.
     * @param layer - Layer index.
     * @param index - Index of the instance.
     */
    enqueueUpdateLayer(layer: number, index: number): void;

    /**
     * 
     * @param layer - Layer index.
     * @param index - Index of the instance.
     * @param inData - Data to update.
     * @param offset - Offset in the data.
     */
    enqueueDataUpdateLayer(layer: number, index: number, inData: TArray, offset?: number): void;

    /**
     * Upload the texture to the GPU.
     */
    upload(): void;

    /**
     * Update the texture on the GPU.
     */
    update(): void;
}

/**
 * Writer view of a single layer inside a {@link SquareDataTextureArray}.
 *
 * API matches {@link ISquareDataTextureWriter} / {@link SquareDataTexture} enqueue surface
 * (no `layer` in method signatures). Does not own GPU resources — no `resize` / `destroy`.
 *
 * Shader bind: use `texture` as `sampler2DArray` with this proxy's {@link layer}.
 * Call `update` / `upload` once per frame on the parent array (or any layer proxy).
 */
export class SquareDataTextureLayerProxy<TArray extends TypedArrayType> implements ISquareDataTextureWriter<TArray> {

    protected _parent: ISquareDataTextureArrayLayerHost<TArray>;
    protected _layer: number;

    public get layer() { return this._layer; }
    public get capacity() { return this._parent.capacity; }
    public get pixelsPerInstance() { return this._parent.pixelsPerInstance; }
    public get channels() { return this._parent.channels; }
    public get texture() { return this._parent.texture; }
    public get data() { return this._parent.layerViews[this._layer]; }

    public get partialUpdate() { return this._parent.partialUpdate; }
    public set partialUpdate(value: boolean) { this._parent.partialUpdate = value; }

    public get maxUpdateCalls() { return this._parent.maxUpdateCalls; }
    public set maxUpdateCalls(value: number) { this._parent.maxUpdateCalls = value; }

    constructor(parent: ISquareDataTextureArrayLayerHost<TArray>, layer: number) {
        this._parent = parent;
        this._layer = layer;
    }

    public enqueueUpdate(index: number): void {
        this._parent.enqueueUpdateLayer(this._layer, index);
    }

    public enqueueDataUpdate(index: number, inData: TArray, offset: number = 0): void {
        this._parent.enqueueDataUpdateLayer(this._layer, index, inData, offset);
    }

    public upload(): void {
        this._parent.upload();
    }

    public update(): void {
        this._parent.update();
    }
}
