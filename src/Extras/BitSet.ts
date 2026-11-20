/**
 * Callback used by bitset iteration helpers.
 *
 * Return `false` to stop iteration early.
 */
export type TOkForeachCallback = (index: number) => void | boolean;

/**
 * Callback used by bitset difference iteration.
 *
 * `value` is the bit the compared set holds at `index`.
 *
 * Return `false` to stop iteration early.
 */
export type TDifferenceForeachCallback = (index: number, value: boolean) => void | boolean;

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
     * Finds the last bit matching the requested value.
     *
     * @param value Bit value to search for.
     * @returns The last matching index, or -1 if none was found.
     */
    findLast(value: boolean): number;

    /**
     * Iterates over all bits matching the requested value.
     *
     * @param value Bit value to filter by.
     * @param callback Called for every matching bit index.
     * @remarks Returning `false` from the callback stops iteration early.
     * @remarks {@link BitSetIterator} walks the same bits without a callback.
     */
    forEachFilter(value: boolean, callback: TOkForeachCallback): void;

    /**
     * Iterates over the bits that differ between this set and `other`.
     *
     * Only the range both sets have in common is compared, so a longer
     * set keeps its trailing bits to itself.
     *
     * @param other Bitset to compare against.
     * @param callback Called for every differing index with the bit `other` holds there.
     * @remarks Returning `false` from the callback stops iteration early.
     * @remarks The callback may write the reported index back into this set,
     * which makes it usable as an incremental "apply the difference" pass.
     */
    forEachDifference(other: IReadonlyBitSet, callback: TDifferenceForeachCallback): void;

    /**
     * Counts bits matching the requested value.
     *
     * @param value Bit value to count (`true` or `false`).
     * @returns Number of matching bits.
     */
    count(value: boolean): number;
}

/** Mask covering the lowest `bits` bits of a 32-bit word (`bits` in 1..32). */
export function tailMask(bits: number): number {
    return bits === 32 ? 0xffffffff : ((1 << bits) - 1) >>> 0;
}

/**
 * XOR mask so a requested bit value becomes a set bit.
 * `0` when looking for ones, `0xffffffff` when looking for zeros.
 */
export function matchInvert(value: boolean): number {
    return value ? 0 : 0xffffffff;
}

/** Lowest-set-bit index within a non-zero 32-bit word. */
export function lowestBitIndex(word: number): number {
    return 31 - Math.clz32(word & -word);
}

/** Highest-set-bit index within a non-zero 32-bit word. */
export function highestBitIndex(word: number): number {
    return 31 - Math.clz32(word);
}

/** Number of set bits in a 32-bit word. */
export function popcount(word: number): number {
    let n = word >>> 0;
    n = n - ((n >>> 1) & 0x55555555);
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * Private storage of {@link BitSet}. Not part of the public surface.
 * The iterator reads these fields through a cast so they can stay private.
 */
export interface IInternalBitSet {
    _array: Uint32Array;
    _clean: boolean;
    _cleanValue: boolean;
    _size: number;
    _lastWordMask: number;
}

export class BitSet implements IReadonlyBitSet {

    private _array: Uint32Array;
    private _clean: boolean;
    private _cleanValue: boolean;
    private _size: number;
    /**
     * Valid bits of the last word, `0xffffffff` when it is full.
     * Bits above the mask keep `clearValue` and are outside the set.
     */
    private _lastWordMask: number;

    public get size() {
        return this._size;
    }

    public get clearValue() {
        return this._cleanValue;
    }

    public constructor(size: number, clearValue: boolean = false) {
        this._array = new Uint32Array(Math.ceil(size / 32));
        this._lastWordMask = tailMask(size % 32 || 32);
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
        const copyCount = Math.min(source._size, this._size);
        const fullWords = copyCount >>> 5;
        const remBits = copyCount & 31;

        let clean = true;

        for (let wordIdx = 0; wordIdx < fullWords; wordIdx++) {
            const word = srcArr[wordIdx];
            if (word !== cleanWord) {
                clean = false;
            }
            dstArr[wordIdx] = word;
        }

        let fillFrom = fullWords;

        if (remBits > 0) {
            // Bits above the copied range hold clearValue, unused high bits included,
            // so the word equals `cleanWord` exactly when clear() would write it.
            const copyMask = tailMask(remBits);
            const word = ((srcArr[fullWords] & copyMask) | (cleanWord & ~copyMask)) >>> 0;
            if (word !== cleanWord) {
                clean = false;
            }
            dstArr[fullWords] = word;
            fillFrom++;
        }

        dstArr.fill(cleanWord, fillFrom);
        this._clean = clean;
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
        const lastWordIdx = arr.length - 1;
        let total = popcount(arr[lastWordIdx] & this._lastWordMask);

        for (let wordIdx = 0; wordIdx < lastWordIdx; wordIdx++) {
            total += popcount(arr[wordIdx]);
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
        const invert = matchInvert(value);
        const lastWordIdx = arr.length - 1;

        for (let wordIdx = 0; wordIdx < lastWordIdx; wordIdx++) {

            const word = arr[wordIdx] ^ invert;

            if (word !== 0) {
                return (wordIdx << 5) + lowestBitIndex(word);
            }
        }

        const lastWord = (arr[lastWordIdx] ^ invert) & this._lastWordMask;

        return lastWord !== 0 ? (lastWordIdx << 5) + lowestBitIndex(lastWord) : -1;
    }

    /**
     * Finds the last bit matching the requested value.
     *
     * @param value Bit value to search for.
     * @returns The last matching index, or -1 if none was found.
     */
    public findLast(value: boolean): number {

        const size = this._size;

        if (size === 0) {
            return -1;
        }

        if (this._clean) {
            return this._cleanValue === value ? size - 1 : -1;
        }

        const arr = this._array;
        const invert = matchInvert(value);
        const lastWordIdx = arr.length - 1;
        const lastWord = (arr[lastWordIdx] ^ invert) & this._lastWordMask;

        if (lastWord !== 0) {
            return (lastWordIdx << 5) + highestBitIndex(lastWord);
        }

        for (let wordIdx = lastWordIdx - 1; wordIdx >= 0; wordIdx--) {

            const word = arr[wordIdx] ^ invert;

            if (word !== 0) {
                return (wordIdx << 5) + highestBitIndex(word);
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
     * @remarks {@link BitSetIterator} walks the same bits without a callback.
     */
    public forEachFilter(value: boolean, callback: TOkForeachCallback): void {

        const size = this._size;

        if (size === 0) {
            return;
        }

        if (this._clean) {

            if (this._cleanValue === value) {
                for (let idx = 0; idx < size; idx++) {
                    if (callback(idx) === false) return;
                }
            }

            return;
        }

        const arr = this._array;
        const invert = matchInvert(value);
        const lastWordIdx = arr.length - 1;

        for (let wordIdx = 0; wordIdx < lastWordIdx; wordIdx++) {

            let word = arr[wordIdx] ^ invert;

            // Redundant with the loop below, but sparse sets scan ~20% faster with it.
            if (word === 0) {
                continue;
            }

            const base = wordIdx << 5;

            while (word !== 0) {
                const lsb = word & -word;
                if (callback(base + 31 - Math.clz32(lsb)) === false) return;
                word ^= lsb;
            }
        }

        const base = lastWordIdx << 5;
        let word = (arr[lastWordIdx] ^ invert) & this._lastWordMask;

        while (word !== 0) {
            const lsb = word & -word;
            if (callback(base + 31 - Math.clz32(lsb)) === false) return;
            word ^= lsb;
        }
    }

    /**
     * Iterates over the bits that differ between this set and `other`.
     *
     * Only the range both sets have in common is compared, so a longer
     * set keeps its trailing bits to itself.
     *
     * @param other Bitset to compare against.
     * @param callback Called for every differing index with the bit `other` holds there.
     * @remarks Returning `false` from the callback stops iteration early.
     * @remarks The callback may write the reported index back into this set,
     * which makes it usable as an incremental "apply the difference" pass.
     */
    public forEachDifference(other: IReadonlyBitSet, callback: TDifferenceForeachCallback): void {

        const size = Math.min(this._size, other.size);

        if (size === 0) {
            return;
        }

        // Foreign implementations expose no words, so compare bit by bit.
        if (!(other instanceof BitSet)) {

            for (let idx = 0; idx < size; idx++) {
                const value = other.get(idx);
                if (value !== this.get(idx) && callback(idx, value) === false) return;
            }

            return;
        }

        if (this._clean && other._clean && this._cleanValue === other._cleanValue) {
            return;
        }

        const thisArr = this._array;
        const otherArr = other._array;
        const numWords = (size + 31) >>> 5;
        const lastWordIdx = numWords - 1;
        const lastWordMask = tailMask(size - (lastWordIdx << 5));

        for (let wordIdx = 0; wordIdx < numWords; wordIdx++) {

            const otherWord = otherArr[wordIdx];

            // Read up front: the callback is allowed to write this word back.
            let diff = thisArr[wordIdx] ^ otherWord;

            if (wordIdx === lastWordIdx) {
                diff &= lastWordMask;
            }

            if (diff === 0) {
                continue;
            }

            const base = wordIdx << 5;

            while (diff !== 0) {
                const lsb = diff & -diff;
                if (callback(base + 31 - Math.clz32(lsb), (otherWord & lsb) !== 0) === false) return;
                diff ^= lsb;
            }
        }
    }
}
