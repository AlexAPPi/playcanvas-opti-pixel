import { BitSet, TOkForeachCallback } from "./BitSet.js";

export class IndexManager {

    private _capacity: number;
    private _availableCount: number;
    private _isAvailable: BitSet;
    private _isUint32: boolean;

    public get reservedCount() {
        return this._capacity - this._availableCount;
    }

    public get availableCount() {
        return this._availableCount;
    }

    public get isUint32() {
        return this._isUint32;
    }

    public get capacity() {
        return this._capacity;
    }

    constructor(capacity: number = 512, uint32: boolean = false) {

        if (capacity < 0) {
            throw new RangeError("Capacity must be non-negative");
        }

        this._capacity = 0;
        this._isUint32 = uint32;
        this._availableCount = 0;
        this._isAvailable = new BitSet(0, true);
        this.resize(capacity);
    }

    public resize(newCapacity: number) {

        if (newCapacity < 0) {
            throw new RangeError("Capacity must be non-negative");
        }

        if (newCapacity === this._capacity) {
            return;
        }

        let availableCount = 0;
        const next = new BitSet(newCapacity, true);
        next.copyValues(this._isAvailable);
        next.forEachFilter(true, (idx) => { availableCount++; });

        this._availableCount = availableCount;
        this._isAvailable = next;
        this._capacity = newCapacity;

        // Once switched to Uint32 mode, it never switches back.
        this._isUint32 = this._isUint32 || newCapacity > 0xffff;
    }

    public reserve(): number {

        const index = this._isAvailable.findFirst(true);

        if (index < 0) {
            throw new Error("No available indices to reserve");
        }

        this._availableCount--;
        this._isAvailable.set(index, false);
        return index;
    }

    public free(index: number): void {

        if (index < 0 || index >= this._capacity) {
            return;
        }

        if (this._isAvailable.get(index)) {
            throw new Error(`Index ${index} already freed`);
        }

        this._availableCount++;
        this._isAvailable.set(index, true);
    }

    public forEach(callback: TOkForeachCallback): void {
        this._isAvailable.forEachFilter(false, callback);
    }
}