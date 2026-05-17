import { AbsNumberQueue } from "./AbsNumberQueue";

export class NumberQueue extends AbsNumberQueue<Float32Array<ArrayBuffer>> {

    public get queue() { return this._store; }

    public constructor(extraSize: number = 0, capacity: number = 512) {
        super(extraSize, capacity, Float32Array);
    }

    protected _getDefaultExtra(): number {
        return 0.0;
    }

    public resize(count: number) {
        this._resize(count, Float32Array);
    }
}