
export type TOkForeachCallback = (index: number) => void | boolean;

export class BitSet {

    private _array: Uint32Array;
    private _clean: boolean;
    private _cleanValue: boolean;
    private _size: number;
    private _bitsInLast: number;

    constructor(size: number, clearValue: boolean = false) {
        this._array = new Uint32Array(Math.ceil(size / 32));
        this._bitsInLast = size % 32 || 32;
        this._cleanValue = clearValue;
        this._clean = false;
        this._size = size;
        this.clear();
    }

    public clear() {
        if (this._clean === false) {
            this._clean = true;
            const value = this._cleanValue ? 0xffffffff : 0;
            const arr = this._array;
            const length = arr.length;
            for (let i = 0; i < length; i++) {
                arr[i] = value;
            }
        }
    }

    public get(index: number): boolean {
        const word = index >>> 5;
        const bit  = index & 31;
        return ((this._array[word] >>> bit) & 1) !== 0;
    }

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
        const bit  = index & 31;

        if (value) {
            this._array[word] |= (1 << bit);
        } else {
            this._array[word] &= ~(1 << bit);
        }
    }

    public exchange(index: number, value: boolean): boolean {

        if (this._cleanValue !== value) {
            this._clean = false;
        }
        else if (this._clean) {

            // Array cleaned and set clean value
            // not need update
            return this._cleanValue;
        }

        const word = index >>> 5;
        const bit  = index & 31;
        const prev = ((this._array[word] >>> bit) & 1) !== 0;

        if (prev !== value) {

            if (value) {
                this._array[word] |= (1 << bit);
            } else {
                this._array[word] &= ~(1 << bit);
            }
        }

        return prev;
    }

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
        const lastIsOutcast = this._bitsInLast !== 32;
        const lastFullWordIdx = lastIsOutcast ? arr.length - 1 : arr.length;

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

        if (lastIsOutcast) {

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