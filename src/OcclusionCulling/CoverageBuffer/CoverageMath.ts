/** Floor log2 for positive integers. `0` -> `0`. */
export function integerLog2(n: number) {
    n = n >>> 0;
    if (n === 0) {
        return 0;
    }
    return 31 - Math.clz32(n);
}

/** Smallest power of two >= `n` (clamped so `n <= 1` -> `1`). */
export function nextPow2(n: number) {
    n = n | 0;
    if (n <= 1) {
        return 1;
    }
    return 1 << (32 - Math.clz32(n - 1));
}
