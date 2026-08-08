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

    /**
     * Counts bits matching the requested value.
     *
     * @param value Bit value to count (`true` or `false`).
     * @returns Number of matching bits.
     */
    count(value: boolean): number;
}

/** Mask covering the lowest `bits` bits of a 32-bit word (`bits` in 1..32). */
function tailMask(bits: number): number {
    return bits === 32 ? 0xffffffff : ((1 << bits) - 1) >>> 0;
}

/** Lowest-set-bit index within a non-zero 32-bit word. */
function lowestBitIndex(word: number): number {
    return 31 - Math.clz32(word & -word);
}

/** Number of set bits in a 32-bit word. */
function popcount(word: number): number {
    let n = word >>> 0;
    n = n - ((n >>> 1) & 0x55555555);
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export class BitSet implements IReadonlyBitSet {

    private _array: Uint32Array;
    private _clean: boolean;
    private _cleanValue: boolean;
    private _size: number;
    private _bitsInLast: number;
    /** True when the last word stores fewer than 32 valid bits. */
    private _hasPartialLastWord: boolean;
    /** Exclusive end index of full 32-bit words (partial last word starts here). */
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
        this._hasPartialLastWord = this._bitsInLast !== 32;
        this._lastFullWordIdx = this._hasPartialLastWord ? this._array.length - 1 : this._array.length;
        this._cleanValue = clearValue;
        this._clean = false;
        this._size = size;
        this.clear();
    }

    private _cleanWord(): number {
        return this._cleanValue ? 0xffffffff : 0;
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

        const cleanWord = this._cleanWord();
        const srcArr = source._array;
        const dstArr = this._array;
        const srcSize = source._size;
        const dstSize = this._size;
        const copyCount = Math.min(srcSize, dstSize);

        const fullCopyWords = copyCount >>> 5;
        const copyRemBits = copyCount & 31;

        let cleanState = true;

        for (let i = 0; i < fullCopyWords; i++) {
            const v = srcArr[i];
            if (v !== cleanWord) {
                cleanState = false;
            }
            dstArr[i] = v;
        }

        let wordIdx = fullCopyWords;

        if (copyRemBits > 0 || dstSize > srcSize) {
            // Build the word that contains the end of the copied range and/or
            // the start of the clearValue fill (same word when growing in-place).
            const copyMask = copyRemBits === 0 ? 0 : tailMask(copyRemBits);
            let v = copyRemBits > 0 ? (srcArr[wordIdx] & copyMask) : 0;

            if (dstSize > srcSize) {
                // Bits [srcSize, min(dstSize, wordEnd)) get clearValue.
                const bitsInThisWord = wordIdx === dstArr.length - 1 && this._hasPartialLastWord
                    ? this._bitsInLast
                    : 32;
                const fillMask = (tailMask(bitsInThisWord) ^ copyMask) >>> 0;
                v = (v | (cleanWord & fillMask)) >>> 0;
            }
            else if (this._hasPartialLastWord && wordIdx === dstArr.length - 1) {
                // Shrinking into a partial last word: drop unused high bits.
                v &= tailMask(this._bitsInLast);
            }

            // Normalize unused high bits so clean detection matches clear().
            if (this._hasPartialLastWord && wordIdx === dstArr.length - 1) {
                const unused = (~tailMask(this._bitsInLast)) >>> 0;
                v = (v & tailMask(this._bitsInLast) | (cleanWord & unused)) >>> 0;
            }

            if (v !== cleanWord) {
                cleanState = false;
            }

            dstArr[wordIdx] = v;
            wordIdx++;
        }

        if (wordIdx < dstArr.length) {
            dstArr.fill(cleanWord, wordIdx);
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
            this._array.fill(this._cleanWord());
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
        const bit = index & 31;
        return ((this._array[word] >>> bit) & 1) !== 0;
    }

    /**
     * Shared write path for set/exchange. Returns the previous bit value.
     * When `readPrev` is false, the returned value is undefined and must be ignored.
     */
    private _writeBit(index: number, value: boolean, readPrev: boolean): boolean {

        if (this._cleanValue !== value) {
            this._clean = false;
        }
        else if (this._clean) {
            return this._cleanValue;
        }

        const array = this._array;
        const word = index >>> 5;
        const mask = (1 << (index & 31)) >>> 0;
        const prev = readPrev ? (array[word] & mask) !== 0 : value;

        if (!readPrev || prev !== value) {
            if (value) {
                array[word] |= mask;
            }
            else {
                array[word] &= ~mask;
            }
        }

        return prev;
    }

    /**
     * Sets the bit value at the specified index.
     *
     * @param index Bit index.
     * @param value New bit value.
     */
    public set(index: number, value: boolean) {
        this._writeBit(index, value, false);
    }

    /**
     * Replaces the bit value at the specified index and returns the previous value.
     *
     * @param index Bit index.
     * @param value New bit value.
     * @returns Previous bit value at the given index.
     */
    public exchange(index: number, value: boolean): boolean {
        return this._writeBit(index, value, true);
    }

    /**
     * Counts bits matching the requested value.
     *
     * @param value Bit value to count (`true` or `false`).
     * @returns Number of matching bits.
     */
    public count(value: boolean): number {

        const size = this._size;

        if (size === 0) {
            return 0;
        }

        if (this._clean) {
            return this._cleanValue === value ? size : 0;
        }

        const arr = this._array;
        const lastFullWordIdx = this._lastFullWordIdx;
        let total = 0;

        for (let wordIdx = 0; wordIdx < lastFullWordIdx; wordIdx++) {
            total += popcount(arr[wordIdx]);
        }

        if (this._hasPartialLastWord) {
            total += popcount(arr[lastFullWordIdx] & tailMask(this._bitsInLast));
        }

        return value ? total : size - total;
    }

    /**
     * Finds the first bit matching the requested value.
     *
     * @param value Bit value to search for.
     * @returns The first matching index, or -1 if none was found.
     */
    public findFirst(value: boolean): number {

        const size = this._size;

        if (size === 0) {
            return -1;
        }

        if (this._clean) {
            return this._cleanValue === value ? 0 : -1;
        }

        const arr = this._array;
        const lastFullWordIdx = this._lastFullWordIdx;

        for (let wordIdx = 0; wordIdx < lastFullWordIdx; wordIdx++) {

            let word = arr[wordIdx];
            if (!value) {
                word ^= 0xffffffff;
            }

            if (word !== 0) {
                return (wordIdx << 5) + lowestBitIndex(word);
            }
        }

        if (this._hasPartialLastWord) {

            const base = lastFullWordIdx << 5;
            const word = arr[lastFullWordIdx];
            const bits = this._bitsInLast;
            const want = value ? 1 : 0;

            for (let bit = 0; bit < bits; bit++) {
                if (((word >>> bit) & 1) === want) {
                    return base + bit;
                }
            }
        }

        return -1;
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

            if (this._cleanValue === value) {
                for (let idx = 0; idx < size; idx++) {
                    if (callback(idx) === false) return;
                }
            }

            return;
        }

        const lastFullWordIdx = this._lastFullWordIdx;

        for (let wordIdx = 0; wordIdx < lastFullWordIdx; wordIdx++) {

            const base = wordIdx << 5;
            let word = arr[wordIdx];

            if (!value) {
                word ^= 0xffffffff;
            }

            while (word !== 0) {
                const lsb = word & -word;
                const bit = lowestBitIndex(lsb);
                if (callback(base + bit) === false) return;
                word ^= lsb;
            }
        }

        if (this._hasPartialLastWord) {

            const base = lastFullWordIdx << 5;
            const word = arr[lastFullWordIdx];
            const bits = this._bitsInLast;
            const want = value ? 1 : 0;

            for (let bit = 0; bit < bits; bit++) {
                if (((word >>> bit) & 1) === want) {
                    if (callback(base + bit) === false) return;
                }
            }
        }
    }
}
