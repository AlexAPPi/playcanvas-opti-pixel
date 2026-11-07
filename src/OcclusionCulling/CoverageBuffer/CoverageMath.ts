import type { IHierarchicalZBuffer } from "../HZB/IHierarchicalZBuffer";

export type THzbShaderKind = 'f16' | 'f32' | 'depth';

export function hzbShaderKind(hzb: IHierarchicalZBuffer): THzbShaderKind {
    if (hzb.isFloat16()) {
        return 'f16';
    }
    if (hzb.isFloat32() || !hzb.isColor()) {
        return 'f32';
    }
    return 'depth';
}

/** Floor log2 for positive integers. `0` -> `0`. */
export function integerLog2(n: number) {
    n = n >>> 0;
    if (n === 0) {
        return 0;
    }
    return 31 - Math.clz32(n);
}

/**
 * Whole texels for a continuous footprint, at least 1 and at most `cap`.
 * Rounded, not ceiled: a fractional tail given its own cell shifts the map
 * by almost one pixel.
 */
function packCount(span: number, cap: number) {
    return Math.min(cap, Math.max(1, Math.round(span)));
}

/** Smallest power of two >= `n` (clamped so `n <= 1` -> `1`). */
export function nextPow2(n: number) {
    n = n | 0;
    if (n <= 1) {
        return 1;
    }
    return 1 << (32 - Math.clz32(n - 1));
}

export interface ICoverageMip {
    /** Stored HZB mip. `0` is the first stored level of the pyramid. */
    level: number;
    /** Width of that mip, in texels. */
    width: number;
    /** Height of that mip, in texels. */
    height: number;
    /**
     * CPU map width. Screen footprint of {@link width}, clamped to `maxWidth`.
     * Pixel `i` covers screen UV `[i / packWidth, (i + 1) / packWidth]`.
     */
    packWidth: number;
    /**
     * CPU map height. Screen footprint of {@link height}, clamped to `maxHeight`.
     */
    packHeight: number;
    /** Continuous screen footprint on X, in mip texels (`width * uvFactor`). */
    spanX: number;
    /** Continuous screen footprint on Y. See {@link spanX}. */
    spanY: number;
    /** Whole HZB texels that intersect {@link spanX}. The pack clamps fetches to this. */
    texelCountX: number;
    /** Whole HZB texels that intersect {@link spanY}. */
    texelCountY: number;
}

/**
 * Upper bound on source texels per packed pixel, per axis. A half-open span
 * of length `L` can touch `floor(L) + 2` texels, so the pack steps to a
 * coarser mip while `L >= 3`. The shaders walk that bin directly.
 */
const COVERAGE_GATHER = 4;
const COVERAGE_MAX_SPAN = COVERAGE_GATHER - 1;

/**
 * Mip level whose size is nearest to `target`. `0` when the base is already
 * at or under the target. Rounded in log2, so the chosen size stays within
 * √2 of `target` when a stored mip exists on both sides.
 */
function nearestAxisLevel(base: number, target: number, levels: number) {
    const last = levels - 1;
    if (last <= 0 || base <= target) {
        return 0;
    }
    const level = Math.round(Math.log2(base / target));
    if (level <= 0) {
        return 0;
    }
    return level < last ? level : last;
}

interface ICoverageFootprint {
    /** Continuous screen coverage in mip texels (`mipSize * uv`). */
    span: number;
    /** Whole texels that intersect that span. An exact integer does not round up into padding. */
    count: number;
}

/**
 * Texels of one mip axis the screen actually covers. `uv` is the pyramid's
 * screen-to-mip scale (≤ 1): `uv * mipSize` is the half-open span, and the
 * pow2 padding past that span is not packed.
 */
function screenFootprint(mipSize: number, uv: number): ICoverageFootprint {
    const size = mipSize > 1 ? mipSize : 1;
    const scale = uv > 0 ? uv : 1;
    const span = size * scale;
    const count = Math.min(size, Math.max(1, Math.ceil(span - 1e-4)));
    return { span, count };
}

/**
 * Stored HZB mip nearest to `maxWidth` × `maxHeight`, and the CPU map size
 * of that mip's screen footprint.
 *
 * Each axis picks its nearest stored level; the coarser of the two is used,
 * so neither axis is finer than its own nearest mip. `uvFactor` is the
 * pyramid's screen-to-mip scale and already includes a WebGL `minMipLevel`.
 * The packed size is the rounded screen footprint, clamped to the max.
 * Pixel `i` covers screen UV `[i / pack, (i + 1) / pack]` and the shader
 * reads the HZB texels under that slice. If the clamp would still cover
 * three or more source texels per packed pixel, the next coarser mip is used.
 */
export function selectCoverageMip(
    hzbWidth: number,
    hzbHeight: number,
    mipLevels: number,
    maxWidth: number,
    maxHeight: number,
    uvFactorX = 1,
    uvFactorY = 1
): ICoverageMip {

    const levels = Math.max(1, mipLevels | 0);
    const baseW = Math.max(1, hzbWidth | 0);
    const baseH = Math.max(1, hzbHeight | 0);
    const capW = Math.max(1, maxWidth | 0);
    const capH = Math.max(1, maxHeight | 0);
    const ux = uvFactorX > 0 ? uvFactorX : 1;
    const uy = uvFactorY > 0 ? uvFactorY : 1;

    let level = nearestAxisLevel(baseW, capW, levels);
    const levelH = nearestAxisLevel(baseH, capH, levels);
    if (levelH > level) {
        level = levelH;
    }

    let width = Math.max(1, baseW >> level);
    let height = Math.max(1, baseH >> level);

    let footX = screenFootprint(width, ux);
    let footY = screenFootprint(height, uy);

    while (level < levels - 1) {
        const packW = packCount(footX.span, capW);
        const packH = packCount(footY.span, capH);
        if (footX.span / packW < COVERAGE_MAX_SPAN && footY.span / packH < COVERAGE_MAX_SPAN) {
            break;
        }
        level++;
        width = Math.max(1, baseW >> level);
        height = Math.max(1, baseH >> level);
        footX = screenFootprint(width, ux);
        footY = screenFootprint(height, uy);
    }

    const packWidth = packCount(footX.span, capW);
    const packHeight = packCount(footY.span, capH);

    return {
        level,
        width,
        height,
        packWidth,
        packHeight,
        spanX: footX.span,
        spanY: footY.span,
        texelCountX: footX.count,
        texelCountY: footY.count
    };
}
