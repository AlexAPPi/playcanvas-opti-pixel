import pc from "../engine.js";
import { SquareDataTexture } from "./SquareDataTexture.js";

const _channels = 4;
const _pixelsPerInstance = 1;

export class Vec4F32Texture extends SquareDataTexture<Float32Array> {

    public constructor(device: pc.GraphicsDevice, capacity: number = 512) {
        super(device, Float32Array, _channels, _pixelsPerInstance, capacity);
    }

    public tryEnqueueUpdateFromArray(index: number, inArray: Float32Array, offset: number = 0) {

        let differences = false;

        const dataIndex = index * this._stride;

        for (let i = 0; i < _channels; i++) {
            const inIdx = offset + i;
            const outIdx = dataIndex + i;
            if (this._data[outIdx] !== inArray[inIdx]) {
                this._data[outIdx] = inArray[inIdx];
                differences = true;
            }
        }

        if (differences) {
            this.enqueueUpdate(index);
        }

        return differences;
    }

    public tryEnqueueUpdateFromScalars(index: number, r: number, g: number, b: number, a: number) {

        let differences = false;

        const dataIndex0 = index * this._stride;
        const dataIndex1 = dataIndex0 + 1;
        const dataIndex2 = dataIndex0 + 2;
        const dataIndex3 = dataIndex0 + 3;

        if (this._data[dataIndex0] !== r) {
            this._data[dataIndex0] = r;
            differences = true;
        }

        if (this._data[dataIndex1] !== g) {
            this._data[dataIndex1] = g;
            differences = true;
        }

        if (this._data[dataIndex2] !== b) {
            this._data[dataIndex2] = b;
            differences = true;
        }

        if (this._data[dataIndex3] !== a) {
            this._data[dataIndex3] = a;
            differences = true;
        }

        if (differences) {
            this.enqueueUpdate(index);
        }

        return differences;
    }

    public tryEnqueueUpdateVec2(index: number, vec: pc.Vec2, extra: pc.Vec2 = pc.Vec2.ZERO) {
        return this.tryEnqueueUpdateFromScalars(index, vec.x, vec.y, extra.x, extra.y);
    }

    public tryEnqueueUpdateVec3(index: number, vec: pc.Vec3, extra: number = 0) {
        return this.tryEnqueueUpdateFromScalars(index, vec.x, vec.y, vec.z, extra);
    }

    public tryEnqueueUpdateVec4(index: number, vec: pc.Vec4) {
        return this.tryEnqueueUpdateFromScalars(index, vec.x, vec.y, vec.z, vec.w);
    }
}