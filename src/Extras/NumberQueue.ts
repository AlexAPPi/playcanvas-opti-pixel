export class NumberQueue {

    private _dirty: boolean;
    private _count: number;
    private _itemSize: number;
    private _queue: Uint32Array | Uint16Array;

    public get dirty() { return this._dirty; }
    public get count() { return this._count; }
    public get size() { return this._count * this._itemSize; }
    public get queue() { return this._queue; }
    public get isUint16() { return this._queue instanceof Uint16Array; }

    constructor(extraSize: number = 0, capacity: number = 512, uint32: boolean = true) {
        this._count = 0;
        this._dirty = true;
        this._itemSize = extraSize + 1;
        this.resize(capacity, uint32);
    }

    public resize(count: number, uint32: boolean = true): void {
        const arrLen = count * this._itemSize;
        this._queue = uint32 ? new Uint32Array(arrLen) : new Uint16Array(arrLen);
    }

    public clear(): void {
        this._dirty = false;
        this._count = 0;
    }

    public enqueue(index: number, extra?: number | number[]): number {

        const queueIndex = this._count++;
        const indexIndex = queueIndex * this._itemSize;
        const oldIndex = this._queue[indexIndex];

        if (oldIndex !== index) {
            this._dirty = true;
            this._queue[indexIndex] = index;
        }

        if (this._itemSize > 1) {

            const normalizedExtra = Array.isArray(extra);
            const defaultExtra = this.isUint16 ? 0xffff : 0xffffffff; // set max uint by default

            for (let i = 1; i < this._itemSize; i++) {

                const extraIndex = indexIndex + i;
                const extraValue = normalizedExtra ? extra[i - 1] : extra;
                const oldExtra = this._queue[extraIndex];
                const newExtra = extraValue ?? defaultExtra;

                if (oldExtra !== newExtra) {
                    this._dirty = true;
                    this._queue[extraIndex] = newExtra;
                }
            }
        }

        return queueIndex;
    }
}