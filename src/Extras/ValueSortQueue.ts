const POWER = 3;
const BIT_MAX = 32;
const BIN_BITS = 1 << POWER;
const BIN_SIZE = 1 << BIN_BITS;
const BIN_SIZE_REV = BIN_SIZE - 2;
const BIN_MAX = BIN_SIZE - 1;
const ITERATIONS = BIT_MAX / BIN_BITS;

const bins = new Array<Uint32Array>(ITERATIONS);
const binsLen = (ITERATIONS + 1) * BIN_SIZE; 
const binsBuffer = new ArrayBuffer(binsLen * 4);
const binsMainArr = new Uint32Array(binsBuffer, 0, binsLen);

let c = 0;
for (let i = 0; i < (ITERATIONS + 1); i++) {
    bins[i] = new Uint32Array(binsBuffer, c, BIN_SIZE);
    c += BIN_SIZE * 4;
}

export type TEditableArray<T> = {
    [index: number]: T;
}

export class ValueSortQueue {

    protected _tempIndices1: Uint32Array;
    protected _tempIndices2: Uint32Array;

    protected _minMaxBuffer: ArrayBuffer;
    protected _minMaxDataF: Float32Array;
    protected _minMaxDataU: Uint32Array;

    protected _buffer: ArrayBuffer;
    protected _dataF: Float32Array;
    protected _dataU: Uint32Array;

    protected _optimizationMaxBitsReady: boolean;
    protected _maxBits: number;
    protected _count: number;
    protected _min: number;
    protected _max: number;

    public get count() { return this._count; }
    public get min() { return this._min; }
    public get max() { return this._max; }

    public constructor(capacity: number, indices1?: Uint32Array, indices2?: Uint32Array) {
        this._tempIndices1 = indices1 ?? new Uint32Array(capacity);
        this._tempIndices2 = indices2 ?? new Uint32Array(capacity);
        this._minMaxBuffer = new ArrayBuffer(8);
        this._minMaxDataF = new Float32Array(this._minMaxBuffer);
        this._minMaxDataU = new Uint32Array(this._minMaxBuffer);
        this._buffer = new ArrayBuffer(capacity * 4);
        this._dataF = new Float32Array(this._buffer);
        this._dataU = new Uint32Array(this._buffer);
        this.clear();
    }

    public clear() {
        this._count = 0;
        this._min = Infinity;
        this._max = -Infinity;
        this._optimizationMaxBitsReady = false;
        this._maxBits = BIT_MAX;
    }

    public enqueueUint(value: number) {

        // ignore negative values
        value = Math.max(value, 0);

        const queueIndex = this._count++;
        this._dataU[queueIndex] = value;

        if (this._min > value) {
            this._min = value;
            this._minMaxDataU[0] = value;
        }

        if (this._max < value) {
            this._max = value;
            this._minMaxDataU[1] = value;
        }
    }

    public enqueueFloat(value: number) {

        // ignore negative values
        value = Math.max(value, 0);

        const queueIndex = this._count++;
        this._dataF[queueIndex] = value;

        if (this._min > value) {
            this._min = value;
            this._minMaxDataF[0] = value;
        }

        if (this._max < value) {
            this._max = value;
            this._minMaxDataF[1] = value;
        }
    }

    public _optimizationForMaxBits() {

        // float32 -> Uint32 check endian ?

        if (this._optimizationMaxBitsReady) {
            return this._maxBits;
        }

        if (this._count < 2) {
            return 0;
        }

        const min = this._minMaxDataU[0];
        const max = this._minMaxDataU[1];
        const range = max - min;

        if (range > 0) {

            const maxBit = range === 0 ? 0 : 32 - Math.clz32(range);
            const neededPasses = Math.ceil(maxBit / BIN_BITS);

            // Applying optimization to ignore high-order bytes.
            if (neededPasses < 4) {
                const n = this._count;
                for (let i = 0; i < n; i++) {
                    this._dataU[i] -= min;
                }
            }

            this._maxBits = neededPasses * BIN_BITS;
        }
        else {
            this._maxBits = 0; // all equals
        }

        this._optimizationMaxBitsReady = true;

        return this._maxBits;
    }

    public sort(reversed: boolean = false): Uint32Array {

        const n = this._count;
        const values = this._dataU;
        const tempIndices1 = this._tempIndices1;
        const tempIndices2 = this._tempIndices2;
        const maxBits = this._optimizationForMaxBits();

        let src: Uint32Array = tempIndices1;
        let dst: Uint32Array = tempIndices2;

        if (maxBits < BIN_BITS || n < 2) {
            if (reversed) for (let i = 0; i < n; i++) src[i] = n - i - 1;
            else          for (let i = 0; i < n; i++) src[i] = i;
            return src;
        }

        binsMainArr.fill(0);

        let shift = 0;
        let step = 0;
        let bin = bins[step];

        for (let i = 0; i < n; i++) {
            src[i] = i;
            bin[(values[i] >>> shift) & BIN_MAX]++;
        }

        while (true) {

            if (reversed) {
                for (let i = BIN_SIZE_REV; i > -1; i--) {
                    bin[i] += bin[i + 1];
                }
            }
            else {
                for (let i = 1; i < BIN_SIZE; i++) {
                    bin[i] += bin[i - 1];
                }
            }

            for (let i = n - 1; i > -1; i--) {
                const idx = src[i];
                dst[--bin[(values[idx] >>> shift) & BIN_MAX]] = idx;
            }

            shift += BIN_BITS;
            step++;

            const tmp = src;
            /* */ src = dst;
            /* */ dst = tmp;

            if (shift >= maxBits) {
                break;
            }

            bin = bins[step];

            for (let i = 0; i < n; i++) {
                bin[(values[src[i]] >>> shift) & BIN_MAX]++;
            }
        }

        return src;
    }

    public sortQueueSingle<T>(queue: TEditableArray<T>, reversed: boolean = false): void {

        const n   = this._count;
        const src = this.sort(reversed);

        for (let i = 0; i < n; i++) {

            let cur  = i;
            let next = src[i];

            if (next === cur) continue;

            let tmp = queue[cur];

            while (next !== i) {
                queue[cur] = queue[next];
                const newNext = src[next];
                src[next] = next;
                cur = next;
                next = newNext;
            }

            queue[cur] = tmp;
            src[i] = i;
        }
    }

    public sortQueueComplicated<T>(queue: TEditableArray<T>, itemSize: number = 1, reversed: boolean = false, itemBuffer?: TEditableArray<T>) {

        const n   = this._count;
        const src = this.sort(reversed);
        const tmp = itemBuffer ?? new Array<T>(itemSize);

        for (let i = 0; i < n; i++) {

            let cur = i;
            let next = src[i];

            if (next === cur) continue;

            for (let k = 0; k < itemSize; k++) {
                tmp[k] = queue[cur * itemSize + k];
            }

            while (next !== i) {
                const fromBase = next * itemSize;
                const toBase = cur * itemSize;
                for (let k = 0; k < itemSize; k++) {
                    queue[toBase + k] = queue[fromBase + k];
                }
                const newNext = src[next];
                src[next] = next;
                cur = next;
                next = newNext;
            }

            const finalBase = cur * itemSize;
            for (let k = 0; k < itemSize; k++) {
                queue[finalBase + k] = tmp[k];
            }
            src[i] = i;
        }
    }

    public sortQueue<T>(queue: TEditableArray<T>, itemSize: number = 1, reversed: boolean = false, itemBuffer?: TEditableArray<T>): void {
        if (itemSize === 1) {
            this.sortQueueSingle(queue, reversed);
        }
        else {
            this.sortQueueComplicated(queue, itemSize, reversed, itemBuffer);
        }
    }
}