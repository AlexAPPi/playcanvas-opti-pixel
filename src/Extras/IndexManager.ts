import { BitSet } from "./BitSet.js";

export class IndexManager {

    private _capacity: number;
    private _available: Uint32Array | Uint16Array;
    private _availableCount: number;
    private _isAvailable: BitSet;

    public get isUint32() {
        return this._available instanceof Uint32Array;
    }

    public get capacity() {
        return this._capacity;
    }

    constructor(capacity: number = 512, uint32: boolean = false) {

        if (capacity < 0) {
            throw new RangeError("Capacity must be non-negative");
        }

        this._capacity = 0;
        this._availableCount = 0;
        this._available = uint32 ? new Uint32Array(0) : new Uint16Array(0);
        this._isAvailable = new BitSet(0);

        this.resize(capacity);
    }

    public resize(newCapacity: number) {

        if (newCapacity < 0) {
            throw new RangeError("Capacity must be non-negative");
        }

        if (newCapacity === this.capacity) {
            return;
        }

        const useUint32 = this._available instanceof Uint32Array || newCapacity > 0xFFFF;
        const newAvailable = useUint32 ? new Uint32Array(newCapacity) : new Uint16Array(newCapacity);
        const newIsAvailable = new BitSet(newCapacity);

        let newAvailableCount = 0;
        for (let i = 0; i < this._availableCount; i++) {
            const idx = this._available[i];
            if (idx < newCapacity) {
                newAvailable[newAvailableCount] = idx;
                newIsAvailable.set(idx, true);
                newAvailableCount++;
            }
        }

        for (let i = 0; i < newCapacity; i++) {
            if (!newIsAvailable.get(i)) {
                newAvailable[newAvailableCount] = i;
                newIsAvailable.set(i, true);
                newAvailableCount++;
            }
        }

        this._available = newAvailable;
        this._isAvailable = newIsAvailable;
        this._availableCount = newAvailableCount;
        this._capacity = newCapacity;
    }

    public reserve(): number {

        if (this._availableCount === 0) {
            throw new Error("No available indices to reserve");
        }

        this._availableCount--;
        const index = this._available[this._availableCount];

        if (!this._isAvailable.get(index)) {
            throw new Error(`Index ${index} already reserved`);
        }

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

        this._isAvailable.set(index, true);

        if (this._availableCount >= this._capacity) {
            throw new Error("Available buffer overflow on free");
        }

        this._available[this._availableCount] = index;
        this._availableCount++;
    }
}