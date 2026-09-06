import pc from "../../engine.js";
import { OCCLUSION_OCCLUDED, OCCLUSION_VISIBLE, type TOcclusionResult } from "../IOcclusionCullingTester.js";

const NEAR_EPS = 1e-5;

const _srcMat = new pc.Mat4();
const _dstMat = new pc.Mat4();
const _invMat = new pc.Mat4();
const _reprojectMat = new pc.Mat4();

/**
 * CPU occlusion over a packed 256×128 (or current cap) device-depth buffer.
 * Reprojects a previous-frame capture into the current camera, then tests AABBs
 * by comparing NDC min-z against the max device-z of every pixel in the AABB's
 * screen rectangle.
 */
export class CoverageCpuBuffer {

    private _width = 0;
    private _height = 0;
    private _hw = 0;
    private _hh = 0;
    private _n0 = 0;
    private _data: Float32Array = new Float32Array(0);
    private _scratch: Float32Array = new Float32Array(0);
    private _srcDepth: Float32Array = new Float32Array(0);
    private _srcVP = new Float32Array(16);
    private _dstVP = new Float32Array(16);
    private _globalMin = 1;
    private _globalMax = 1;
    private _hasSrc = false;
    private _built = false;

    public get width() { return this._width; }
    public get height() { return this._height; }

    /** Packed buffer after reprojection into the current camera (device Z). */
    public get depth() { return this._data; }
    public get valid() { return this._built && this._n0 > 0; }

    public resize(width: number, height: number) {

        if (width === this._width && height === this._height && this._n0 > 0) {
            return;
        }

        this._width = width | 0;
        this._height = height | 0;
        this._hw = this._width * 0.5;
        this._hh = this._height * 0.5;
        this._n0 = this._width * this._height;
        this._data = new Float32Array(this._n0);
        this._scratch = new Float32Array(this._n0);
        this._srcDepth = new Float32Array(this._n0);
        this._data.fill(1);
        this._hasSrc = false;
        this._built = false;
    }

    public setSource(src: Float32Array, srcVP: Float32Array) {
        if (src.length < this._n0) {
            return;
        }
        this._srcDepth.set(src.subarray(0, this._n0));
        this._srcVP.set(srcVP);
        this._hasSrc = true;
        this._built = false;
    }

    /**
     * Rebuild the test buffer in `dstVP`. Identity (same matrix as capture) copies without scatter.
     */
    public update(dstVP: Float32Array) {

        if (!this._hasSrc || this._n0 <= 0) {
            return;
        }

        if (this._built && vpEquals(this._dstVP, dstVP)) {
            return;
        }

        this._dstVP.set(dstVP);

        if (vpEquals(this._srcVP, dstVP)) {
            this._data.set(this._srcDepth.subarray(0, this._n0), 0);
        }
        else {
            this._reproject(this._srcDepth, this._srcVP, dstVP);
        }

        this._refreshRange();
        this._built = true;
    }

    public testAabb(
        cx: number, cy: number, cz: number,
        hx: number, hy: number, hz: number,
        vp: Float32Array
    ): TOcclusionResult {

        if (!this._built) {
            return OCCLUSION_VISIBLE;
        }

        if (!projectAabb(vp, cx, cy, cz, hx, hy, hz)) {
            return OCCLUSION_VISIBLE;
        }

        if (_projMaxZ >= 1) {
            return OCCLUSION_VISIBLE;
        }

        if (_projMaxX < -1 || _projMinX > 1 || _projMaxY < -1 || _projMinY > 1) {
            return OCCLUSION_VISIBLE;
        }

        const pxW = (_projMaxX - _projMinX) * this._hw;
        const pxH = (_projMaxY - _projMinY) * this._hh;
        if (pxW < 1 && pxH < 1) {
            return OCCLUSION_VISIBLE;
        }

        if (_projMinZ > this._globalMax) {
            return OCCLUSION_OCCLUDED;
        }

        if (_projMaxZ < this._globalMin) {
            return OCCLUSION_VISIBLE;
        }

        return this._rectOccluded(_projMinX, _projMinY, _projMaxX, _projMaxY, _projMinZ)
            ? OCCLUSION_OCCLUDED
            : OCCLUSION_VISIBLE;
    }

    private _reproject(src: Float32Array, srcVP: Float32Array, dstVP: Float32Array) {

        const w = this._width;
        const h = this._height;
        const n = this._n0;
        const lastX = w - 1;
        const lastY = h - 1;
        const dest = this._data;
        dest.fill(1, 0, n);

        _srcMat.data.set(srcVP);
        _dstMat.data.set(dstVP);
        _invMat.copy(_srcMat);
        _invMat.invert();
        _reprojectMat.mul2(_dstMat, _invMat);
        const r = _reprojectMat.data;
        const r0 = r[0], r1 = r[1], r2 = r[2], r3 = r[3];
        const r4 = r[4], r5 = r[5], r6 = r[6], r7 = r[7];
        const r8 = r[8], r9 = r[9], r10 = r[10], r11 = r[11];
        const r12 = r[12], r13 = r[13], r14 = r[14], r15 = r[15];
        const ndcStepX = 2 / w;
        const ndcStepY = 2 / h;
        const sxk = w * 0.5;
        const syk = h * 0.5;

        for (let y = 0; y < h; y++) {

            const ndcY = (y + 0.5) * ndcStepY - 1;
            const srcRow = y * w;
            const cwY = r7 * ndcY + r15;
            const nxY = r4 * ndcY + r12;
            const nyY = r5 * ndcY + r13;
            const nzY = r6 * ndcY + r14;

            for (let x = 0; x < w; x++) {

                const z = src[srcRow + x];
                if (!(z < 1)) {
                    continue;
                }

                const ndcX = (x + 0.5) * ndcStepX - 1;
                const cw = r3 * ndcX + r11 * z + cwY;
                if (cw <= NEAR_EPS) {
                    continue;
                }

                const invCw = 1 / cw;
                const nx = (r0 * ndcX + r8 * z + nxY) * invCw;
                const ny = (r1 * ndcX + r9 * z + nyY) * invCw;
                if (nx < -1 || nx > 1 || ny < -1 || ny > 1) {
                    continue;
                }

                const nz = (r2 * ndcX + r10 * z + nzY) * invCw;

                let x0 = (sxk * nx + sxk) | 0;
                let y0 = (syk * ny + syk) | 0;
                if (x0 > lastX) x0 = lastX;
                else if (x0 < 0) x0 = 0;
                if (y0 > lastY) y0 = lastY;
                else if (y0 < 0) y0 = 0;

                const di = y0 * w + x0;
                const prev = dest[di];
                if (prev === 1 || nz > prev) {
                    dest[di] = nz;
                }
            }
        }

        dilateMin3x3(dest, this._scratch, w, h);
    }

    private _refreshRange() {

        const data = this._data;
        const n = this._n0;
        let min = 1;
        let max = 0;

        for (let i = 0; i < n; i++) {
            const d = data[i];
            if (d < min) min = d;
            if (d > max) max = d;
        }

        this._globalMin = min;
        this._globalMax = max;
    }

    /**
     * Occluded iff every covered pixel is closer than `minZ` (`minZ > max(rect)`).
     * Returns visible as soon as any pixel is at or behind `minZ`.
     */
    private _rectOccluded(
        ndcMinX: number, ndcMinY: number, ndcMaxX: number, ndcMaxY: number,
        minZ: number
    ) {

        const w = this._width;
        const h = this._height;
        const lastX = w - 1;
        const lastY = h - 1;

        const ux0 = ndcToUv(ndcMinX);
        const uy0 = ndcToUv(ndcMinY);
        const ux1 = ndcToUv(ndcMaxX);
        const uy1 = ndcToUv(ndcMaxY);

        let x0 = (ux0 * w) | 0;
        let y0 = (uy0 * h) | 0;
        const rx1 = ux1 * w;
        const ry1 = uy1 * h;
        const ix1 = rx1 | 0;
        const iy1 = ry1 | 0;
        let x1 = (ix1 === rx1 ? ix1 : ix1 + 1) - 1;
        let y1 = (iy1 === ry1 ? iy1 : iy1 + 1) - 1;

        if (x0 > lastX) x0 = lastX;
        if (y0 > lastY) y0 = lastY;
        if (x1 > lastX) x1 = lastX;
        if (y1 > lastY) y1 = lastY;
        if (x1 < x0) x1 = x0;
        if (y1 < y0) y1 = y0;

        const data = this._data;
        for (let y = y0; y <= y1; y++) {
            let index = y * w + x0;
            const end = index + (x1 - x0);
            for (; index <= end; index++) {
                if (data[index] >= minZ) {
                    return false;
                }
            }
        }

        return true;
    }
}

let _projMinX = 0;
let _projMinY = 0;
let _projMinZ = 0;
let _projMaxX = 0;
let _projMaxY = 0;
let _projMaxZ = 0;

/**
 * Separable 3×3 min (device Z). Expands occluders by 1px and closes scatter
 * holes; cheaper than a branched 8-neighborhood pass.
 */
function dilateMin3x3(src: Float32Array, tmp: Float32Array, w: number, h: number) {

    if (w < 2 || h < 2) {
        return;
    }

    const lastX = w - 1;
    const lastY = h - 1;

    for (let y = 0; y < h; y++) {

        const row = y * w;
        const rowEnd = row + lastX;
        const a = src[row];
        const b = src[row + 1];
        tmp[row] = a < b ? a : b;

        for (let i = row + 1; i < rowEnd; i++) {
            let m = src[i - 1];
            const c = src[i];
            const r = src[i + 1];
            if (c < m) m = c;
            if (r < m) m = r;
            tmp[i] = m;
        }

        const p = src[rowEnd - 1];
        const q = src[rowEnd];
        tmp[rowEnd] = p < q ? p : q;
    }

    for (let x = 0; x < w; x++) {
        const a = tmp[x];
        const b = tmp[x + w];
        src[x] = a < b ? a : b;
    }

    for (let y = 1; y < lastY; y++) {

        const row = y * w;
        const up = row - w;
        const down = row + w;

        for (let x = 0; x < w; x++) {
            let m = tmp[up + x];
            const c = tmp[row + x];
            const d = tmp[down + x];
            if (c < m) m = c;
            if (d < m) m = d;
            src[row + x] = m;
        }
    }

    const lastRow = lastY * w;
    const prevRow = lastRow - w;
    for (let x = 0; x < w; x++) {
        const a = tmp[prevRow + x];
        const b = tmp[lastRow + x];
        src[lastRow + x] = a < b ? a : b;
    }
}

function ndcToUv(ndc: number) {
    const n = ndc * 0.5 + 0.5;
    return n < 0 ? 0 : n > 1 ? 1 : n;
}

function vpEquals(a: Float32Array, b: Float32Array) {
    for (let i = 0; i < 16; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

function projectAabb(
    m: Float32Array,
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number
): boolean {

    let minX = 1;
    let minY = 1;
    let minZ = 1;
    let maxX = -1;
    let maxY = -1;
    let maxZ = -1;

    for (let i = 0; i < 8; i++) {
        const px = cx + ((i & 1) ? hx : -hx);
        const py = cy + ((i & 2) ? hy : -hy);
        const pz = cz + ((i & 4) ? hz : -hz);
        const cw = m[3] * px + m[7] * py + m[11] * pz + m[15];
        if (cw <= NEAR_EPS) {
            return false;
        }
        const invW = 1 / cw;
        const ndcX = (m[0] * px + m[4] * py + m[8] * pz + m[12]) * invW;
        const ndcY = (m[1] * px + m[5] * py + m[9] * pz + m[13]) * invW;
        const ndcZ = (m[2] * px + m[6] * py + m[10] * pz + m[14]) * invW;
        if (ndcX < minX) minX = ndcX;
        if (ndcY < minY) minY = ndcY;
        if (ndcZ < minZ) minZ = ndcZ;
        if (ndcX > maxX) maxX = ndcX;
        if (ndcY > maxY) maxY = ndcY;
        if (ndcZ > maxZ) maxZ = ndcZ;
    }

    _projMinX = minX;
    _projMinY = minY;
    _projMinZ = minZ;
    _projMaxX = maxX;
    _projMaxY = maxY;
    _projMaxZ = maxZ;
    return true;
}
