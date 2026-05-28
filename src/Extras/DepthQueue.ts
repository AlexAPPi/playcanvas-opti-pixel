const MAX_BITS = 32;
const BITS_PER_PASS = 8;
const MASK = 0xff;

export type TEditableArray<T> = {
    [index: number]: T;
}

export class DepthQueue {

    protected _counters: Uint32Array;
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

    public constructor(capacity: number) {
        this._counters = new Uint32Array(256);
        this._tempIndices1 = new Uint32Array(capacity);
        this._tempIndices2 = new Uint32Array(capacity);
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
        this._maxBits = MAX_BITS;
    }

    public enqueue(depth: number) {

        // ignore negative values
        depth = Math.max(depth, 0);

        const queueIndex = this._count++;
        this._dataF[queueIndex] = depth;

        if (this._min > depth) {
            this._min = depth;
            this._minMaxDataF[0] = depth;
        }

        if (this._max < depth) {
            this._max = depth;
            this._minMaxDataF[1] = depth;
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
            const neededPasses = Math.ceil(maxBit / BITS_PER_PASS);

            // Applying optimization to ignore high-order bytes.
            if (neededPasses < 4) {
                const n = this._count;
                for (let i = 0; i < n; i++) {
                    this._dataU[i] -= min;
                }
            }

            this._maxBits = neededPasses * BITS_PER_PASS;
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
        const counters = this._counters;
        const tempIndices1 = this._tempIndices1;
        const tempIndices2 = this._tempIndices2;
        const maxBits = this._optimizationForMaxBits();

        let src: Uint32Array = tempIndices1;
        let dst: Uint32Array = tempIndices2;

        if (maxBits < BITS_PER_PASS || n < 2) {
            for (let i = 0; i < n; i++) {
                src[i] = i;
            }
            return src;
        }

        let shift = 0;
        resolveZeroStep();
        resolveCounters();
        resolveIndexes();

        while (shift < maxBits) {
            shift += BITS_PER_PASS;
            resolveNextStep();
            resolveCounters();
            resolveIndexes();
        }

        function resolveZeroStep() {
            for (let i = 0; i < 256; i++) counters[i] = 0;
            for (let i = 0; i < n; i++) {
                const byte = (values[i] >> shift) & MASK;
                counters[byte]++;
                src[i] = i;
            }
        }

        function resolveNextStep() {
            for (let i = 0; i < 256; i++) counters[i] = 0;
            for (let i = 0; i < n; i++) {
                const idx = src[i];
                const byte = (values[idx] >> shift) & MASK;
                counters[byte]++;
            }
        }

        function resolveIndexes() {

            for (let i = 0; i < n; i++) {
                const idx = src[i];
                const byte = (values[idx] >> shift) & MASK;
                dst[counters[byte]] = idx;
                counters[byte]++;
            }

            // Swap indexes
            const tmp = src;
            src = dst;
            dst = tmp;
        }

        function resolveCounters() {

            let summ = 0;

            if (reversed) {

                for (let i = 255; i > -1; i--) {
                    const c = counters[i];
                    counters[i] = summ;
                    summ += c;
                }
            }
            else {

                for (let i = 0; i < 256; i++) {
                    const c = counters[i];
                    counters[i] = summ;
                    summ += c;
                }
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

    public sortQueueComplicated(queue: Uint32Array, itemSize: number = 1, reversed: boolean = false) {

        // TODO: itemSize more 256 ?
        // use count buffer for copy items

        const n   = this._count;
        const src = this.sort(reversed);
        const tmp = this._counters;

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

    public sortQueue(queue: Uint32Array<ArrayBuffer>, itemSize: number = 1, reversed: boolean = false): void {
        if (itemSize === 1) {
            this.sortQueueSingle(queue, reversed);
        }
        else {
            this.sortQueueComplicated(queue, itemSize, reversed);
        }
    }

    public sortQueueObjects<T>(objects: T[], reversed: boolean = false): void {
        return this.sortQueueSingle(objects, reversed);
    }
}

// @ts-ignore
window.testDepthQueue = (min: number = 1, max: number = 100, length: number = 300, count: number = 22) => {
    const random = (min: number, max: number) => Math.random() * (max - min) + min;
    const tmp = new DepthQueue(count);
    const tmpArray = new Array(length);
    for (let i = 0; i < length; i++) {
        tmpArray[i] = random(min, max);
    }
    const queue = new Uint32Array(tmpArray);
    console.log(tmpArray);
    tmp.clear();
    for (let i = 0; i < count; i++) {
        tmp.enqueue(tmpArray[i]);
    }
    console.log(tmp);
    console.log(tmp.min);
    console.log(tmp.max);
    console.log(tmp.sort().slice());
    console.log(tmp.sort(true).slice());
    const queue1 = queue.slice(0, count);
    const queue2 = queue.slice(0, count);
    const queue3 = queue.slice(0, count);
    const queue4 = queue.slice(0, count);
    tmp.sortQueueSingle(queue1);
    tmp.sortQueueSingle(queue2, true);
    tmp.sortQueueComplicated(queue3, 1);
    tmp.sortQueueComplicated(queue4, 1, true);
    console.log(queue1, queue2, queue3, queue4);
}