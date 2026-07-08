const POWER = 3;
const BIT_MAX = 32;
const BIN_BITS = 1 << POWER;
const BIN_SIZE = 1 << BIN_BITS;
const BIN_MAX = BIN_SIZE - 1;
const ITERATIONS = BIT_MAX / BIN_BITS;
const ITERATIONS_MAX = ITERATIONS - 1;

const bins = new Array<Uint32Array>(ITERATIONS);
const bins_buffer = new ArrayBuffer((ITERATIONS + 1) * BIN_SIZE * 4);

let c = 0;
for (let i = 0; i < (ITERATIONS + 1); i++) {
	bins[i] = new Uint32Array(bins_buffer, c, BIN_SIZE);
	c += BIN_SIZE * 4;
}

const defaultGet = (el: any) => el;

export type TEditableArray<T> = {
    [index: number]: T;
}

/**
 * Hybrid radix sort from.
 *
 * Expects unsigned 32b integer values.
 */
export const radixSort = <T>(arr: TEditableArray<T>, aux: TEditableArray<T>, len: number, reversed: boolean = false, get: (el: T) => number = defaultGet) => {

	const data = [arr, aux];

	let compare, accumulate, recurse;

	if (reversed) {

		compare = (a: number, b: number) => a < b;
		accumulate = (bin: Uint32Array) => {
			for (let j = BIN_SIZE - 2; j >= 0; j--)
				bin[j] += bin[j + 1];
		};

		recurse = (cache: Uint32Array, depth: number, start: number) => {
			let prev = 0;
			for (let j = BIN_MAX; j >= 0; j--) {
				const cur = cache[j], diff = cur - prev;
				if (diff != 0) {
					if (diff > 32)
						radixSortBlock(depth + 1, start + prev, diff);
					else
						insertionSortBlock(depth + 1, start + prev, diff);
					prev = cur;
				}
			}
		};

	} else {

		compare = (a: number, b: number) => a > b;
		accumulate = (bin: Uint32Array) => {
			for (let j = 1; j < BIN_SIZE; j ++)
				bin[j] += bin[j - 1];
		};

		recurse = (cache: Uint32Array, depth: number, start: number) => {
			let prev = 0;
			for (let j = 0; j < BIN_SIZE; j++) {
				const cur = cache[j], diff = cur - prev;
				if (diff != 0) {
					if (diff > 32)
						radixSortBlock(depth + 1, start + prev, diff);
					else
						insertionSortBlock(depth + 1, start + prev, diff);
					prev = cur;
				}
			}
		};
	}

	const insertionSortBlock = (depth: number, start: number, len: number) => {

		const a = data[depth & 1];
		const b = data[(depth + 1) & 1];

		for (let j = start + 1; j < start + len; j++) {

			const p = a[j], t = get(p) >>> 0;
			let i = j;
			while (i > start) {
				if (compare(get(a[i - 1]) >>> 0, t))
					a[i] = a[--i];
				else
					break;
			}

			a[i] = p;
		}

		if ((depth & 1) == 1) {
			for (let i = start; i < start + len; i++)
				b[i] = a[i];
		}

	};

	const radixSortBlock = (depth: number, start: number, len: number) => {

		const a = data[depth & 1];
		const b = data[(depth + 1) & 1];

		const shift = (3 - depth) << POWER;
		const end = start + len;

		const cache = bins[depth];
		const bin = bins[depth + 1];

		bin.fill(0);

		for (let j = start; j < end; j++)
			bin[(get(a[j]) >>> shift) & BIN_MAX]++;

		accumulate(bin);

		cache.set(bin);

		for (let j = end - 1; j >= start; j--)
			b[start + --bin[(get(a[j]) >>> shift) & BIN_MAX]] = a[j];

		if (depth == ITERATIONS_MAX) return;

		recurse(cache, depth, start);
	};

	radixSortBlock(0, 0, len);
};