import { TypedArrayType, TypedArrayConstructorType } from "./TypedArray";

export abstract class AbsNumberQueue<TArray extends TypedArrayType> {

    private _dirty: boolean;
    private _count: number;
    private _itemSize: number;
    private _queue: TArray;
    private _arrayConstructor: TypedArrayConstructorType<TArray>;

    public get dirty() { return this._dirty; }
    public get count() { return this._count; }
    public get size() { return this._count * this._itemSize; }
    public get extraSize() { return this._itemSize - 1; }

    protected get _store() { return this._queue; }

    constructor(extraSize: number = 0, capacity: number = 512, arrayConstructor: TypedArrayConstructorType<TArray>) {
        this._count = 0;
        this._dirty = true;
        this._itemSize = extraSize + 1;
        this._resize(capacity, arrayConstructor);
    }

    protected abstract _getDefaultExtra(): number;

    protected _resize(capacity: number, arrayConstructor: TypedArrayConstructorType<TArray>): boolean {

        const arrLen = capacity * this._itemSize;

        if (this._queue === undefined ||
            this._queue.length !== arrLen ||
            this._arrayConstructor.name !== arrayConstructor.name) {

            this._arrayConstructor = arrayConstructor;
            this._queue = new arrayConstructor(arrLen);
            this._dirty = true;
            this._count = 0;
            return true;
        }

        return false;
    }

    public clear(): void {
        this._dirty = false;
        this._count = 0;
    }

    public enqueue(index: number, extra?: number | number[] | TArray): number {

        const queueIndex = this._count++;
        const indexIndex = queueIndex * this._itemSize;
        const oldIndex = this._queue[indexIndex];

        if (oldIndex !== index) {
            this._dirty = true;
            this._queue[indexIndex] = index;
        }

        if (this._itemSize > 1) {

            const normalizedExtra = typeof extra === "object";
            const defaultExtra = this._getDefaultExtra();

            for (let i = 1; i < this._itemSize; i++) {

                const extraIndex = indexIndex + i;
                const extraValue = normalizedExtra ? extra[i - 1] : extra;
                const newExtra = extraValue ?? defaultExtra;

                // Update always if dirty
                if (!this._dirty) {

                    const oldExtra = this._queue[extraIndex];

                    if (oldExtra === newExtra) {

                        // Skip update if values equal
                        continue;
                    }

                    this._dirty = true;
                }

                this._queue[extraIndex] = newExtra;
            }
        }

        return queueIndex;
    }
}