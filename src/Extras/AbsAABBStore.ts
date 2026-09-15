import pc from "../engine.js";
import { IAABBStore } from "./IAABBStore.js";
import { IndexManager } from "./IndexManager.js";

const _aabb1 = new pc.BoundingBox();
const _aabb2 = new pc.BoundingBox();

export function writeAabbVec3(data: Float32Array, index: number, x: number, y: number, z: number, extra: number): boolean {
    const i0 = index << 2;
    const i1 = i0 + 1;
    const i2 = i0 + 2;
    const i3 = i0 + 3;
    if (data[i0] !== x) {
        data[i0] = x;
        data[i1] = y;
        data[i2] = z;
        data[i3] = extra;
        return true;
    }
    if (data[i1] !== y) {
        data[i1] = y;
        data[i2] = z;
        data[i3] = extra;
        return true;
    }
    if (data[i2] !== z) {
        data[i2] = z;
        data[i3] = extra;
        return true;
    }
    if (data[i3] !== extra) {
        data[i3] = extra;
        return true;
    }
    return false;
}

/**
 * Shared CPU AABB store: index pool, packed centers/halves, lock/update/get.
 * Subclasses own the backing arrays and optional GPU textures.
 */
export abstract class AbsAABBStore implements IAABBStore {

    protected _indexManager: IndexManager;
    protected _version = 0;

    public get capacity() { return this._indexManager.capacity; }
    public get indexManager() { return this._indexManager; }
    public get version() { return this._version; }

    public abstract get centersData(): Float32Array;
    public abstract get halfExtentsData(): Float32Array;

    public get hasTextures(): boolean {
        return false;
    }

    public get centersTexture(): pc.Texture {
        return this._gpuNotImplemented("centersTexture");
    }

    public get halfExtentsTexture(): pc.Texture {
        return this._gpuNotImplemented("halfExtentsTexture");
    }

    protected constructor(capacity: number) {
        this._indexManager = new IndexManager(capacity, true);
    }

    public resize(newCapacity: number) {
        if (newCapacity === this._indexManager.capacity) {
            return;
        }
        this._indexManager.resize(newCapacity);
        this._resizeStorage(newCapacity);
        this._version++;
    }

    public lock(boundingBox: pc.BoundingBox, matrix?: pc.Mat4, extra1: number = 0, extra2: number = 0): number {
        const index = this._indexManager.reserve();
        this.enqueueUpdate(index, boundingBox, matrix, extra1, extra2);
        return index;
    }

    public lockMinMaxScalars(data: ArrayLike<number>, offset: number, matrix?: pc.Mat4, extra1?: number, extra2?: number): number {
        const index = this._indexManager.reserve();
        _aabb2.center.set(
            (data[offset] + data[offset + 1]) * 0.5,
            (data[offset + 2] + data[offset + 3]) * 0.5,
            (data[offset + 4] + data[offset + 5]) * 0.5
        );
        _aabb2.halfExtents.set(
            (data[offset + 1] - data[offset]) * 0.5,
            (data[offset + 3] - data[offset + 2]) * 0.5,
            (data[offset + 5] - data[offset + 4]) * 0.5
        );
        this.enqueueUpdate(index, _aabb2, matrix, extra1 ?? 0, extra2 ?? 0);
        return index;
    }

    public unlock(index: number): void {
        this._indexManager.free(index);
    }

    public enqueueUpdate(index: number, boundingBox: pc.BoundingBox, matrix?: pc.Mat4, extra1: number = 0, extra2: number = 0) {
        extra1 ??= 0;
        extra2 ??= 0;
        let result = boundingBox;
        if (matrix) {
            _aabb1.setFromTransformedAabb(boundingBox, matrix);
            result = _aabb1;
        }
        const r1 = this._writeCenter(index, result.center, extra1);
        const r2 = this._writeHalfExtents(index, result.halfExtents, extra2);
        if (r1 || r2) {
            this._version++;
        }
        return r1 || r2;
    }

    public get(index: number, boundingBox: pc.BoundingBox) {
        const i0 = index << 2;
        const centers = this.centersData;
        const halves = this.halfExtentsData;
        boundingBox.center.set(centers[i0], centers[i0 + 1], centers[i0 + 2]);
        boundingBox.halfExtents.set(halves[i0], halves[i0 + 1], halves[i0 + 2]);
        return boundingBox;
    }

    public getMatrix(index: number, matrixData: Float32Array): void {
        const i0 = index << 2;
        const centers = this.centersData;
        const halves = this.halfExtentsData;
        matrixData[0] = halves[i0] * 2;
        matrixData[5] = halves[i0 + 1] * 2;
        matrixData[10] = halves[i0 + 2] * 2;
        matrixData[12] = centers[i0];
        matrixData[13] = centers[i0 + 1];
        matrixData[14] = centers[i0 + 2];
    }

    public abstract update(): void;
    public abstract destroy(): void;

    protected abstract _resizeStorage(newCapacity: number): void;

    protected _writeCenter(index: number, vec: pc.Vec3, extra: number): boolean {
        return writeAabbVec3(this.centersData, index, vec.x, vec.y, vec.z, extra);
    }

    protected _writeHalfExtents(index: number, vec: pc.Vec3, extra: number): boolean {
        return writeAabbVec3(this.halfExtentsData, index, vec.x, vec.y, vec.z, extra);
    }

    protected _gpuNotImplemented(name: string): never {
        throw new Error(`${this.constructor.name}: ${name} is not implemented`);
    }
}
