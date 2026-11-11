import type { TOcclusionResult } from "../IOcclusionCullingTester.js";
import type { ICoverageCpuBuffer } from "./ICoverageCpuBuffer.js";

/**
 * Self-contained CoverageCpuBuffer constructor. Stringified into the coverage
 * worker blob — keep this function free of module-scope values.
 *
 * Lives only inside {@link coverageBufferWorkerMain}. Depth maps and dimensions
 * come from a bound bus + ping-pong output slot.
 *
 * Reprojection scatters every sample of the last capture into the current
 * camera and the nearest one wins. A pixel no sample landed on takes the
 * farthest sample of its 3×3 neighbours, then the depth bias moves every
 * occluder back.
 *
 * The AABB test rasterizes only the faces that look at the camera. A texel
 * occludes when it is nearer than the nearest eye Z of that triangle. After
 * reprojection a max-depth pyramid answers "is this rect fully nearer than Z"
 * so a hidden box (or a large hidden triangle) does not walk every texel.
 *
 * Bus float offsets must match {@link defineCoverageBufferBus} (HEADER_BYTES = 264,
 * `depthBias` immediately after `aabbExpand`).
 */
export function defineCoverageCpuBuffer(): new () => ICoverageCpuBuffer {

    const OCCLUSION_OCCLUDED = 1 as const;
    const OCCLUSION_VISIBLE = 0 as const;
    const OCCLUSION_UNKNOWN = -1 as const;

    const HEADER_BYTES = 264;
    const OUTPUT_HEADER_BYTES = 16;
    const F32_CAM = 5;
    const F32_AABB_EXPAND = 8;
    const F32_DEPTH_BIAS = 9;
    const F32_SRC_PARAMS = 10;
    const F32_DST_PARAMS = 14;
    const F32_SRC_VP = 18;
    const F32_DST_VP = 34;
    const F32_VIEW = 50;
    const F32_SRC_DEPTH = 66;

    // A capture sample this close to its far is the sky (device Z 1).
    // The float32 linearize in the pack does not land exactly on far.
    const SKY = 0.98;

    const _inv = new Float64Array(16);
    const _reproject = new Float64Array(16);
    const _srcVP = new Float64Array(16);
    const _dstVP = new Float64Array(16);
    const _viewMat = new Float64Array(16);

    // Box corners in clip space (z is not needed), eye Z, and coverage pixels.
    // Index bit0 = +X, bit1 = +Y, bit2 = +Z.
    const _cx = new Float64Array(8);
    const _cy = new Float64Array(8);
    const _cw = new Float64Array(8);
    const _ce = new Float64Array(8);
    const _px = new Float64Array(8);
    const _py = new Float64Array(8);

    // Two triangles per face: +X, -X, +Y, -Y, +Z, -Z.
    const FACE_TRIS = new Uint8Array([
        3, 1, 7, 7, 1, 5,
        0, 2, 4, 4, 2, 6,
        2, 3, 6, 6, 3, 7,
        1, 0, 5, 5, 0, 4,
        4, 6, 5, 5, 6, 7,
        2, 0, 3, 3, 0, 1
    ]);
    const _faces = new Int32Array(3);

    // One triangle clipped to the near plane. Four verts is the maximum.
    const CLIP_MAX = 4;
    const _qx = new Float64Array(CLIP_MAX);
    const _qy = new Float64Array(CLIP_MAX);
    const _qw = new Float64Array(CLIP_MAX);
    const _qe = new Float64Array(CLIP_MAX);
    const _sx = new Float64Array(CLIP_MAX);
    const _sy = new Float64Array(CLIP_MAX);
    const _se = new Float64Array(CLIP_MAX);

    let _minEye = 0, _maxEye = 0;
    let _rangeMin = 1, _rangeMax = 1;
    let _frontCount = 0;
    let _faceOverlapped = 0;
    let _cornerMinEye = 0;
    let _boxMinX = 0, _boxMaxX = 0, _boxMinY = 0, _boxMaxY = 0;
    let _s0 = 0, _s1 = 0;

    const _emptyF32 = new Float32Array(0);
    const _emptyU32 = new Uint32Array(0);
    const _emptyI8 = new Int8Array(0);

    // A triangle whose bounds hold more texels than this asks the mips first.
    const MIP_TEST_TEXELS = 64;

    // Max-depth mips of the reprojected map. Level 0 is the map itself;
    // levels 1+ are packed into `_mips` at `_mipOff`.
    const MIP_LEVELS_MAX = 16;

    const _mipOff = new Int32Array(MIP_LEVELS_MAX);
    const _mipW = new Int32Array(MIP_LEVELS_MAX);
    const _mipH = new Int32Array(MIP_LEVELS_MAX);

    let _mipCount = 0;
    let _mips = _emptyF32;

    // Scatter target. 0 = no sample landed. Grown to the packed pixel count.
    let _scatter = _emptyF32;

    const _job = {
        reprojectMs: 0,
        mipMs: 0,
        aabbTestMs: 0,
        aabbCount: 0,
        occludedCount: 0
    };

    /**
     * CPU occlusion over a **view-space Z** buffer (metres) owned by the output slot.
     */
    class CoverageCpuBuffer {

        private _busU32: Uint32Array = _emptyU32;
        private _busF32: Float32Array = _emptyF32;
        private _reprojected: Float32Array = _emptyF32;
        private _flags: Int8Array = _emptyI8;
        private _bound = false;
        private _built = false;
        private _width = 0;
        private _height = 0;
        private _n0 = 0;
        private _queueCount = 0;
        private _centersOff = 0;
        private _halvesOff = 0;
        private _queueOff = 0;
        private _depthBias = 0;
        private _globalMin = 1;
        private _globalMax = 1;

        private _camX = 0;
        private _camY = 0;
        private _camZ = 0;
        private _dstNear = 0;
        private _dstFar = 0;
        private _aabbExpand = 0;
        private _rectPad = 0;

        public get width() { return this._width; }
        public get height() { return this._height; }
        public get depth() { return this._reprojected; }

        public get valid() {
            return (
                this._built &&
                this._bound &&
                this._n0 > 0 &&
                this._reprojected.length >= this._n0
            );
        }

        public get farClip() {
            const f32 = this._busF32;
            return f32.length > F32_DST_PARAMS + 1 ? f32[F32_DST_PARAMS + 1] : 1000;
        }

        public get job() { return _job; }

        /**
         * Bind the transferred bus + output slot. The views must be rebuilt
         * because a transferred ArrayBuffer is a new object each frame.
         */
        public bind(bus: ArrayBuffer, out: ArrayBuffer) {

            const busN = bus.byteLength | 0;
            const outN = out.byteLength | 0;
            this._bound = false;

            if (busN < HEADER_BYTES || (busN & 3) !== 0) {
                return;
            }

            const u32 = new Uint32Array(bus);
            const cap = u32[0] | 0;
            const width = u32[1] | 0;
            const height = u32[2] | 0;
            const n0 = width * height;
            const tail = HEADER_BYTES + n0 * 4 + cap * 36;
            const flagsOff = OUTPUT_HEADER_BYTES + n0 * 4;

            if (n0 <= 0 ||
                cap <= 0 ||
                busN < tail ||
                outN < flagsOff + cap) {
                return;
            }

            if (this._n0 !== n0) {
                this._built = false;
            }

            const queueCount = u32[3] | 0;

            this._busU32 = u32;
            this._busF32 = new Float32Array(bus);
            this._reprojected = new Float32Array(out, OUTPUT_HEADER_BYTES, n0);
            this._flags = new Int8Array(out, flagsOff, cap);
            this._width = width;
            this._height = height;
            this._n0 = n0;
            this._queueCount = queueCount < cap ? queueCount : cap;
            this._centersOff = F32_SRC_DEPTH + n0;
            this._halvesOff = this._centersOff + (cap << 2);
            this._queueOff = (HEADER_BYTES + n0 * 4 + cap * 32) >> 2;
            this._depthBias = this._busF32[F32_DEPTH_BIAS];
            this._bound = true;
        }

        public update() {

            if (!this._bound) {
                _job.reprojectMs = 0;
                _job.mipMs = 0;
                return;
            }

            const t0 = performance.now();
            this._reprojectDepth();
            const t1 = performance.now();
            buildMaxMips(this._reprojected, this._width, this._height);
            _job.reprojectMs = t1 - t0;
            _job.mipMs = performance.now() - t1;
            this._globalMin = _rangeMin;
            this._globalMax = _rangeMax;
            this._built = true;
        }

        public test() {

            if (!this._bound) {
                _job.aabbTestMs = 0;
                _job.aabbCount = 0;
                _job.occludedCount = 0;
                return;
            }

            const t0 = performance.now();
            const flags = this._flags;
            flags.fill(OCCLUSION_UNKNOWN);

            if (!this._built) {
                _job.aabbTestMs = performance.now() - t0;
                _job.aabbCount = 0;
                _job.occludedCount = 0;
                return;
            }

            const f32 = this._busF32;
            const u32 = this._busU32;
            this._camX = f32[F32_CAM];
            this._camY = f32[F32_CAM + 1];
            this._camZ = f32[F32_CAM + 2];
            this._dstNear = f32[F32_DST_PARAMS + 2];
            this._dstFar = f32[F32_DST_PARAMS + 1];
            this._aabbExpand = f32[F32_AABB_EXPAND];
            this._rectPad = u32[4] | 0;

            copy16(_dstVP, f32, F32_DST_VP);
            copy16(_viewMat, f32, F32_VIEW);

            const queueCount = this._queueCount;
            const queueOff = this._queueOff;
            const centersOff = this._centersOff;
            const halvesOff = this._halvesOff;
            let occluded = 0;

            for (let i = 0; i < queueCount; i++) {
                const id = u32[queueOff + i] | 0;
                const i0 = id << 2;
                const cp = centersOff + i0;
                const hp = halvesOff + i0;
                const flag = this._testAabb(
                    f32[cp], f32[cp + 1], f32[cp + 2],
                    f32[hp], f32[hp + 1], f32[hp + 2]
                );
                flags[id] = flag;
                if (flag === OCCLUSION_OCCLUDED) {
                    occluded++;
                }
            }

            _job.aabbTestMs = performance.now() - t0;
            _job.aabbCount = queueCount;
            _job.occludedCount = occluded;
        }

        private _reprojectDepth() {

            const f32 = this._busF32;
            const dest = this._reprojected;
            const n = this._n0;
            const dstFar = f32[F32_DST_PARAMS + 1];

            copy16(_srcVP, f32, F32_SRC_VP);
            copy16(_dstVP, f32, F32_DST_VP);

            if (!invert16(_inv, _srcVP)) {
                copyWithRange(dest, f32, F32_SRC_DEPTH, n);
                return;
            }

            // Ortho src/dst is not reprojected. The map stays at far.
            if (f32[F32_SRC_PARAMS + 3] !== 0 ||
                f32[F32_DST_PARAMS + 3] !== 0) {
                dest.fill(dstFar);
                _rangeMin = dstFar;
                _rangeMax = dstFar;
                return;
            }

            mul16(_reproject, _dstVP, _inv);

            if (_scatter.length < n) {
                _scatter = new Float32Array(n);
            }
            const s = _scatter;
            s.fill(0, 0, n);

            this._scatterPerspective(s);
            this._resolve(s, dest);
        }

        /**
         * Perspective reprojection. NDC depth is affine in `1/L`, so scaling every
         * component by `L` removes that divide; the denominator that falls out is
         * the destination view-space Z.
         * The nearest sample wins. The sky and samples past the destination far land
         * as far, so a hole next to them is not filled with a surface.
         */
        private _scatterPerspective(s: Float32Array) {

            const f32 = this._busF32;
            const w = this._width;
            const h = this._height;
            const lastX = w - 1;
            const lastY = h - 1;
            const srcFar = f32[F32_SRC_PARAMS + 1];
            const srcNear = f32[F32_SRC_PARAMS + 2];
            const dstNear = f32[F32_DST_PARAMS + 2];
            const dstFar = f32[F32_DST_PARAMS + 1];
            const skyL = srcFar * SKY;
            const srcBase = F32_SRC_DEPTH;

            const r = _reproject;
            const r0 = r[0], r1 = r[1], r3 = r[3];
            const r4 = r[4], r5 = r[5], r7 = r[7];
            const r8 = r[8], r9 = r[9], r11 = r[11];
            const r12 = r[12], r13 = r[13], r15 = r[15];
            const ndcStepX = 2 / w;
            const ndcStepY = 2 / h;
            const sxk = w * 0.5;
            const syk = h * 0.5;

            // ndcZ = A / L + B, in the -1..1 clip range the projection matrix was built for.
            const invDiffSrc = 1 / (srcNear - srcFar);
            const A = 2 * srcNear * srcFar * invDiffSrc;
            const B = -2 * srcFar * invDiffSrc - 1;
            const kW = r11 * A;
            const kX = r8 * A;
            const kY = r9 * A;

            for (let y = 0; y < h; y++) {

                const ndcY = (y + 0.5) * ndcStepY - 1;
                const srcRow = srcBase + y * w;
                const cwY = r7 * ndcY + r15 + r11 * B;
                const nxY = r4 * ndcY + r12 + r8 * B;
                const nyY = r5 * ndcY + r13 + r9 * B;
                let ndcX = 0.5 * ndcStepX - 1;

                for (let x = 0; x < w; x++, ndcX += ndcStepX) {

                    const sample = f32[srcRow + x];
                    if (!(sample > 0)) {
                        continue;
                    }

                    // The sky is reprojected along its ray but never occludes.
                    const sky = sample >= skyL;
                    const L = sky ? srcFar : sample;

                    const eyeZ = (r3 * ndcX + cwY) * L + kW;
                    if (!(eyeZ > dstNear)) {
                        continue;
                    }

                    const invEyeZ = 1 / eyeZ;
                    const nx = ((r0 * ndcX + nxY) * L + kX) * invEyeZ;
                    const ny = ((r1 * ndcX + nyY) * L + kY) * invEyeZ;
                    if (!(nx >= -1 && nx <= 1 && ny >= -1 && ny <= 1)) {
                        continue;
                    }

                    let px = (sxk * nx + sxk) | 0;
                    let py = (syk * ny + syk) | 0;
                    if (px > lastX) px = lastX;
                    if (py > lastY) py = lastY;

                    const di = py * w + px;
                    const z = sky || eyeZ >= dstFar ? dstFar : eyeZ;
                    const cur = s[di];
                    if (cur === 0 || z < cur) {
                        s[di] = z;
                    }
                }
            }
        }

        /**
         * A pixel with a sample keeps it. A hole takes the farthest sample of its
         * 3×3 neighbours, or far when none
         * landed there. Then the depth bias moves every occluder back, and the
         * map range is taken for the early-outs.
         */
        private _resolve(s: Float32Array, dest: Float32Array) {

            const w = this._width;
            const h = this._height;
            const lastX = w - 1;
            const lastY = h - 1;
            const far = this._busF32[F32_DST_PARAMS + 1];

            // b > 0: z * (1 + b) + b. b < 0: z + |b|.
            const bias = this._depthBias;
            const biasAdd = bias < 0 ? -bias : 0;
            const biasMul = bias > 0 ? 1 + bias : 1;
            const biasMulAdd = bias > 0 ? bias : 0;
            const applyBias = bias !== 0;

            let min = 1e30;
            let max = 0;

            for (let y = 0; y < h; y++) {

                const row = y * w;
                const y0 = y > 0 ? y - 1 : 0;
                const y1 = y < lastY ? y + 1 : lastY;

                for (let x = 0; x < w; x++) {

                    const i = row + x;
                    let d = s[i];

                    if (d === 0) {
                        const x0 = x > 0 ? x - 1 : 0;
                        const x1 = x < lastX ? x + 1 : lastX;
                        for (let yy = y0; yy <= y1; yy++) {
                            const r = yy * w;
                            for (let xx = x0; xx <= x1; xx++) {
                                const z = s[r + xx];
                                if (z > d) d = z;
                            }
                        }
                        if (d === 0) {
                            d = far;
                        }
                    }

                    if (applyBias && d < far) {
                        d = (d + biasAdd) * biasMul + biasMulAdd;
                        if (d > far) d = far;
                    }

                    dest[i] = d;
                    if (d < min) min = d;
                    if (d > max) max = d;
                }
            }

            _rangeMin = min;
            _rangeMax = max;
        }

        private _testAabb(
            cx: number, cy: number, cz: number,
            hx: number, hy: number, hz: number
        ): TOcclusionResult {

            const dx = absf(this._camX - cx) - hx;
            const dy = absf(this._camY - cy) - hy;
            const dz = absf(this._camZ - cz) - hz;
            const ex = dx > 0 ? dx : 0;
            const ey = dy > 0 ? dy : 0;
            const ez = dz > 0 ? dz : 0;

            let expand = 0;
            const aabbExpand = this._aabbExpand;
            if (aabbExpand > 0) {
                expand = aabbExpand * Math.sqrt(ex * ex + ey * ey + ez * ez);
                hx += expand;
                hy += expand;
                hz += expand;
            }

            if (dx <= expand &&
                dy <= expand &&
                dz <= expand) {
                return OCCLUSION_VISIBLE;
            }

            const near = this._dstNear;
            const far = this._dstFar;

            aabbEyeRange(_viewMat, cx, cy, cz, hx, hy, hz);

            let minEye = _minEye;
            const maxEye = _maxEye;
            if (minEye < near) {
                minEye = near;
            }
            if (minEye >= far) {
                return OCCLUSION_VISIBLE;
            }

            if (minEye > this._globalMax) {
                return OCCLUSION_OCCLUDED;
            }

            if (maxEye < this._globalMin) {
                return OCCLUSION_VISIBLE;
            }

            loadCorners(_dstVP, _viewMat, cx, cy, cz, hx, hy, hz, near);
            if (_frontCount === 0) {
                return OCCLUSION_VISIBLE;
            }

            // With every corner past near the corners are
            // projected once, otherwise each triangle is clipped to near.
            const clip = _frontCount < 8;
            if (!clip) {
                projectCorners(this._width, this._height);
            }

            let nf = 0;
            if (this._camX > cx + hx) {
                _faces[nf++] = 0;
            }
            else if (this._camX < cx - hx) {
                _faces[nf++] = 1;
            }
            if (this._camY > cy + hy) {
                _faces[nf++] = 2;
            }
            else if (this._camY < cy - hy) {
                _faces[nf++] = 3;
            }
            if (this._camZ > cz + hz) {
                _faces[nf++] = 4;
            }
            else if (this._camZ < cz - hz) {
                _faces[nf++] = 5;
            }

            // Whole projected rect nearer than the nearest corner: every texel
            // a front face can cover is occluding. One covering texel is enough.
            let coverOnly = 0;
            if (!clip) {
                const pad = this._rectPad | 0;
                const lastX = this._width - 1;
                const lastY = this._height - 1;
                let xLo = Math.floor(_boxMinX) - pad;
                let yLo = Math.floor(_boxMinY) - pad;
                let xHi = Math.ceil(_boxMaxX) - 1 + pad;
                let yHi = Math.ceil(_boxMaxY) - 1 + pad;
                if (xLo < 0) xLo = 0;
                if (yLo < 0) yLo = 0;
                if (xHi > lastX) xHi = lastX;
                if (yHi > lastY) yHi = lastY;
                if (xLo > xHi || yLo > yHi) {
                    return OCCLUSION_VISIBLE;
                }
                if (mipRectOccluded(
                    xLo, yLo, xHi, yHi, _cornerMinEye,
                    this._reprojected, this._width, this._height
                )) {
                    coverOnly = 1;
                }
            }

            _faceOverlapped = 0;

            for (let f = 0; f < nf; f++) {
                const o = _faces[f] * 6;
                if (this._triangleSees(FACE_TRIS[o], FACE_TRIS[o + 1], FACE_TRIS[o + 2], clip, coverOnly)) {
                    return OCCLUSION_VISIBLE;
                }
                if (coverOnly && _faceOverlapped) {
                    return OCCLUSION_OCCLUDED;
                }
                if (this._triangleSees(FACE_TRIS[o + 3], FACE_TRIS[o + 4], FACE_TRIS[o + 5], clip, coverOnly)) {
                    return OCCLUSION_VISIBLE;
                }
                if (coverOnly && _faceOverlapped) {
                    return OCCLUSION_OCCLUDED;
                }
            }

            return _faceOverlapped ? OCCLUSION_OCCLUDED : OCCLUSION_VISIBLE;
        }

        /**
         * @returns true when this triangle has a texel the box can be seen through.
         * A triangle that misses the map does not prove occlusion.
         */
        private _triangleSees(
            i0: number, i1: number, i2: number,
            clip: boolean, coverOnly: number
        ) {

            if (!clip) {
                return this._rasterSees(
                    _px[i0], _py[i0], _ce[i0],
                    _px[i1], _py[i1], _ce[i1],
                    _px[i2], _py[i2], _ce[i2],
                    coverOnly
                );
            }

            const n = clipNear(i0, i1, i2, this._dstNear, this._width, this._height);
            if (n < 3) {
                return false;
            }

            const x0 = _sx[0], y0 = _sy[0], z0 = _se[0];
            for (let i = 1; i < n - 1; i++) {
                if (this._rasterSees(
                    x0, y0, z0,
                    _sx[i], _sy[i], _se[i],
                    _sx[i + 1], _sy[i + 1], _se[i + 1],
                    coverOnly
                )) {
                    return true;
                }
            }
            return false;
        }

        private _rasterSees(
            x0: number, y0: number, z0: number,
            x1: number, y1: number, z1: number,
            x2: number, y2: number, z2: number,
            coverOnly: number
        ) {
            const hit = rasterTri(
                x0, y0, z0,
                x1, y1, z1,
                x2, y2, z2,
                this._reprojected,
                this._width, this._height,
                this._rectPad, this._dstFar,
                coverOnly
            );
            if (hit > 0) {
                return true;
            }
            if (hit === 0) {
                _faceOverlapped = 1;
            }
            return false;
        }
    }

    function copy16(dst: Float64Array, src: Float32Array, srcOff: number) {
        for (let i = 0; i < 16; i++) {
            dst[i] = src[srcOff + i];
        }
    }

    function copyWithRange(dst: Float32Array, src: Float32Array, srcOff: number, n: number) {

        let min = 1e30;
        let max = 0;

        for (let i = 0; i < n; i++) {
            const d = src[srcOff + i];
            dst[i] = d;
            if (d < min) min = d;
            if (d > max) max = d;
        }

        _rangeMin = min;
        _rangeMax = max;
    }

    function aabbEyeRange(
        view: Float64Array,
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

    function mul16(out: Float64Array, a: Float64Array, b: Float64Array) {

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

    function invert16(out: Float64Array, m: Float64Array) {

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

    function loadCorners(
        vp: Float64Array, view: Float64Array,
        cx: number, cy: number, cz: number,
        hx: number, hy: number, hz: number,
        near: number
    ) {
        const m0 = vp[0], m1 = vp[1], m3 = vp[3];
        const m4 = vp[4], m5 = vp[5], m7 = vp[7];
        const m8 = vp[8], m9 = vp[9], m11 = vp[11];
        const m12 = vp[12], m13 = vp[13], m15 = vp[15];
        const v2 = view[2], v6 = view[6], v10 = view[10], v14 = view[14];

        let front = 0;
        let minE = 1e30;
        for (let i = 0; i < 8; i++) {
            const wx = cx + ((i & 1) ? hx : -hx);
            const wy = cy + ((i & 2) ? hy : -hy);
            const wz = cz + ((i & 4) ? hz : -hz);
            const w = m3 * wx + m7 * wy + m11 * wz + m15;
            const eye = -(v2 * wx + v6 * wy + v10 * wz + v14);
            _cx[i] = m0 * wx + m4 * wy + m8 * wz + m12;
            _cy[i] = m1 * wx + m5 * wy + m9 * wz + m13;
            _cw[i] = w;
            _ce[i] = eye;
            if (eye < minE) {
                minE = eye;
            }
            if (eye > near && w > 0) {
                front++;
            }
        }
        _frontCount = front;
        _cornerMinEye = minE;
    }

    /** All eight corners in front of near, to coverage pixels. */
    function projectCorners(width: number, height: number) {
        const halfX = width * 0.5;
        const halfY = height * 0.5;
        let minX = 1e30, maxX = -1e30, minY = 1e30, maxY = -1e30;
        for (let i = 0; i < 8; i++) {
            const inv = 1 / _cw[i];
            const px = (_cx[i] * inv + 1) * halfX;
            const py = (_cy[i] * inv + 1) * halfY;
            _px[i] = px;
            _py[i] = py;
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
        }
        _boxMinX = minX;
        _boxMaxX = maxX;
        _boxMinY = minY;
        _boxMaxY = maxY;
    }

    function pushClip(n: number, x: number, y: number, w: number, eye: number) {
        if (n >= CLIP_MAX) {
            return n;
        }
        _qx[n] = x;
        _qy[n] = y;
        _qw[n] = w;
        _qe[n] = eye;
        return n + 1;
    }

    function pushCorner(n: number, i: number) {
        return pushClip(n, _cx[i], _cy[i], _cw[i], _ce[i]);
    }

    /** Point on edge a-b where eye Z is `near`. Clip coords are affine along it. */
    function pushLerp(n: number, ia: number, ib: number, near: number) {
        const ea = _ce[ia];
        const t = (near - ea) / (_ce[ib] - ea);
        return pushClip(
            n,
            _cx[ia] + (_cx[ib] - _cx[ia]) * t,
            _cy[ia] + (_cy[ib] - _cy[ia]) * t,
            _cw[ia] + (_cw[ib] - _cw[ia]) * t,
            near
        );
    }

    function clipEdge(n: number, ia: number, ib: number, near: number) {
        const inA = _ce[ia] >= near;
        const inB = _ce[ib] >= near;
        if (inA) {
            if (inB) {
                return pushCorner(n, ib);
            }
            return pushLerp(n, ia, ib, near);
        }
        if (inB) {
            n = pushLerp(n, ia, ib, near);
            return pushCorner(n, ib);
        }
        return n;
    }

    /** Clip one triangle to the near plane and project it to coverage pixels. */
    function clipNear(i0: number, i1: number, i2: number, near: number, width: number, height: number) {
        let n = 0;
        n = clipEdge(n, i0, i1, near);
        n = clipEdge(n, i1, i2, near);
        n = clipEdge(n, i2, i0, near);

        let m = 0;
        const halfX = width * 0.5;
        const halfY = height * 0.5;
        for (let i = 0; i < n; i++) {
            const w = _qw[i];
            if (!(w > 0)) {
                continue;
            }
            const inv = 1 / w;
            const sx = (_qx[i] * inv + 1) * halfX;
            const sy = (_qy[i] * inv + 1) * halfY;
            if (sx !== sx || sy !== sy) {
                continue;
            }
            _sx[m] = sx;
            _sy[m] = sy;
            _se[m] = _qe[i];
            m++;
        }
        return m;
    }

    /**
     * Max-depth pyramid of `src`. Level 0 is `src` itself. Each texel at
     * level L is the max of a 2×2 (clamped at the edge) on level L-1, so a
     * coarse sample never underestimates the finest max over its footprint.
     */
    function buildMaxMips(src: Float32Array, w: number, h: number) {

        _mipW[0] = w;
        _mipH[0] = h;
        _mipCount = 1;

        let pw = w;
        let ph = h;
        let need = 0;
        while ((pw > 1 || ph > 1) && _mipCount < MIP_LEVELS_MAX) {
            const nw = (pw + 1) >> 1;
            const nh = (ph + 1) >> 1;
            _mipOff[_mipCount] = need;
            _mipW[_mipCount] = nw;
            _mipH[_mipCount] = nh;
            need += nw * nh;
            _mipCount++;
            pw = nw;
            ph = nh;
        }

        if (_mips.length < need) {
            _mips = new Float32Array(need);
        }

        let prev: Float32Array = src;
        let prevW = w;
        let prevH = h;
        let prevOff = 0;

        for (let L = 1; L < _mipCount; L++) {

            const nw = _mipW[L];
            const nh = _mipH[L];
            const off = _mipOff[L];
            const lastX = prevW - 1;
            const lastY = prevH - 1;

            for (let y = 0; y < nh; y++) {

                const sy0 = y << 1;
                const sy1 = sy0 < lastY ? sy0 + 1 : lastY;
                const row0 = prevOff + sy0 * prevW;
                const row1 = prevOff + sy1 * prevW;
                const destRow = off + y * nw;

                for (let x = 0; x < nw; x++) {

                    const sx0 = x << 1;
                    const sx1 = sx0 < lastX ? sx0 + 1 : lastX;
                    let m = prev[row0 + sx0];
                    const a = prev[row0 + sx1];
                    const b = prev[row1 + sx0];
                    const c = prev[row1 + sx1];
                    if (a > m) m = a;
                    if (b > m) m = b;
                    if (c > m) m = c;
                    _mips[destRow + x] = m;
                }
            }

            prev = _mips;
            prevW = nw;
            prevH = nh;
            prevOff = off;
        }
    }

    /**
     * True when every finest texel in the inclusive rect is at most `z`.
     * The mip max is an over-estimate, so a `true` is exact and a `false`
     * only means "not proven".
     */
    function mipRectOccluded(
        x0: number, y0: number, x1: number, y1: number,
        z: number, src: Float32Array, bw: number, bh: number
    ) {

        let L = 0;
        while (L + 1 < _mipCount) {
            const s = L + 1;
            if ((x1 >> s) - (x0 >> s) > 3 || (y1 >> s) - (y0 >> s) > 3) {
                L = s;
                continue;
            }
            break;
        }

        const data = L === 0 ? src : _mips;
        const off = L === 0 ? 0 : _mipOff[L];
        const mw = L === 0 ? bw : _mipW[L];
        let mx0 = x0 >> L;
        let my0 = y0 >> L;
        let mx1 = x1 >> L;
        let my1 = y1 >> L;
        const lastX = (L === 0 ? bw : _mipW[L]) - 1;
        const lastY = (L === 0 ? bh : _mipH[L]) - 1;
        if (mx0 < 0) mx0 = 0;
        if (my0 < 0) my0 = 0;
        if (mx1 > lastX) mx1 = lastX;
        if (my1 > lastY) my1 = lastY;
        if (mx0 > mx1 || my0 > my1) {
            return false;
        }

        for (let y = my0; y <= my1; y++) {
            const row = off + y * mw;
            for (let x = mx0; x <= mx1; x++) {
                if (data[row + x] > z) {
                    return false;
                }
            }
        }
        return true;
    }

    /** Inclusive [s0, s1] where a*(x+0.5)+t >= 0 for all three edges. */
    function clipSpan(
        s0: number, s1: number,
        a0: number, t0: number,
        a1: number, t1: number,
        a2: number, t2: number
    ) {

        const origLo = s0;
        const origHi = s1;

        if (a0 > 1e-12) {
            const x = Math.ceil((-t0 / a0) - 0.5);
            if (x > s0) s0 = x;
        }
        else if (a0 < -1e-12) {
            const x = Math.floor((-t0 / a0) - 0.5);
            if (x < s1) s1 = x;
        }
        else if (t0 < 0) {
            _s0 = 1;
            _s1 = 0;
            return;
        }

        if (a1 > 1e-12) {
            const x = Math.ceil((-t1 / a1) - 0.5);
            if (x > s0) s0 = x;
        }
        else if (a1 < -1e-12) {
            const x = Math.floor((-t1 / a1) - 0.5);
            if (x < s1) s1 = x;
        }
        else if (t1 < 0) {
            _s0 = 1;
            _s1 = 0;
            return;
        }

        if (a2 > 1e-12) {
            const x = Math.ceil((-t2 / a2) - 0.5);
            if (x > s0) s0 = x;
        }
        else if (a2 < -1e-12) {
            const x = Math.floor((-t2 / a2) - 0.5);
            if (x < s1) s1 = x;
        }
        else if (t2 < 0) {
            _s0 = 1;
            _s1 = 0;
            return;
        }

        if (s0 > s1) {
            _s0 = s0;
            _s1 = s1;
            return;
        }

        const inside = (x: number) => {
            const px = x + 0.5;
            return a0 * px + t0 >= 0 && a1 * px + t1 >= 0 && a2 * px + t2 >= 0;
        };

        if (!inside(s0)) {
            do {
                s0++;
            } while (s0 <= s1 && !inside(s0));
        }
        else {
            while (s0 > origLo && inside(s0 - 1)) {
                s0--;
            }
        }
        if (s0 > s1) {
            _s0 = s0;
            _s1 = s1;
            return;
        }
        if (!inside(s1)) {
            do {
                s1--;
            } while (s1 >= s0 && !inside(s1));
        }
        else {
            while (s1 < origHi && inside(s1 + 1)) {
                s1++;
            }
        }

        _s0 = s0;
        _s1 = s1;
    }

    /**
     * 1 = a covered texel is farther than the triangle's nearest eye Z.
     * 0 = every covered texel is nearer (this triangle is occluded).
     * -1 = the triangle misses the map.
     * A texel centre within half a texel of an edge is covered, so a triangle
     * that only clips a texel still tests it. Texels in the `pad` ring around
     * the bounds are tested whether or not the triangle covers them.
     *
     * `coverOnly` skips the depth load: the caller already knows every texel
     * in the scan rect is occluding, so the first covered texel is enough.
     */
    function rasterTri(
        x0: number, y0: number, z0: number,
        x1: number, y1: number, z1: number,
        x2: number, y2: number, z2: number,
        data: Float32Array,
        bw: number, bh: number,
        pad: number, far: number,
        coverOnly: number
    ) {
        const dx01 = x1 - x0;
        const dy01 = y1 - y0;
        const dx12 = x2 - x1;
        const dy12 = y2 - y1;
        const dx20 = x0 - x2;
        const dy20 = y0 - y2;

        const area = dx01 * (y2 - y0) - dy01 * (x2 - x0);
        if (!(area > 1e-4 || area < -1e-4)) {
            return -1;
        }

        let minX = x0;
        let maxX = x0;
        let minY = y0;
        let maxY = y0;
        if (x1 < minX) minX = x1;
        if (x2 < minX) minX = x2;
        if (x1 > maxX) maxX = x1;
        if (x2 > maxX) maxX = x2;
        if (y1 < minY) minY = y1;
        if (y2 < minY) minY = y2;
        if (y1 > maxY) maxY = y1;
        if (y2 > maxY) maxY = y2;

        const rawX0 = Math.floor(minX);
        const rawY0 = Math.floor(minY);
        const rawX1 = Math.ceil(maxX) - 1;
        const rawY1 = Math.ceil(maxY) - 1;
        const lastX = bw - 1;
        const lastY = bh - 1;
        let xLo = rawX0 - pad;
        let yLo = rawY0 - pad;
        let xHi = rawX1 + pad;
        let yHi = rawY1 + pad;
        if (xLo < 0) xLo = 0;
        if (yLo < 0) yLo = 0;
        if (xHi > lastX) xHi = lastX;
        if (yHi > lastY) yHi = lastY;
        if (xLo > xHi || yLo > yHi) {
            return -1;
        }

        let minZ = z0;
        if (z1 < minZ) minZ = z1;
        if (z2 < minZ) minZ = z2;
        // Past the far clear this triangle cannot be occluded, and it is not
        // a reason to draw: the box early-out already kept a fully-past-far box.
        if (!(minZ < far)) {
            return -1;
        }

        if (!coverOnly) {
            const texels = (xHi - xLo + 1) * (yHi - yLo + 1);
            if (texels > MIP_TEST_TEXELS &&
                mipRectOccluded(xLo, yLo, xHi, yHi, minZ, data, bw, bh)) {
                coverOnly = 1;
            }
        }

        if (coverOnly && pad > 0 &&
            (xLo < rawX0 || xHi > rawX1 || yLo < rawY0 || yHi > rawY1)) {
            return 0;
        }

        // Edge functions with the winding folded in: a centre is inside an
        // edge when a * px + b * py + c >= 0.
        const s = area > 0 ? 1 : -1;
        const a0 = -dy01 * s, b0 = dx01 * s;
        const a1 = -dy12 * s, b1 = dx12 * s;
        const a2 = -dy20 * s, b2 = dx20 * s;
        const c0 = (dy01 * x0 - dx01 * y0) * s + 0.5 * Math.sqrt(dx01 * dx01 + dy01 * dy01);
        const c1 = (dy12 * x1 - dx12 * y1) * s + 0.5 * Math.sqrt(dx12 * dx12 + dy12 * dy12);
        const c2 = (dy20 * x2 - dx20 * y2) * s + 0.5 * Math.sqrt(dx20 * dx20 + dy20 * dy20);

        const innerLo = rawX0 > xLo ? rawX0 : xLo;
        const innerHi = rawX1 < xHi ? rawX1 : xHi;

        if (coverOnly) {

            for (let y = yLo; y <= yHi; y++) {
                const py = y + 0.5;
                clipSpan(
                    innerLo, innerHi,
                    a0, b0 * py + c0,
                    a1, b1 * py + c1,
                    a2, b2 * py + c2
                );
                if (_s0 <= _s1) {
                    return 0;
                }
            }
            return -1;
        }

        let covered = false;

        for (let y = yLo; y <= yHi; y++) {

            const py = y + 0.5;
            const row = y * bw;
            const rawRow = y >= rawY0 && y <= rawY1;

            if (pad > 0) {
                if (!rawRow) {
                    for (let x = xLo; x <= xHi; x++) {
                        covered = true;
                        if (data[row + x] > minZ) {
                            return 1;
                        }
                    }
                    continue;
                }
                for (let x = xLo; x < rawX0; x++) {
                    covered = true;
                    if (data[row + x] > minZ) {
                        return 1;
                    }
                }
                for (let x = rawX1 + 1; x <= xHi; x++) {
                    covered = true;
                    if (data[row + x] > minZ) {
                        return 1;
                    }
                }
            }

            clipSpan(
                innerLo, innerHi,
                a0, b0 * py + c0,
                a1, b1 * py + c1,
                a2, b2 * py + c2
            );
            if (_s0 > _s1) {
                continue;
            }
            covered = true;
            for (let x = _s0; x <= _s1; x++) {
                if (data[row + x] > minZ) {
                    return 1;
                }
            }
        }

        return covered ? 0 : -1;
    }

    return CoverageCpuBuffer;
}
