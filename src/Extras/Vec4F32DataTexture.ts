import pc from "../engine.js";
import { SquareDataTexture, type ISquareDataTextureWriter } from "./SquareDataTexture.js";
import { SquareDataTextureArray } from "./SquareDataTextureArray.js";
import { SquareDataTextureLayerProxy } from "./SquareDataTextureLayerProxy.js";

const _channels = 4;
const _pixelsPerInstance = 1;
const _stride = _channels * _pixelsPerInstance;

export function tryEnqueueUpdateFromArray(
    writer: ISquareDataTextureWriter<Float32Array>,
    index: number,
    inArray: Float32Array,
    offset: number = 0
): boolean {

    let differences = false;

    const data = writer.data;
    const dataIndex = index * _stride;

    for (let i = 0; i < _channels; i++) {
        const inIdx = offset + i;
        const outIdx = dataIndex + i;
        if (differences ||
            data[outIdx] !== inArray[inIdx]) {
            data[outIdx] = inArray[inIdx];
            differences = true;
        }
    }

    if (differences) {
        writer.enqueueUpdate(index);
    }

    return differences;
}

export function tryEnqueueUpdateFromScalars(
    writer: ISquareDataTextureWriter<Float32Array>,
    index: number,
    r: number,
    g: number,
    b: number,
    a: number
): boolean {

    let differences = false;

    const data = writer.data;
    const dataIndex0 = index * _stride;
    const dataIndex1 = dataIndex0 + 1;
    const dataIndex2 = dataIndex0 + 2;
    const dataIndex3 = dataIndex0 + 3;

    if (data[dataIndex0] !== r) {
        data[dataIndex0] = r;
        data[dataIndex1] = g;
        data[dataIndex2] = b;
        data[dataIndex3] = a;
        differences = true;
    }
    else if (data[dataIndex1] !== g) {
        data[dataIndex1] = g;
        data[dataIndex2] = b;
        data[dataIndex3] = a;
        differences = true;
    }
    else if (data[dataIndex2] !== b) {
        data[dataIndex2] = b;
        data[dataIndex3] = a;
        differences = true;
    }
    else if (data[dataIndex3] !== a) {
        data[dataIndex3] = a;
        differences = true;
    }

    if (differences) {
        writer.enqueueUpdate(index);
    }

    return differences;
}

export function tryEnqueueUpdateVec2(
    writer: ISquareDataTextureWriter<Float32Array>,
    index: number,
    vec: pc.Vec2,
    extra: pc.Vec2 = pc.Vec2.ZERO
): boolean {
    return tryEnqueueUpdateFromScalars(writer, index, vec.x, vec.y, extra.x, extra.y);
}

export function tryEnqueueUpdateVec3(
    writer: ISquareDataTextureWriter<Float32Array>,
    index: number,
    vec: pc.Vec3,
    extra: number = 0
): boolean {
    return tryEnqueueUpdateFromScalars(writer, index, vec.x, vec.y, vec.z, extra);
}

export function tryEnqueueUpdateVec4(
    writer: ISquareDataTextureWriter<Float32Array>,
    index: number,
    vec: pc.Vec4
): boolean {
    return tryEnqueueUpdateFromScalars(writer, index, vec.x, vec.y, vec.z, vec.w);
}

/**
 * Vec4 f32 instance data as `sampler2D` (1 rgba32f texel per instance).
 */
export class Vec4F32Texture extends SquareDataTexture<Float32Array> {

    public constructor(device: pc.GraphicsDevice, capacity: number = 512) {
        super(device, {
            arrayConstructor: Float32Array,
            channels: _channels,
            pixelsPerInstance: _pixelsPerInstance,
            capacity
        });
    }

    public tryEnqueueUpdateFromArray(index: number, inArray: Float32Array, offset: number = 0): boolean {
        return tryEnqueueUpdateFromArray(this, index, inArray, offset);
    }

    public tryEnqueueUpdateFromScalars(index: number, r: number, g: number, b: number, a: number): boolean {
        return tryEnqueueUpdateFromScalars(this, index, r, g, b, a);
    }

    public tryEnqueueUpdateVec2(index: number, vec: pc.Vec2, extra: pc.Vec2 = pc.Vec2.ZERO): boolean {
        return tryEnqueueUpdateVec2(this, index, vec, extra);
    }

    public tryEnqueueUpdateVec3(index: number, vec: pc.Vec3, extra: number = 0): boolean {
        return tryEnqueueUpdateVec3(this, index, vec, extra);
    }

    public tryEnqueueUpdateVec4(index: number, vec: pc.Vec4): boolean {
        return tryEnqueueUpdateVec4(this, index, vec);
    }
}

/**
 * Writer view of one vec4 layer inside a {@link Vec4F32DataTextureArray}.
 */
export class Vec4F32DataTextureLayerProxy extends SquareDataTextureLayerProxy<Float32Array> {

    public tryEnqueueUpdateFromArray(index: number, inArray: Float32Array, offset: number = 0): boolean {
        return tryEnqueueUpdateFromArray(this, index, inArray, offset);
    }

    public tryEnqueueUpdateFromScalars(index: number, r: number, g: number, b: number, a: number): boolean {
        return tryEnqueueUpdateFromScalars(this, index, r, g, b, a);
    }

    public tryEnqueueUpdateVec2(index: number, vec: pc.Vec2, extra: pc.Vec2 = pc.Vec2.ZERO): boolean {
        return tryEnqueueUpdateVec2(this, index, vec, extra);
    }

    public tryEnqueueUpdateVec3(index: number, vec: pc.Vec3, extra: number = 0): boolean {
        return tryEnqueueUpdateVec3(this, index, vec, extra);
    }

    public tryEnqueueUpdateVec4(index: number, vec: pc.Vec4): boolean {
        return tryEnqueueUpdateVec4(this, index, vec);
    }
}

export interface IVec4F32DataTextureArrayParams {
    layers: number;
    capacity?: number;
    name?: string;
}

/**
 * Vec4 f32 instance data as `sampler2DArray` (1 rgba32f texel per instance per layer).
 */
export class Vec4F32DataTextureArray extends SquareDataTextureArray<Float32Array, Vec4F32DataTextureLayerProxy> {

    constructor(device: pc.GraphicsDevice, params: IVec4F32DataTextureArrayParams) {
        super(device, {
            arrayConstructor: Float32Array,
            channels: _channels,
            pixelsPerInstance: _pixelsPerInstance,
            capacity: params.capacity,
            layers: params.layers,
            name: params.name ?? "Vec4F32DataTextureArray"
        });
    }

    protected override _createLayerProxy(layer: number): Vec4F32DataTextureLayerProxy {
        return new Vec4F32DataTextureLayerProxy(this, layer);
    }
}
