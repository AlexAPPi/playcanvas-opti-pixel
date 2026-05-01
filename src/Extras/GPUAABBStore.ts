
import pc from "../engine.js";
import { GPUElementsStore } from "./GPUElementsStore.js";

const _data = new Float32Array(16);
const _aabb = new pc.BoundingBox();

export class GPUAABBStore extends GPUElementsStore<Float32Array> {

    constructor(device: pc.GraphicsDevice, capacity: number = 512) {
        super(device, false, Float32Array, 4, 4, capacity);
    }

    public lock(boundingBox: pc.BoundingBox, matrix?: pc.Mat4) {

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

        return this.lockSegment(_data);
    }
}