export class BitSet {

    private _array: Uint32Array;
    private _clean: boolean;
    private _cleanValue: boolean;

    constructor(size: number, clearValue: boolean = false) {
        this._array = new Uint32Array(Math.ceil(size / 32));
        this._cleanValue = clearValue;
        this._clean = false;
        this.clear();
    }

    public clear() {
        if (this._clean === false) {
            this._clean = true;
            const value = this._cleanValue ? 0xffffffff : 0;
            for (let i = 0; i < this._array.length; i++) {
                this._array[i] = value;
            }
        }
    }

    public get(index: number): boolean {
        const word = index >>> 5;
        const bit = index & 31;
        return (this._array[word] & (1 << bit)) !== 0;
    }

    public set(index: number, value: boolean) {

        const word = index >>> 5;
        const bit = index & 31;

        // unsafe eq for type
        if (this._cleanValue != value) {
            this._clean = false;
        }

        if (value) {
            this._array[word] |= (1 << bit);
        } else {
            this._array[word] &= ~(1 << bit);
        }
    }
}