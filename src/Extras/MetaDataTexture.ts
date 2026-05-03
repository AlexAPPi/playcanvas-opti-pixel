import { SquareDataTexture } from "./SquareDataTexture";

const _channels = 4;
const _pixelsPerInstance = 1;
const _data = new Uint32Array(4);

export class MetaDataTexture extends SquareDataTexture<Uint32Array> {

    public constructor(device: pc.GraphicsDevice, capacity: number = 512) {
        super(device, Uint32Array, _channels, _pixelsPerInstance, capacity);
    }

    public tryEnqueueMetaUpdate(
        index: number,
        indexCountOrVertexCount: number,
        firstIndexOrFirstVertex: number,
        baseVertex: number = 0,
        firstInstance: number = 0
    ) {
        let differences = false;

        const dataIndex = index * this._stride;

        if (this._data[dataIndex + 0] !== indexCountOrVertexCount) {
            this._data[dataIndex + 0] = indexCountOrVertexCount;
            differences = true;
        }

        if (this._data[dataIndex + 1] !== firstIndexOrFirstVertex) {
            this._data[dataIndex + 1] = firstIndexOrFirstVertex;
            differences = true;
        }

        if (this._data[dataIndex + 2] !== baseVertex) {
            this._data[dataIndex + 2] = baseVertex;
            differences = true;
        }

        if (this._data[dataIndex + 3] !== firstInstance) {
            this._data[dataIndex + 3] = firstInstance;
            differences = true;
        }

        if (differences) {
            this.enqueueUpdate(index);
        }

        return differences;
    }

    public enqueueMetaUpdate(
        index: number,
        indexCountOrVertexCount: number,
        firstIndexOrFirstVertex: number,
        baseVertex: number = 0,
        firstInstance: number = 0
    ) {
        _data[0] = indexCountOrVertexCount;
        _data[1] = firstIndexOrFirstVertex;
        _data[2] = baseVertex;
        _data[3] = firstInstance;
        this.enqueueDataUpdate(index, _data);
    }
}