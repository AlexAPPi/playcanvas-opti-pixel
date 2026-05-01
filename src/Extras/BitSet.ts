export class BitSet {

    private _array: Uint32Array;
    private _zeroed: boolean;

    constructor(size: number) {
        this._array = new Uint32Array(Math.ceil(size / 32));
        this._zeroed = true;
    }

    public clear() {

        if (!this._zeroed) {

            this._zeroed = true;

            for (let i = 0; i < this._array.length; i++) {
                this._array[i] = 0;
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

        if (value) {

            this._array[word] |= (1 << bit);

            if (this._zeroed) {
                this._zeroed = false;
            }

        } else {
            this._array[word] &= ~(1 << bit);
        }
    }
}