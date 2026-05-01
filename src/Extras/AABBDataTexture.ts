import pc from "../engine";
import { SquareDataTexture } from "./SquareDataTexture";

const _channels = 4;
const _pixelsPerInstance = 2;

const _data = new Float32Array(_channels * _pixelsPerInstance);
const _aabb = new pc.BoundingBox();

export class AABBDataTexture extends SquareDataTexture<Float32Array> {

    public constructor(device: pc.GraphicsDevice, capacity: number = 512) {
        super(device, Float32Array, _channels, _pixelsPerInstance, capacity);
    }

    public tryEnqueueAABBUpdate(index: number, boundingBox: pc.BoundingBox, matrix?: pc.Mat4) {

        let resultBoundingBox = boundingBox;

        if (matrix) {
            _aabb.setFromTransformedAabb(boundingBox, matrix);
            resultBoundingBox = _aabb;
        }

        const dataIndex = index * this._stride;
        const center = resultBoundingBox.center;
        const halfExtents = resultBoundingBox.halfExtents;

        let differences = false;

        if (this._data[dataIndex + 0] !== center.x) {
            this._data[dataIndex + 0] = center.x;
            differences = true;
        }
        
        if (this._data[dataIndex + 1] !== center.y) {
            this._data[dataIndex + 1] = center.y;
            differences = true;
        }

        if (this._data[dataIndex + 2] !== center.z) {
            this._data[dataIndex + 2] = center.z;
            differences = true;
        }

        if (this._data[dataIndex + 4] !== halfExtents.x) {
            this._data[dataIndex + 4] = halfExtents.x;
            differences = true;
        }
        
        if (this._data[dataIndex + 5] !== halfExtents.y) {
            this._data[dataIndex + 5] = halfExtents.y;
            differences = true;
        }

        if (this._data[dataIndex + 6] !== halfExtents.z) {
            this._data[dataIndex + 6] = halfExtents.z;
            differences = true;
        }

        if (differences) {
            this.enqueueUpdate(index);
        }

        return differences;
    }

    public enqueueAABBUpdate(index: number, boundingBox: pc.BoundingBox, matrix?: pc.Mat4) {

        let resultBoundingBox = boundingBox;

        if (matrix) {
            _aabb.setFromTransformedAabb(boundingBox, matrix);
            resultBoundingBox = _aabb;
        }

        _data[0] = resultBoundingBox.center.x;
        _data[1] = resultBoundingBox.center.y;
        _data[2] = resultBoundingBox.center.z;
        //_data[3] = 0;
        _data[4] = resultBoundingBox.halfExtents.x;
        _data[5] = resultBoundingBox.halfExtents.y;
        _data[6] = resultBoundingBox.halfExtents.z;
        //_data[7] = 0;

        this.enqueueDataUpdate(index, _data);
    }
}