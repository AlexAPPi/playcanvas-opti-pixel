import pc from "../engine.js";
import { SquareDataTexture, type ISquareDataTextureWriter } from "./SquareDataTexture.js";
import { SquareDataTextureArray } from "./SquareDataTextureArray.js";
import { SquareDataTextureLayerProxy } from "./SquareDataTextureLayerProxy.js";

const _channels = 4;
const _pixelsPerInstance = 1;

const _tempColor = new pc.Color();

export function setColorAt(writer: ISquareDataTextureWriter<Uint8Array>, id: number, color: pc.Color): void {

    const offset = id * _channels;
    const data = writer.data;

    data[offset    ] = Math.min(Math.max(0, color.r * 255), 255);
    data[offset + 1] = Math.min(Math.max(0, color.g * 255), 255);
    data[offset + 2] = Math.min(Math.max(0, color.b * 255), 255);
    data[offset + 3] = Math.min(Math.max(0, color.a * 255), 255);

    writer.enqueueUpdate(id);
}

export function getColorAt(writer: ISquareDataTextureWriter<Uint8Array>, id: number, color: pc.Color = _tempColor): pc.Color {

    const offset = id * _channels;
    const data = writer.data;

    color.r = data[offset]     / 255;
    color.g = data[offset + 1] / 255;
    color.b = data[offset + 2] / 255;
    color.a = data[offset + 3] / 255;

    return color;
}

export function setOpacityAt(writer: ISquareDataTextureWriter<Uint8Array>, id: number, value: number): void {
    writer.data[id * _channels + 3] = Math.min(Math.max(0, value * 255), 255);
    writer.enqueueUpdate(id);
}

export function getOpacityAt(writer: ISquareDataTextureWriter<Uint8Array>, id: number): number {
    return writer.data[id * _channels + 3] / 255;
}

export interface IColorDataTextureParams {
    capacity?: number;
    name?: string;
}

/**
 * Instance color data as `sampler2D` (RGBA8, 1 texel per instance).
 */
export class ColorDataTexture extends SquareDataTexture<Uint8Array> {

    constructor(device: pc.GraphicsDevice, params: IColorDataTextureParams = {}) {
        super(device, {
            arrayConstructor: Uint8Array,
            channels: _channels,
            pixelsPerInstance: _pixelsPerInstance,
            capacity: params.capacity,
            pixelFormat: pc.PIXELFORMAT_RGBA8,
            defaultPixelValue: 255,
            name: params.name ?? "ColorDataTexture"
        });
    }

    public setColorAt(id: number, color: pc.Color): void {
        setColorAt(this, id, color);
    }

    public getColorAt(id: number, color?: pc.Color): pc.Color {
        return getColorAt(this, id, color);
    }

    public setOpacityAt(id: number, value: number): void {
        setOpacityAt(this, id, value);
    }

    public getOpacityAt(id: number): number {
        return getOpacityAt(this, id);
    }
}

/**
 * Writer view of one RGBA8 color layer inside a {@link ColorDataTextureArray}.
 */
export class ColorDataTextureLayerProxy extends SquareDataTextureLayerProxy<Uint8Array> {

    public setColorAt(id: number, color: pc.Color): void {
        setColorAt(this, id, color);
    }

    public getColorAt(id: number, color?: pc.Color): pc.Color {
        return getColorAt(this, id, color);
    }

    public setOpacityAt(id: number, value: number): void {
        setOpacityAt(this, id, value);
    }

    public getOpacityAt(id: number): number {
        return getOpacityAt(this, id);
    }
}

export interface IColorDataTextureArrayParams {
    layers: number;
    capacity?: number;
    name?: string;
}

/**
 * Instance color data as `sampler2DArray` (RGBA8, 1 texel per instance per layer).
 */
export class ColorDataTextureArray extends SquareDataTextureArray<Uint8Array, ColorDataTextureLayerProxy> {

    constructor(device: pc.GraphicsDevice, params: IColorDataTextureArrayParams) {
        super(device, {
            arrayConstructor: Uint8Array,
            channels: _channels,
            pixelsPerInstance: _pixelsPerInstance,
            capacity: params.capacity,
            layers: params.layers,
            pixelFormat: pc.PIXELFORMAT_RGBA8,
            defaultPixelValue: 255,
            name: params.name ?? "ColorDataTextureArray"
        });
    }

    protected override _createLayerProxy(layer: number): ColorDataTextureLayerProxy {
        return new ColorDataTextureLayerProxy(this, layer);
    }
}
