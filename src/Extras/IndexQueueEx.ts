import { IndexManager } from "./IndexManager";

export class IndexQueueEx {

    private _count: number;
    private _itemSize: number;
    private _indexManager: IndexManager;
    private _dirty: boolean;
    private _indexes: Uint32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>;

    public get size() { return this.count * this._itemSize; }
    public get dirty() { return this._dirty; }
    public get count() { return this._count; }
    public get indexes() { return this._indexes; }
    public get extraSize() { return this._itemSize - 1; }
    public get capacity() { return this._indexManager.capacity; }
    public get isUint32() { return this._indexManager.isUint32 }
    public get indexManager() { return this._indexManager; }

    public constructor(indexManager: IndexManager, extraSize: number = 0) {
        this._count = 0;
        this._dirty = true;
        this._indexManager = indexManager;
        this._itemSize = extraSize + 1;
        this.resizeIndexes();
    }

    public resizeIndexes() {

        const count = this._indexManager.capacity;
        const arrLen = count * this._itemSize;

        if (!this._indexes || arrLen !== this._indexes.length) {
            
            this._indexes = this._indexManager.isUint32 ? new Uint32Array(arrLen) : new Uint16Array(arrLen);
            this._dirty = true;
        }
    }

    public clear(): void {
        this._dirty = false;
        this._count = 0;
    }

    public enqueue(index: number, extra?: number | number[]): number {

        const queueIndex = this._count++;
        const indexIndex = queueIndex * this._itemSize;
        const oldIndex = this._indexes[indexIndex];

        if (oldIndex !== index) {
            this._dirty = true;
            this._indexes[indexIndex] = index;
        }

        if (this._itemSize > 1) {

            const normalizedExtra = Array.isArray(extra);
            const defaultExtra = this.isUint32 ? 0xffffffff : 0xffff; // set max uint by default

            for (let i = 1; i < this._itemSize; i++) {

                const extraIndex = indexIndex + i;
                const extraValue = normalizedExtra ? extra[i - 1] : extra;
                const oldExtra = this._indexes[extraIndex];
                const newExtra = extraValue ?? defaultExtra;

                if (oldExtra !== newExtra) {
                    this._dirty = true;
                    this._indexes[extraIndex] = newExtra;
                }
            }
        }

        return queueIndex;
    }
}