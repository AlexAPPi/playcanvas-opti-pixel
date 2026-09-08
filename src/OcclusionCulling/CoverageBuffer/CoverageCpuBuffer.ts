import { OCCLUSION_OCCLUDED, OCCLUSION_VISIBLE, type TOcclusionResult } from "../IOcclusionCullingTester.js";

export function integerLog2(n: number) {
    n = n >>> 0;
    if (n === 0) {
        return 0;
    }
    return 31 - Math.clz32(n);
}

const NEAR_EPS = 1e-5;

const _inv = new Float32Array(16);
const _reproject = new Float32Array(16);

const _cx = new Float32Array(8);
const _cy = new Float32Array(8);
const _cz = new Float32Array(8);
const _cw = new Float32Array(8);

const EDGE0 = new Uint8Array([0, 2, 4, 6, 0, 1, 4, 5, 0, 1, 2, 3]);
const EDGE1 = new Uint8Array([1, 3, 5, 7, 2, 3, 6, 7, 4, 5, 6, 7]);

let _minX = 0, _minY = 0;
let _maxX = 0, _maxY = 0;
let _minEye = 0, _maxEye = 0;
let _t0 = 0, _t1 = 1;
let _rangeMin = 1, _rangeMax = 1;

/**
 * CPU occlusion over a 256×128 (or current cap) **view-space Z** buffer (metres).
 * No heap allocs in update / testAabb.
 */
export class CoverageCpuBuffer {

    /**
     * World AABB inflate as a fraction of camera-to-box distance.
     * 0 (default): distant boxes keep a tight screen rect and true nearest Z.
     * 0.02 is the old behaviour — it scales without bound and kills far culls.
     */
    public aabbExpand = 0;

    /**
     * Extra coverage pixels around the projected rect. Covers 1–2 frames of
     * camera motion without growing minZ or exploding far AABBs.
     * Use 0 for tighter far culls (tiny rects will not pick up sky texels).
     */
    public rectPadPixels = 0;

    private _width = 0;
    private _height = 0;
    private _n0 = 0;
    private _data: Float32Array = new Float32Array(0);
    private _scratch: Float32Array = new Float32Array(0);
    private _srcDepth: Float32Array = new Float32Array(0);
    private _srcVP = new Float32Array(16);
    private _dstVP = new Float32Array(16);
    private _srcParams = new Float32Array(4);
    private _dstParams = new Float32Array(4);
    private _srcNear = 0.1;
    private _srcFar = 1000;
    private _srcOrtho = false;
    private _dstNear = 0.1;
    private _dstFar = 1000;
    private _dstOrtho = false;
    private _globalMin = 1;
    private _globalMax = 1;
    private _camX = 0;
    private _camY = 0;
    private _camZ = 0;
    private _hasSrc = false;
    private _built = false;

    public get width() { return this._width; }
    public get height() { return this._height; }
    public get depth() { return this._data; }
    public get valid() { return this._built && this._n0 > 0; }
    public get farClip() { return this._dstFar; }

    public resize(width: number, height: number) {

        if (width === this._width && height === this._height && this._n0 > 0) {
            return;
        }

        this._width = width | 0;
        this._height = height | 0;
        this._n0 = this._width * this._height;
        this._data = new Float32Array(this._n0);
        this._scratch = new Float32Array(this._n0);
        this._srcDepth = new Float32Array(this._n0);
        this._data.fill(1e10);
        this._hasSrc = false;
        this._built = false;
    }

    public setSource(src: Float32Array, srcVP: Float32Array, srcParams: Float32Array) {

        const n = this._n0;
        if (src.length < n) {
            return;
        }

        const dst = this._srcDepth;
        if (src.length === n) {
            // Same storage as the readback queue until the next harvest steals it.
            this._srcDepth = src;
        }
        else {
            for (let i = 0; i < n; i++) {
                dst[i] = src[i];
            }
        }

        copy16(this._srcVP, srcVP);
        this._srcParams[0] = srcParams[0];
        this._srcParams[1] = srcParams[1];
        this._srcParams[2] = srcParams[2];
        this._srcParams[3] = srcParams[3];
        this._srcFar = srcParams[1];
        this._srcNear = srcParams[2];
        this._srcOrtho = srcParams[3] !== 0;
        this._hasSrc = true;
        this._built = false;
    }

    public update(dstVP: Float32Array, camX: number, camY: number, camZ: number, dstParams: Float32Array) {

        this._camX = camX;
        this._camY = camY;
        this._camZ = camZ;
        this._dstParams[0] = dstParams[0];
        this._dstParams[1] = dstParams[1];
        this._dstParams[2] = dstParams[2];
        this._dstParams[3] = dstParams[3];
        this._dstFar = dstParams[1];
        this._dstNear = dstParams[2];
        this._dstOrtho = dstParams[3] !== 0;

        if (!this._hasSrc || this._n0 <= 0) {
            return;
        }

        if (this._built && eq16(this._dstVP, dstVP)) {
            return;
        }

        copy16(this._dstVP, dstVP);

        if (eq16(this._srcVP, dstVP)) {
            copyWithRange(this._data, this._srcDepth, this._n0);
        }
        else {
            this._reproject(this._srcDepth, this._srcVP, dstVP);
        }

        this._globalMin = _rangeMin;
        this._globalMax = _rangeMax;
        this._built = true;
    }

    public testAabb(
        cx: number, cy: number, cz: number,
        hx: number, hy: number, hz: number,
        vp: Float32Array,
        view: Float32Array
    ): TOcclusionResult {

        if (!this._built) {
            return OCCLUSION_VISIBLE;
        }

        const dx = absf(this._camX - cx) - hx;
        const dy = absf(this._camY - cy) - hy;
        const dz = absf(this._camZ - cz) - hz;
        const ex = dx > 0 ? dx : 0;
        const ey = dy > 0 ? dy : 0;
        const ez = dz > 0 ? dz : 0;

        let expand = 0;
        if (this.aabbExpand > 0) {
            expand = this.aabbExpand * Math.sqrt(ex * ex + ey * ey + ez * ez);
            hx += expand;
            hy += expand;
            hz += expand;
        }

        if (dx <= expand &&
            dy <= expand &&
            dz <= expand) {
            return OCCLUSION_VISIBLE;
        }

        aabbEyeRange(view, cx, cy, cz, hx, hy, hz);
        let minEye = _minEye;
        const maxEye = _maxEye;
        if (minEye < this._dstNear) {
            minEye = this._dstNear;
        }
        if (minEye >= this._dstFar) {
            return OCCLUSION_VISIBLE;
        }

        if (minEye > this._globalMax) {
            return OCCLUSION_OCCLUDED;
        }

        if (maxEye < this._globalMin) {
            return OCCLUSION_VISIBLE;
        }

        if (!projectAabb(vp, cx, cy, cz, hx, hy, hz)) {
            return OCCLUSION_VISIBLE;
        }

        if (_maxX < -1 || _minX > 1 ||
            _maxY < -1 || _minY > 1) {
            return OCCLUSION_VISIBLE;
        }

        return this._rectOccluded(_minX, _minY, _maxX, _maxY, minEye)
            ? OCCLUSION_OCCLUDED
            : OCCLUSION_VISIBLE;
    }

    private _reproject(src: Float32Array, srcVP: Float32Array, dstVP: Float32Array) {

        if (!invert16(_inv, srcVP)) {
            copyWithRange(this._data, src, this._n0);
            return;
        }

        mul16(_reproject, dstVP, _inv);

        const w = this._width;
        const h = this._height;
        const lastX = w - 1;
        const lastY = h - 1;
        const dest = this._data;
        const emptyZ = this._dstFar;
        const srcFar = this._srcFar;
        const srcNear = this._srcNear;
        const srcOrtho = this._srcOrtho;
        const dstNear = this._dstNear;
        const dstFar = this._dstFar;
        const dstOrtho = this._dstOrtho;

        dest.fill(emptyZ);

        const r = _reproject;
        const r0 = r[0], r1 = r[1], r2 = r[2], r3 = r[3];
        const r4 = r[4], r5 = r[5], r6 = r[6], r7 = r[7];
        const r8 = r[8], r9 = r[9], r10 = r[10], r11 = r[11];
        const r12 = r[12], r13 = r[13], r14 = r[14], r15 = r[15];
        const ndcStepX = 2 / w;
        const ndcStepY = 2 / h;
        const sxk = w * 0.5;
        const syk = h * 0.5;
        const nfSrc = srcNear * srcFar;
        const invDiffSrc = 1 / (srcNear - srcFar);
        const nfDst = dstNear * dstFar;
        const diffDst = dstNear - dstFar;
        const srcRange = srcFar - srcNear;
        const dstRange = dstFar - dstNear;
        const persp = !srcOrtho && !dstOrtho;

        for (let y = 0; y < h; y++) {

            const ndcY = (y + 0.5) * ndcStepY - 1;
            const srcRow = y * w;
            const cwY = r7 * ndcY + r15;
            const nxY = r4 * ndcY + r12;
            const nyY = r5 * ndcY + r13;
            const nzY = r6 * ndcY + r14;

            for (let x = 0; x < w; x++) {

                const L = src[srcRow + x];
                if (!(L > 0 && L < srcFar)) {
                    continue;
                }

                const z = srcOrtho
                    ? (srcRange === 0 ? 0 : (L - srcNear) / srcRange)
                    : (nfSrc / L - srcFar) * invDiffSrc;
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
                if (!(nz > 0 && nz < 1)) {
                    continue;
                }

                let x0 = (sxk * nx + sxk) | 0;
                let y0 = (syk * ny + syk) | 0;
                if (x0 > lastX) x0 = lastX;
                else if (x0 < 0) x0 = 0;
                if (y0 > lastY) y0 = lastY;
                else if (y0 < 0) y0 = 0;

                const L2 = persp || !dstOrtho
                    ? nfDst / (dstFar + nz * diffDst)
                    : dstNear + nz * dstRange;
                const di = y0 * w + x0;
                if (L2 < dest[di]) {
                    dest[di] = L2;
                }
            }
        }

        fillHolesFar3x3(dest, this._scratch, w, h, emptyZ);
    }

    private _rectOccluded(
        ndcMinX: number, ndcMinY: number, ndcMaxX: number, ndcMaxY: number,
        minZ: number
    ) {

        const w = this._width;
        const h = this._height;
        const lastX = w - 1;
        const lastY = h - 1;

        let x0 = ndcToPixel(ndcMinX, w);
        let y0 = ndcToPixel(ndcMinY, h);
        const rx1 = ndcToPixelEnd(ndcMaxX, w);
        const ry1 = ndcToPixelEnd(ndcMaxY, h);
        let x1 = rx1;
        let y1 = ry1;

        if (x0 > lastX) x0 = lastX;
        if (y0 > lastY) y0 = lastY;
        if (x1 > lastX) x1 = lastX;
        if (y1 > lastY) y1 = lastY;
        if (x1 < x0) x1 = x0;
        if (y1 < y0) y1 = y0;

        const pad = this.rectPadPixels | 0;
        if (pad > 0) {
            x0 -= pad;
            y0 -= pad;
            x1 += pad;
            y1 += pad;
            if (x0 < 0) x0 = 0;
            if (y0 < 0) y0 = 0;
            if (x1 > lastX) x1 = lastX;
            if (y1 > lastY) y1 = lastY;
        }

        const data = this._data;
        for (let y = y0; y <= y1; y++) {
            let index = y * w + x0;
            const end = index + (x1 - x0);
            for (; index <= end; index++) {
                if (data[index] > minZ) {
                    return false;
                }
            }
        }

        return true;
    }
}

function copyWithRange(dst: Float32Array, src: Float32Array, n: number) {

    let min = 1e30;
    let max = 0;

    for (let i = 0; i < n; i++) {
        const d = src[i];
        dst[i] = d;
        if (d < min) min = d;
        if (d > max) max = d;
    }

    _rangeMin = min;
    _rangeMax = max;
}

function fillHolesFar3x3(data: Float32Array, tmp: Float32Array, w: number, h: number, emptyZ: number) {

    let min = 1e30;
    let max = 0;
    const n = w * h;

    if (w < 2 || h < 2) {
        for (let i = 0; i < n; i++) {
            const d = data[i];
            if (d < min) min = d;
            if (d > max) max = d;
        }
        _rangeMin = min;
        _rangeMax = max;
        return;
    }

    tmp.set(data);

    const lastX = w - 1;
    const lastY = h - 1;

    for (let y = 0; y < h; y++) {

        const y0 = y > 0 ? y - 1 : 0;
        const y1 = y < lastY ? y + 1 : lastY;

        for (let x = 0; x < w; x++) {

            const i = y * w + x;
            let d = tmp[i];

            if (!(d < emptyZ)) {

                const x0 = x > 0 ? x - 1 : 0;
                const x1 = x < lastX ? x + 1 : lastX;
                let m = 0;
                let found = false;

                for (let yy = y0; yy <= y1; yy++) {
                    const row = yy * w;
                    for (let xx = x0; xx <= x1; xx++) {
                        const z = tmp[row + xx];
                        if (z < emptyZ) {
                            found = true;
                            if (z > m) {
                                m = z;
                            }
                        }
                    }
                }

                d = found ? m : emptyZ;
                data[i] = d;
            }

            if (d < min) min = d;
            if (d > max) max = d;
        }
    }

    _rangeMin = min;
    _rangeMax = max;
}

function ndcToPixel(ndc: number, size: number) {
    let u = ndc * 0.5 + 0.5;
    if (u < 0) u = 0;
    else if (u > 1) u = 1;
    return (u * size) | 0;
}

function ndcToPixelEnd(ndc: number, size: number) {
    let u = ndc * 0.5 + 0.5;
    if (u < 0) u = 0;
    else if (u > 1) u = 1;
    const r = u * size;
    const i = r | 0;
    return (i === r ? i : i + 1) - 1;
}

function aabbEyeRange(
    view: Float32Array,
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number
) {
    const v2 = view[2], v6 = view[6], v10 = view[10], v14 = view[14];
    const c = -(v2 * cx + v6 * cy + v10 * cz + v14);
    const r = absf(v2) * hx + absf(v6) * hy + absf(v10) * hz;
    _minEye = c - r;
    _maxEye = c + r;
}

function absf(v: number) {
    return v < 0 ? -v : v;
}

function copy16(dst: Float32Array, src: Float32Array) {
    dst[0] = src[0]; dst[1] = src[1]; dst[2] = src[2]; dst[3] = src[3];
    dst[4] = src[4]; dst[5] = src[5]; dst[6] = src[6]; dst[7] = src[7];
    dst[8] = src[8]; dst[9] = src[9]; dst[10] = src[10]; dst[11] = src[11];
    dst[12] = src[12]; dst[13] = src[13]; dst[14] = src[14]; dst[15] = src[15];
}

function eq16(a: Float32Array, b: Float32Array) {
    for (let i = 0; i < 16; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

function mul16(out: Float32Array, a: Float32Array, b: Float32Array) {

    const a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3];
    const a4 = a[4], a5 = a[5], a6 = a[6], a7 = a[7];
    const a8 = a[8], a9 = a[9], a10 = a[10], a11 = a[11];
    const a12 = a[12], a13 = a[13], a14 = a[14], a15 = a[15];

    const b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
    const b4 = b[4], b5 = b[5], b6 = b[6], b7 = b[7];
    const b8 = b[8], b9 = b[9], b10 = b[10], b11 = b[11];
    const b12 = b[12], b13 = b[13], b14 = b[14], b15 = b[15];

    out[0] = a0 * b0 + a4 * b1 + a8 * b2 + a12 * b3;
    out[1] = a1 * b0 + a5 * b1 + a9 * b2 + a13 * b3;
    out[2] = a2 * b0 + a6 * b1 + a10 * b2 + a14 * b3;
    out[3] = a3 * b0 + a7 * b1 + a11 * b2 + a15 * b3;
    out[4] = a0 * b4 + a4 * b5 + a8 * b6 + a12 * b7;
    out[5] = a1 * b4 + a5 * b5 + a9 * b6 + a13 * b7;
    out[6] = a2 * b4 + a6 * b5 + a10 * b6 + a14 * b7;
    out[7] = a3 * b4 + a7 * b5 + a11 * b6 + a15 * b7;
    out[8] = a0 * b8 + a4 * b9 + a8 * b10 + a12 * b11;
    out[9] = a1 * b8 + a5 * b9 + a9 * b10 + a13 * b11;
    out[10] = a2 * b8 + a6 * b9 + a10 * b10 + a14 * b11;
    out[11] = a3 * b8 + a7 * b9 + a11 * b10 + a15 * b11;
    out[12] = a0 * b12 + a4 * b13 + a8 * b14 + a12 * b15;
    out[13] = a1 * b12 + a5 * b13 + a9 * b14 + a13 * b15;
    out[14] = a2 * b12 + a6 * b13 + a10 * b14 + a14 * b15;
    out[15] = a3 * b12 + a7 * b13 + a11 * b14 + a15 * b15;
}

function invert16(out: Float32Array, m: Float32Array) {

    const m00 = m[0], m01 = m[1], m02 = m[2], m03 = m[3];
    const m10 = m[4], m11 = m[5], m12 = m[6], m13 = m[7];
    const m20 = m[8], m21 = m[9], m22 = m[10], m23 = m[11];
    const m30 = m[12], m31 = m[13], m32 = m[14], m33 = m[15];

    const b00 = m00 * m11 - m01 * m10;
    const b01 = m00 * m12 - m02 * m10;
    const b02 = m00 * m13 - m03 * m10;
    const b03 = m01 * m12 - m02 * m11;
    const b04 = m01 * m13 - m03 * m11;
    const b05 = m02 * m13 - m03 * m12;
    const b06 = m20 * m31 - m21 * m30;
    const b07 = m20 * m32 - m22 * m30;
    const b08 = m20 * m33 - m23 * m30;
    const b09 = m21 * m32 - m22 * m31;
    const b10 = m21 * m33 - m23 * m31;
    const b11 = m22 * m33 - m23 * m32;

    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (det === 0) {
        return false;
    }
    det = 1 / det;

    out[0]  = ( m11 * b11 - m12 * b10 + m13 * b09) * det;
    out[1]  = (-m01 * b11 + m02 * b10 - m03 * b09) * det;
    out[2]  = ( m31 * b05 - m32 * b04 + m33 * b03) * det;
    out[3]  = (-m21 * b05 + m22 * b04 - m23 * b03) * det;
    out[4]  = (-m10 * b11 + m12 * b08 - m13 * b07) * det;
    out[5]  = ( m00 * b11 - m02 * b08 + m03 * b07) * det;
    out[6]  = (-m30 * b05 + m32 * b02 - m33 * b01) * det;
    out[7]  = ( m20 * b05 - m22 * b02 + m23 * b01) * det;
    out[8]  = ( m10 * b10 - m11 * b08 + m13 * b06) * det;
    out[9]  = (-m00 * b10 + m01 * b08 - m03 * b06) * det;
    out[10] = ( m30 * b04 - m31 * b02 + m33 * b00) * det;
    out[11] = (-m20 * b04 + m21 * b02 - m23 * b00) * det;
    out[12] = (-m10 * b09 + m11 * b07 - m12 * b06) * det;
    out[13] = ( m00 * b09 - m01 * b07 + m02 * b06) * det;
    out[14] = (-m30 * b03 + m31 * b01 - m32 * b00) * det;
    out[15] = ( m20 * b03 - m21 * b01 + m22 * b00) * det;
    return true;
}

function addPoint(x: number, y: number, w: number) {

    if (w <= NEAR_EPS) {
        return;
    }

    const invW = 1 / w;
    const nx = x * invW;
    const ny = y * invW;
    if (nx < _minX) _minX = nx;
    if (ny < _minY) _minY = ny;
    if (nx > _maxX) _maxX = nx;
    if (ny > _maxY) _maxY = ny;
}

function clipPlane(d0: number, d1: number) {

    if (d0 < 0) {
        if (d1 < 0) {
            return false;
        }
        const t = d0 / (d0 - d1);
        if (t > _t0) {
            _t0 = t;
        }
        return _t0 <= _t1;
    }
    if (d1 >= 0) {
        return true;
    }
    const t = d0 / (d0 - d1);
    if (t < _t1) {
        _t1 = t;
    }
    return _t0 <= _t1;
}

function addEdge(i0: number, i1: number) {

    const x0 = _cx[i0], y0 = _cy[i0], z0 = _cz[i0], w0 = _cw[i0];
    const x1 = _cx[i1], y1 = _cy[i1], z1 = _cz[i1], w1 = _cw[i1];

    _t0 = 0;
    _t1 = 1;

    if (!clipPlane(w0 - NEAR_EPS, w1 - NEAR_EPS)) return;
    if (!clipPlane(x0 + w0, x1 + w1)) return;
    if (!clipPlane(w0 - x0, w1 - x1)) return;
    if (!clipPlane(y0 + w0, y1 + w1)) return;
    if (!clipPlane(w0 - y0, w1 - y1)) return;
    if (!clipPlane(z0, z1)) return;
    if (!clipPlane(w0 - z0, w1 - z1)) return;

    const t0 = _t0;
    const t1 = _t1;
    addPoint(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0, w0 + (w1 - w0) * t0);
    addPoint(x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1, w0 + (w1 - w0) * t1);
}

function projectAabb(
    m: Float32Array,
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number
) {

    const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3];
    const m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7];
    const m8 = m[8], m9 = m[9], m10 = m[10], m11 = m[11];
    const m12 = m[12], m13 = m[13], m14 = m[14], m15 = m[15];

    const ecx = m0 * cx + m4 * cy + m8 * cz + m12;
    const ecy = m1 * cx + m5 * cy + m9 * cz + m13;
    const ecz = m2 * cx + m6 * cy + m10 * cz + m14;
    const ecw = m3 * cx + m7 * cy + m11 * cz + m15;
    const ax = m0 * hx, ay = m1 * hx, az = m2 * hx, aw = m3 * hx;
    const bx = m4 * hy, by = m5 * hy, bz = m6 * hy, bw = m7 * hy;
    const dx = m8 * hz, dy = m9 * hz, dz = m10 * hz, dw = m11 * hz;

    let insideMask = 0;
    let andOut = 127;
    let minX = 1, minY = 1, maxX = -1, maxY = -1;

    for (let i = 0; i < 8; i++) {

        const sx = (i & 1) * 2 - 1;
        const sy = ((i >> 1) & 1) * 2 - 1;
        const sz = ((i >> 2) & 1) * 2 - 1;
        const x = ecx + sx * ax + sy * bx + sz * dx;
        const y = ecy + sx * ay + sy * by + sz * dy;
        const z = ecz + sx * az + sy * bz + sz * dz;
        const w = ecw + sx * aw + sy * bw + sz * dw;

        _cx[i] = x;
        _cy[i] = y;
        _cz[i] = z;
        _cw[i] = w;

        let out = 0;
        if (w <= NEAR_EPS) out = 1;
        if (x + w < 0) out |= 2;
        if (w - x < 0) out |= 4;
        if (y + w < 0) out |= 8;
        if (w - y < 0) out |= 16;
        if (z < 0) out |= 32;
        if (w - z < 0) out |= 64;
        andOut &= out;

        if (out === 0) {
            insideMask |= 1 << i;
            const invW = 1 / w;
            const nx = x * invW;
            const ny = y * invW;
            if (nx < minX) minX = nx;
            if (ny < minY) minY = ny;
            if (nx > maxX) maxX = nx;
            if (ny > maxY) maxY = ny;
        }
    }

    if (andOut !== 0) {
        return false;
    }

    _minX = minX;
    _minY = minY;
    _maxX = maxX;
    _maxY = maxY;

    if (insideMask === 255) {
        return true;
    }

    for (let e = 0; e < 12; e++) {
        const a = EDGE0[e];
        const b = EDGE1[e];
        if ((insideMask & (1 << a)) && (insideMask & (1 << b))) {
            continue;
        }
        addEdge(a, b);
    }

    return _minX <= _maxX;
}







