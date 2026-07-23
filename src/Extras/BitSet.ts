/**
 * Callback used by bitset iteration helpers.
 *
 * Return `false` to stop iteration early.
 */
export type TOkForeachCallback = (index: number) => void | boolean;

/**
 * Read-only bitset interface.
 *
 * Provides access to bit values, search helpers, and filtered iteration.
 */
export interface IReadonlyBitSet {
    /**
     * Total number of bits in the set.
     */
    readonly size: number;

    /**
     * The value returned by the bitset when it is in a fully cleared state.
     */
    readonly clearValue: boolean;

    /**
     * Returns the bit value at the specified index.
     *
     * @param index Bit index.
     * @returns Bit value at the given index.
     */
    get(index: number): boolean;

    /**
     * Finds the first bit matching the requested value.
     *
     * @param value Bit value to search for.
     * @returns The first matching index, or -1 if none was found.
     */
    findFirst(value: boolean): number;

    /**
     * Iterates over all bits matching the requested value.
     *
     * @param value Bit value to filter by.
     * @param callback Called for every matching bit index.
     * @remarks Returning `false` from the callback stops iteration early.
     */
    forEachFilter(value: boolean, callback: TOkForeachCallback): void;
}

export class BitSet implements IReadonlyBitSet {

    private _array: Uint32Array;
    private _clean: boolean;
    private _cleanValue: boolean;
    private _size: number;
    private _bitsInLast: number;
    private _lastIsOutcast: boolean;
    private _lastFullWordIdx: number;

    public get size() {
        return this._size;
    }

    public get clearValue() {
        return this._cleanValue;
    }

    constructor(size: number, clearValue: boolean = false) {
        this._array = new Uint32Array(Math.ceil(size / 32));
        this._bitsInLast = size % 32 || 32;
        this._lastIsOutcast = this._bitsInLast !== 32;
        this._lastFullWordIdx = this._lastIsOutcast ? this._array.length - 1 : this._array.length;
        this._cleanValue = clearValue;
        this._clean = false;
        this._size = size;
        this.clear();
    }

    /**
     * Copies bit values from another bitset.
     *
     * If source and destination sizes differ, the common range is copied and
     * the remaining destination bits are filled with the destination clear value.
     *
     * @param source Source bitset.
     */
    public copyValues(source: BitSet) {

        const cleanValue = this._cleanValue ? 0xffffffff : 0;
        const srcArr = source._array;
        const dstArr = this._array;

        const dstLen = dstArr.length;
        const srcLen = srcArr.length;
        const minLen = Math.min(dstLen, srcLen);
        const lastIdx = minLen - 1;

        let cleanState = true;

        for (let i = 0; i < lastIdx; i++) {
            const v = srcArr[i];
            if (v !== cleanValue) {
                cleanState = false;
            }
            dstArr[i] = v;
        }

        if (minLen > 0) {
            let v = srcArr[lastIdx];

            if (source._lastIsOutcast && lastIdx === srcLen - 1) {
                const srcMask = source._bitsInLast === 32
                    ? 0xffffffff
                    : ((1 << source._bitsInLast) - 1) >>> 0;
                v &= srcMask;
            }

            if (this._lastIsOutcast && lastIdx === dstLen - 1) {
                const tailMask = this._bitsInLast === 32
                    ? 0xffffffff
                    : ((1 << this._bitsInLast) - 1) >>> 0;
                v &= tailMask;
            }

            if (v !== cleanValue) {
                cleanState = false;
            }

            dstArr[lastIdx] = v;
        }

        if (dstLen > srcLen) {
            dstArr.fill(cleanValue, srcLen);
        }

        this._clean = cleanState;
    }

    /**
     * Clears the bitset to its clean state.
     *
     * The resulting value of all bits is controlled by `clearValue`.
     */
    public clear() {
        if (this._clean === false) {
            this._clean = true;
            const value = this._cleanValue ? 0xffffffff : 0;
            const arr = this._array;
            arr.fill(value);
        }
    }

    /**
     * Returns the bit value at the specified index.
     *
     * @param index Bit index.
     * @returns Bit value at the given index.
     */
    public get(index: number): boolean {

        if (this._clean) {
            return this._cleanValue;
        }

        const word = index >>> 5;
        const bit  = index & 31;
        return ((this._array[word] >>> bit) & 1) !== 0;
    }

    /**
     * Sets the bit value at the specified index.
     *
     * @param index Bit index.
     * @param value New bit value.
     */
    public set(index: number, value: boolean) {

        if (this._cleanValue !== value) {
            this._clean = false;
        }
        else if (this._clean) {

            // Array cleaned and set clean value
            // not need update
            return;
        }

        const word = index >>> 5;
        const mask = 1 << (index & 31);

        if (value) {
            this._array[word] |= mask;
        } else {
            this._array[word] &= ~mask;
        }
    }

    /**
     * Replaces the bit value at the specified index and returns the previous value.
     *
     * @param index Bit index.
     * @param value New bit value.
     * @returns Previous bit value at the given index.
     */
    public exchange(index: number, value: boolean): boolean {

        if (this._cleanValue !== value) {
            this._clean = false;
        }
        else if (this._clean) {

            // Array cleaned and set clean value
            // not need update
            return this._cleanValue;
        }

        const array = this._array;
        const word  = index >>> 5;
        const mask  = 1 << (index & 31);
        const prev  = (array[word] & mask) !== 0;

        if (prev !== value) {

            if (value) {
                array[word] |= mask;
            } else {
                array[word] &= ~mask;
            }
        }

        return prev;
    }

    /**
     * Finds the first bit matching the requested value.
     *
     * @param value Bit value to search for.
     * @returns The first matching index, or -1 if none was found.
     */
    public findFirst(value: boolean): number {

        let firstIndex = -1;
        this.forEachFilter(value, (index) => {
            firstIndex = index;
            return false;
        });

        return firstIndex;
    }

    /**
     * Iterates over all bits matching the requested value.
     *
     * @param value Bit value to filter by.
     * @param callback Called for every matching bit index.
     * @remarks Returning `false` from the callback stops iteration early.
     */
    public forEachFilter(value: boolean, callback: TOkForeachCallback): void {

        const size = this._size;
        const arr = this._array;

        if (this._clean) {

            // All values meet the condition
            if (this._cleanValue === value) {

                for (let idx = 0; idx < size; idx++) {
                    const res = callback(idx);
                    if (res === false) return;
                }
            }

            return;
        }

        // If last block has 32 bits
        // handle in normal circle
        const lastFullWordIdx = this._lastFullWordIdx;

        for (let wordIdx = 0; wordIdx < lastFullWordIdx; wordIdx++) {

            const base = wordIdx << 5;
            let word = arr[wordIdx];

            // inverted word
            if (!value) {
                word ^= 0xffffffff;
            }

            while (word !== 0) {
                const lsb = word & -word;
                const bit = 31 - Math.clz32(lsb);
                if (callback(base + bit) === false) return;
                word ^= lsb;
            }
        }

        // handle tail
        if (this._lastIsOutcast) {

            const base = lastFullWordIdx << 5;
            const word = arr[lastFullWordIdx];
            const bits = this._bitsInLast;
            const gogo = value ? 1 : 0;

            for (let bit = 0; bit < bits; bit++) {
                if (((word >> bit) & 1) === gogo) {
                    const idx = base + bit;
                    const res = callback(idx);
                    if (res === false) return;
                }
            }
        }
    }
}