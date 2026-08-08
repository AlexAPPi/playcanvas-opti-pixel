import pc from "../engine.js";
import { SquareDataTexture, type ISquareDataTextureWriter } from "./SquareDataTexture.js";
import { SquareDataTextureArray } from "./SquareDataTextureArray.js";
import { SquareDataTextureLayerProxy } from "./SquareDataTextureLayerProxy.js";

const _channels = 4;
const _pixelsPerInstance = 4;
const _floatsPerInstance = _channels * _pixelsPerInstance;

const _tempMat4 = new pc.Mat4();
const _tempVec3 = new pc.Vec3();

export function setMatrixAt(writer: ISquareDataTextureWriter<Float32Array>, id: number, matrix: pc.Mat4): void {

    const inData = matrix.data;
    const outData = writer.data;
    const offset = id * _floatsPerInstance;

    for (let i = 0; i < _floatsPerInstance; i++) {
        outData[offset + i] = inData[i];
    }

    writer.enqueueUpdate(id);
}

export function getMatrixAt(writer: ISquareDataTextureWriter<Float32Array>, id: number, matrix = _tempMat4): pc.Mat4 {

    const outData = matrix.data;
    const inData = writer.data;
    const offset = id * _floatsPerInstance;

    for (let i = 0; i < _floatsPerInstance; i++) {
        outData[i] = inData[offset + i];
    }

    return matrix;
}

export function getPositionAt(writer: ISquareDataTextureWriter<Float32Array>, index: number, target = _tempVec3): pc.Vec3 {

    const offset = index * _floatsPerInstance;
    const array = writer.data;

    target.x = array[offset + 12];
    target.y = array[offset + 13];
    target.z = array[offset + 14];

    return target;
}

export function getPositionAndMaxScaleOnAxisAt(
    writer: ISquareDataTextureWriter<Float32Array>,
    index: number,
    position: pc.Vec3
): number {

    const offset = index * _floatsPerInstance;
    const array = writer.data;

    const te0 = array[offset + 0];
    const te1 = array[offset + 1];
    const te2 = array[offset + 2];
    const scaleXSq = te0 * te0 + te1 * te1 + te2 * te2;

    const te4 = array[offset + 4];
    const te5 = array[offset + 5];
    const te6 = array[offset + 6];
    const scaleYSq = te4 * te4 + te5 * te5 + te6 * te6;

    const te8 = array[offset + 8];
    const te9 = array[offset + 9];
    const te10 = array[offset + 10];
    const scaleZSq = te8 * te8 + te9 * te9 + te10 * te10;

    position.x = array[offset + 12];
    position.y = array[offset + 13];
    position.z = array[offset + 14];

    return Math.sqrt(Math.max(scaleXSq, scaleYSq, scaleZSq));
}

export function applyMatrixAtToSphere(
    writer: ISquareDataTextureWriter<Float32Array>,
    index: number,
    sphere: pc.BoundingSphere,
    center: pc.Vec3,
    radius: number
): void {

    const offset = index * _floatsPerInstance;
    const array = writer.data;

    const te0 = array[offset + 0];
    const te1 = array[offset + 1];
    const te2 = array[offset + 2];
    const te3 = array[offset + 3];
    const te4 = array[offset + 4];
    const te5 = array[offset + 5];
    const te6 = array[offset + 6];
    const te7 = array[offset + 7];
    const te8 = array[offset + 8];
    const te9 = array[offset + 9];
    const te10 = array[offset + 10];
    const te11 = array[offset + 11];
    const te12 = array[offset + 12];
    const te13 = array[offset + 13];
    const te14 = array[offset + 14];
    const te15 = array[offset + 15];

    const position = sphere.center;
    const x = center.x;
    const y = center.y;
    const z = center.z;
    const w = 1 / (te3 * x + te7 * y + te11 * z + te15);

    position.x = (te0 * x + te4 * y + te8 * z + te12) * w;
    position.y = (te1 * x + te5 * y + te9 * z + te13) * w;
    position.z = (te2 * x + te6 * y + te10 * z + te14) * w;

    const scaleXSq = te0 * te0 + te1 * te1 + te2 * te2;
    const scaleYSq = te4 * te4 + te5 * te5 + te6 * te6;
    const scaleZSq = te8 * te8 + te9 * te9 + te10 * te10;

    sphere.radius = radius * Math.sqrt(Math.max(scaleXSq, scaleYSq, scaleZSq));
}

export interface IMat4DataTextureParams {
    capacity?: number;
    name?: string;
}

/**
 * Mat4 instance data as `sampler2D` (4 rgba32f texels per instance).
 */
export class Mat4DataTexture extends SquareDataTexture<Float32Array> {

    constructor(device: pc.GraphicsDevice, params: IMat4DataTextureParams = {}) {
        super(device, {
            arrayConstructor: Float32Array,
            channels: _channels,
            pixelsPerInstance: _pixelsPerInstance,
            capacity: params.capacity,
            name: params.name ?? "Mat4DataTexture"
        });
    }

    public setMatrixAt(id: number, matrix: pc.Mat4): void {
        setMatrixAt(this, id, matrix);
    }

    public getMatrixAt(id: number, matrix?: pc.Mat4): pc.Mat4 {
        return getMatrixAt(this, id, matrix);
    }

    public getPositionAt(index: number, target?: pc.Vec3): pc.Vec3 {
        return getPositionAt(this, index, target);
    }

    public getPositionAndMaxScaleOnAxisAt(index: number, position: pc.Vec3): number {
        return getPositionAndMaxScaleOnAxisAt(this, index, position);
    }

    public applyMatrixAtToSphere(index: number, sphere: pc.BoundingSphere, center: pc.Vec3, radius: number): void {
        applyMatrixAtToSphere(this, index, sphere, center, radius);
    }
}

/**
 * Writer view of one mat4 layer inside a {@link Mat4DataTextureArray}.
 */
export class Mat4DataTextureLayerProxy extends SquareDataTextureLayerProxy<Float32Array> {

    public setMatrixAt(id: number, matrix: pc.Mat4): void {
        setMatrixAt(this, id, matrix);
    }

    public getMatrixAt(id: number, matrix?: pc.Mat4): pc.Mat4 {
        return getMatrixAt(this, id, matrix);
    }

    public getPositionAt(index: number, target?: pc.Vec3): pc.Vec3 {
        return getPositionAt(this, index, target);
    }

    public getPositionAndMaxScaleOnAxisAt(index: number, position: pc.Vec3): number {
        return getPositionAndMaxScaleOnAxisAt(this, index, position);
    }

    public applyMatrixAtToSphere(index: number, sphere: pc.BoundingSphere, center: pc.Vec3, radius: number): void {
        applyMatrixAtToSphere(this, index, sphere, center, radius);
    }
}

export interface IMat4DataTextureArrayParams {
    layers: number;
    capacity?: number;
    name?: string;
}

/**
 * Mat4 instance data as `sampler2DArray` (4 rgba32f texels per instance per layer).
 */
export class Mat4DataTextureArray extends SquareDataTextureArray<Float32Array, Mat4DataTextureLayerProxy> {

    constructor(device: pc.GraphicsDevice, params: IMat4DataTextureArrayParams) {
        super(device, {
            arrayConstructor: Float32Array,
            channels: _channels,
            pixelsPerInstance: _pixelsPerInstance,
            capacity: params.capacity,
            layers: params.layers,
            name: params.name ?? "Mat4DataTextureArray"
        });
    }

    protected override _createLayerProxy(layer: number): Mat4DataTextureLayerProxy {
        return new Mat4DataTextureLayerProxy(this, layer);
    }
}
