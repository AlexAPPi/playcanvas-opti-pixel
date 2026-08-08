import pc from "../engine.js";
import { type TypedArrayType, type TypedArrayConstructorType } from "./TypedArray.js";
import { type ISquareDataTextureWriter, type TChannelSize } from "./SquareDataTexture.js";

/**
 * Minimal surface a layer proxy needs from {@link SquareDataTextureArray}.
 * Implemented structurally by the array (no reverse import).
 */
export interface ISquareDataTextureArrayLayerHost<TArray extends TypedArrayType> {
    partialUpdate: boolean;
    maxUpdateCalls: number;
    readonly pixelsPerInstance: number;
    readonly channels: TChannelSize;
    readonly capacity: number;
    readonly texture: pc.Texture;
    readonly layerViews: InstanceType<TypedArrayConstructorType<TArray>>[];
    enqueueUpdate(layer: number, index: number): void;
    enqueueDataUpdate(layer: number, index: number, inData: TArray, offset?: number): void;
    upload(): void;
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
        this._parent.enqueueUpdate(this._layer, index);
    }

    public enqueueDataUpdate(index: number, inData: TArray, offset: number = 0): void {
        this._parent.enqueueDataUpdate(this._layer, index, inData, offset);
    }

    public upload(): void {
        this._parent.upload();
    }

    public update(): void {
        this._parent.update();
    }
}
