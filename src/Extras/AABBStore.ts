import pc from "../engine.js";
import { IAABBStore } from "./IAABBStore.js";
import { IndexManager } from "./IndexManager";
import { Vec4F32Texture } from "./Vec4F32DataTexture";

const _aabb1 = new pc.BoundingBox();
const _aabb2 = new pc.BoundingBox();

export class AABBStore implements IAABBStore {

    private _indexManager: IndexManager;
    private _centersStore: Vec4F32Texture;
    private _halfExtentsStore: Vec4F32Texture;

    public readonly device: pc.GraphicsDevice;
    public get capacity() { return this._indexManager.capacity; }
    public get indexManager() { return this._indexManager; }
    public get centersTexture() { return this._centersStore.texture; }
    public get halfExtentsTexture() { return this._halfExtentsStore.texture; }

    public constructor(device: pc.GraphicsDevice, capacity: number) {
        this.device = device;
        this._indexManager = new IndexManager(capacity, true);
        this._centersStore = new Vec4F32Texture(device, capacity);
        this._halfExtentsStore = new Vec4F32Texture(device, capacity);
    }

    public resize(newCapacity: number) {
        this._indexManager.resize(newCapacity);
        this._centersStore.resize(newCapacity);
        this._halfExtentsStore.resize(newCapacity);
    }

    public lock(boundingBox: pc.BoundingBox, matrix?: pc.Mat4, extra1: number = 0, extra2: number = 0): number {
        const index = this._indexManager.reserve();
        this.enqueueUpdate(index, boundingBox, matrix, extra1, extra2);
        return index;
    }

    public lockMinMaxScalars(data: ArrayLike<number>, offset: number, matrix?: pc.Mat4, extra1?: number, extra2?: number): number {

        const index = this._indexManager.reserve();

        _aabb2.center.set(
            (data[offset]     + data[offset + 1]) * 0.5,
            (data[offset + 2] + data[offset + 3]) * 0.5,
            (data[offset + 4] + data[offset + 5]) * 0.5
        );

        _aabb2.halfExtents.set(
            (data[offset + 1] - data[offset]) * 0.5,
            (data[offset + 3] - data[offset + 2]) * 0.5,
            (data[offset + 5] - data[offset + 4]) * 0.5
        );

        this.enqueueUpdate(index, _aabb2, matrix, extra1, extra2);
        return index;
    }

    public unlock(index: number): void {
        this._indexManager.free(index);
    }

    public enqueueUpdate(index: number, boundingBox: pc.BoundingBox, matrix?: pc.Mat4, extra1: number = 0, extra2: number = 0) {

        let resultBoundingBox = boundingBox;

        if (matrix) {
            _aabb1.setFromTransformedAabb(boundingBox, matrix);
            resultBoundingBox = _aabb1;
        }

        const r1 = this._centersStore.tryEnqueueUpdateVec3(index, resultBoundingBox.center, extra1);
        const r2 = this._halfExtentsStore.tryEnqueueUpdateVec3(index, resultBoundingBox.halfExtents, extra2);

        return r1 || r2;
    }

    public get(index: number, boundingBox: pc.BoundingBox) {
        const dataIndex0 = index * 4;
        const dataIndex1 = dataIndex0 + 1;
        const dataIndex2 = dataIndex0 + 2;
        const center = this._centersStore.data;
        const halfExtents = this._halfExtentsStore.data;
        boundingBox.center.set(center[dataIndex0], center[dataIndex1], center[dataIndex2]);
        boundingBox.halfExtents.set(halfExtents[dataIndex0], halfExtents[dataIndex1], halfExtents[dataIndex2]);
        return boundingBox;
    }

    public getMatrix(index: number, matrixData: Float32Array): void {

        const dataIndex0 = index * 4;
        const dataIndex1 = dataIndex0 + 1;
        const dataIndex2 = dataIndex0 + 2;
        const centers = this._centersStore.data;
        const halfExtents = this._halfExtentsStore.data;

        // Set matrix size and position
        matrixData[0]  = halfExtents[dataIndex0] * 2;
        matrixData[5]  = halfExtents[dataIndex1] * 2;
        matrixData[10] = halfExtents[dataIndex2] * 2;
        matrixData[12] = centers[dataIndex0];
        matrixData[13] = centers[dataIndex1];
        matrixData[14] = centers[dataIndex2];
    }

    public update() {
        this._centersStore.update();
        this._halfExtentsStore.update();
    }
}