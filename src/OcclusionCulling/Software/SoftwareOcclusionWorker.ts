/**
 * Self-contained worker entry. Stringified into a Blob so the library
 * does not need a separate worker asset. Do not close over module scope.
 *
 * Hi-Z lives only in this worker: it is allocated, cleared, filled and
 * sampled here, and is never copied back to the main thread.
 */
export function softwareOcclusionWorkerMain() {

    const ctx = self as unknown as {
        onmessage: ((event: MessageEvent) => void) | null;
        postMessage: (message: unknown, transfer?: Transferable[]) => void;
    };

    const STATUS_WORK = 1;
    const STATUS_DONE = 2;
    const STATUS_EXIT = 3;

    const I32_STATUS = 0;
    const I32_WRITE_SLOT = 1;
    const I32_QUEUE_COUNT = 3;
    const I32_TIME_CLEAR_US = 4;
    const I32_TIME_RASTER_US = 5;
    const I32_TIME_HIZ_US = 6;
    const I32_TIME_AABB_US = 7;
    const I32_TIME_TOTAL_US = 8;
    const I32_STAT_OCCLUDERS = 9;
    const I32_STAT_AABB = 10;
    const I32_STAT_OCCLUDED = 11;
    const I32_STAT_VISIBLE = 12;

    const OCCLUDER_MESH = 6;
    const FLAG_OCCLUDED = 1;
    const FLAG_VISIBLE = 2;
    const OCCLUDER_STRIDE = 16;
    const MESH_RANGE_STRIDE = 4;
    const AABB_STRIDE = 4;
    const NEAR_EPS = 1e-5;

    const primitiveMeshes = [
        null,
        buildBoxMesh(),
        buildPlaneMesh(),
        buildCylinderMesh(8),
        buildConeMesh(8),
        buildIcosahedronMesh()
    ];

    const mvp = new Float32Array(16);
    const clipA = new Float32Array(4);
    const clipB = new Float32Array(4);
    const clipC = new Float32Array(4);
    const polyIn = new Float32Array(16);
    const polyOut = new Float32Array(20);
    const clipTmp = new Float32Array(4);
    let clipCache = new Float32Array(0);

    const hiz = {
        width: 0,
        height: 0,
        min: null as Float32Array | null,
        max: null as Float32Array | null,
        mipOffset: null as Int32Array | null,
        mipWidth: null as Int32Array | null,
        mipHeight: null as Int32Array | null,
        levels: 0,
        dirty: false
    };

    const scene = {
        control: null as Int32Array | null,
        vp: null as Float32Array | null,
        occluderTypes: new Uint32Array(0) as Uint32Array<ArrayBufferLike>,
        occluderMatrices: new Float32Array(0) as Float32Array<ArrayBufferLike>,
        occluderMeshRanges: new Uint32Array(0) as Uint32Array<ArrayBufferLike>,
        meshVertices: new Float32Array(0) as Float32Array<ArrayBufferLike>,
        meshIndices: new Uint32Array(0) as Uint32Array<ArrayBufferLike>,
        queueIds: new Uint32Array(0) as Uint32Array<ArrayBufferLike>,
        aabbCenters: new Float32Array(0) as Float32Array<ArrayBufferLike>,
        aabbHalfExtents: new Float32Array(0) as Float32Array<ArrayBufferLike>,
        flags0: null as Uint32Array<ArrayBufferLike> | null,
        flags1: null as Uint32Array<ArrayBufferLike> | null
    };

    ctx.onmessage = function (event: MessageEvent) {
        const msg = event.data;
        if (!msg || typeof msg !== "object") {
            return;
        }
        switch (msg.t) {
            case "init-sab":
                allocHiZ(msg.width, msg.height);
                mapShared(msg.sab, msg.offsets, msg);
                ctx.postMessage({ t: "ready" });
                atomicsLoop();
                return;
            case "init-copy":
                allocHiZ(msg.width, msg.height);
                ctx.postMessage({ t: "ready" });
                return;
            case "occluders":
                scene.occluderTypes = msg.types;
                scene.occluderMatrices = msg.matrices;
                if (msg.meshRanges) {
                    scene.occluderMeshRanges = msg.meshRanges;
                }
                return;
            case "occluder-meshes":
                scene.meshVertices = msg.vertices;
                if (msg.indices) {
                    scene.meshIndices = msg.indices;
                }
                return;
            case "aabbs":
                scene.aabbCenters = msg.centers;
                scene.aabbHalfExtents = msg.halfExtents;
                return;
            case "job":
                runCopyJob(msg);
                return;
        }
    };

    function mapShared(
        sab: SharedArrayBuffer,
        offsets: {
            control: number;
            vp: number;
            occluderTypes: number;
            occluderMatrices: number;
            occluderMeshRanges: number;
            meshVertices: number;
            meshIndices: number;
            queueIds: number;
            aabbCenters: number;
            aabbHalfExtents: number;
            flags0: number;
            flags1: number;
        },
        sizes: {
            aabbCapacity: number;
            occluderTypesLength: number;
            occluderMatricesLength: number;
            occluderMeshRangesLength: number;
            meshVerticesLength: number;
            meshIndicesLength: number;
        }
    ) {
        const aabb = sizes.aabbCapacity;
        scene.control = new Int32Array(sab, offsets.control, 16);
        scene.vp = new Float32Array(sab, offsets.vp, 16);
        scene.occluderTypes = new Uint32Array(sab, offsets.occluderTypes, sizes.occluderTypesLength);
        scene.occluderMatrices = new Float32Array(sab, offsets.occluderMatrices, sizes.occluderMatricesLength);
        scene.occluderMeshRanges = new Uint32Array(sab, offsets.occluderMeshRanges, sizes.occluderMeshRangesLength);
        scene.meshVertices = new Float32Array(sab, offsets.meshVertices, sizes.meshVerticesLength);
        scene.meshIndices = new Uint32Array(sab, offsets.meshIndices, sizes.meshIndicesLength);
        scene.queueIds = new Uint32Array(sab, offsets.queueIds, aabb);
        scene.aabbCenters = new Float32Array(sab, offsets.aabbCenters, aabb * AABB_STRIDE);
        scene.aabbHalfExtents = new Float32Array(sab, offsets.aabbHalfExtents, aabb * AABB_STRIDE);
        scene.flags0 = new Uint32Array(sab, offsets.flags0, aabb);
        scene.flags1 = new Uint32Array(sab, offsets.flags1, aabb);
    }

    function atomicsLoop() {
        const status = scene.control!;
        for (;;) {
            const value = Atomics.load(status, I32_STATUS);
            if (value === STATUS_EXIT) {
                return;
            }
            if (value !== STATUS_WORK) {
                Atomics.wait(status, I32_STATUS, value);
                continue;
            }

            const writeSlot = Atomics.load(status, I32_WRITE_SLOT);
            const flags = writeSlot === 0 ? scene.flags0! : scene.flags1!;
            flags.fill(0);

            const stats = runJob(
                scene.vp!,
                scene.queueIds,
                Atomics.load(status, I32_QUEUE_COUNT),
                flags
            );

            Atomics.store(status, I32_TIME_CLEAR_US, stats.clearUs);
            Atomics.store(status, I32_TIME_RASTER_US, stats.rasterUs);
            Atomics.store(status, I32_TIME_HIZ_US, stats.hizUs);
            Atomics.store(status, I32_TIME_AABB_US, stats.aabbUs);
            Atomics.store(status, I32_TIME_TOTAL_US, stats.totalUs);
            Atomics.store(status, I32_STAT_OCCLUDERS, stats.occluders);
            Atomics.store(status, I32_STAT_AABB, stats.aabbs);
            Atomics.store(status, I32_STAT_OCCLUDED, stats.occluded);
            Atomics.store(status, I32_STAT_VISIBLE, stats.visible);
            Atomics.store(status, I32_STATUS, STATUS_DONE);
            Atomics.notify(status, I32_STATUS);
        }
    }

    function runCopyJob(msg: {
        slot: number;
        vp: Float32Array;
        queueIds: Uint32Array;
        flags: Uint32Array;
        queueCount: number;
    }) {
        const flags = msg.flags;
        const queueIds = msg.queueIds;
        const vp = msg.vp;
        if (!flags || !queueIds || !vp) {
            return;
        }

        flags.fill(0);
        const stats = runJob(vp, queueIds, msg.queueCount, flags);
        ctx.postMessage({
            t: "result",
            slot: msg.slot,
            flags,
            queueIds,
            vp,
            ...stats
        }, [flags.buffer, queueIds.buffer, vp.buffer]);
    }

    function runJob(
        vp: Float32Array,
        ids: Uint32Array,
        queueCount: number,
        flags: Uint32Array
    ) {
        const t0 = performance.now();
        clearDepth();
        const tClear = performance.now();

        const occluders = rasterizeOccluders(vp);
        const tRaster = performance.now();

        if (occluders === 0 || !hiz.dirty) {
            const counts = markVisible(ids, queueCount, flags);
            const tDone = performance.now();
            return {
                clearUs: toUs(tClear - t0),
                rasterUs: toUs(tRaster - tClear),
                hizUs: 0,
                aabbUs: toUs(tDone - tRaster),
                totalUs: toUs(tDone - t0),
                occluders,
                aabbs: counts.tested,
                occluded: 0,
                visible: counts.visible
            };
        }

        buildHiZ();
        const tHiz = performance.now();

        const counts = testAabbs(vp, ids, queueCount, flags);
        const tAabb = performance.now();

        return {
            clearUs: toUs(tClear - t0),
            rasterUs: toUs(tRaster - tClear),
            hizUs: toUs(tHiz - tRaster),
            aabbUs: toUs(tAabb - tHiz),
            totalUs: toUs(tAabb - t0),
            occluders,
            aabbs: counts.tested,
            occluded: counts.occluded,
            visible: counts.visible
        };
    }

    function rasterizeOccluders(vp: Float32Array) {
        const types = scene.occluderTypes;
        const matrices = scene.occluderMatrices;
        const ranges = scene.occluderMeshRanges;
        let occluders = 0;

        for (let i = 0; i < types.length; i++) {
            const type = types[i];
            if (type === 0) {
                continue;
            }
            occluders++;
            mulMat4(mvp, vp, matrices, i * OCCLUDER_STRIDE);
            if (type === OCCLUDER_MESH) {
                const range = i * MESH_RANGE_STRIDE;
                rasterizeIndexed(
                    ranges[range],
                    ranges[range + 1],
                    ranges[range + 2],
                    ranges[range + 3],
                    mvp
                );
                continue;
            }
            const mesh = primitiveMeshes[type];
            if (mesh) {
                rasterizeTriangles(mesh, 0, mesh.length, mvp);
            }
        }

        return occluders;
    }

    function testAabbs(
        vp: Float32Array,
        ids: Uint32Array,
        queueCount: number,
        flags: Uint32Array
    ) {
        const centers = scene.aabbCenters;
        const halfExtents = scene.aabbHalfExtents;
        const tests = queueCount | 0;
        let occluded = 0;
        let visible = 0;

        for (let i = 0; i < tests; i++) {
            const id = ids[i];
            const base = id * AABB_STRIDE;
            const flag = testAabb(
                centers[base], centers[base + 1], centers[base + 2],
                halfExtents[base], halfExtents[base + 1], halfExtents[base + 2],
                vp
            );
            flags[id] = flag;
            if (flag === FLAG_OCCLUDED) {
                occluded++;
            }
            else {
                visible++;
            }
        }

        return { tested: tests, occluded, visible };
    }

    function markVisible(ids: Uint32Array, queueCount: number, flags: Uint32Array) {
        const tests = queueCount | 0;
        for (let i = 0; i < tests; i++) {
            flags[ids[i]] = FLAG_VISIBLE;
        }
        return { tested: tests, visible: tests };
    }

    function allocHiZ(width: number, height: number) {
        const widths: number[] = [];
        const heights: number[] = [];
        const offsets: number[] = [];
        let w = width;
        let h = height;
        let total = 0;

        for (;;) {
            offsets.push(total);
            widths.push(w);
            heights.push(h);
            total += w * h;
            if (w === 1 && h === 1) {
                break;
            }
            w = Math.max(1, w >> 1);
            h = Math.max(1, h >> 1);
        }

        hiz.width = width;
        hiz.height = height;
        hiz.min = new Float32Array(total);
        hiz.max = new Float32Array(total);
        hiz.mipOffset = new Int32Array(offsets);
        hiz.mipWidth = new Int32Array(widths);
        hiz.mipHeight = new Int32Array(heights);
        hiz.levels = widths.length;
    }

    function clearDepth() {
        hiz.max!.fill(1, 0, hiz.mipWidth![0] * hiz.mipHeight![0]);
        hiz.dirty = false;
    }

    function buildHiZ() {
        const mn = hiz.min!;
        const mx = hiz.max!;
        const offsets = hiz.mipOffset!;
        const widths = hiz.mipWidth!;
        const heights = hiz.mipHeight!;
        const n0 = widths[0] * heights[0];
        mn.set(mx.subarray(0, n0));

        for (let level = 1; level < hiz.levels; level++) {
            const srcOff = offsets[level - 1];
            const dstOff = offsets[level];
            const srcW = widths[level - 1];
            const srcH = heights[level - 1];
            const dstW = widths[level];
            const dstH = heights[level];

            for (let y = 0; y < dstH; y++) {
                const y0 = y * 2;
                const y1 = Math.min(y0 + 1, srcH - 1);
                for (let x = 0; x < dstW; x++) {
                    const x0 = x * 2;
                    const x1 = Math.min(x0 + 1, srcW - 1);
                    const i0 = srcOff + y0 * srcW + x0;
                    const i1 = srcOff + y0 * srcW + x1;
                    const i2 = srcOff + y1 * srcW + x0;
                    const i3 = srcOff + y1 * srcW + x1;

                    let minDepth = mn[i0];
                    const mn1 = mn[i1];
                    const mn2 = mn[i2];
                    const mn3 = mn[i3];
                    if (mn1 < minDepth) minDepth = mn1;
                    if (mn2 < minDepth) minDepth = mn2;
                    if (mn3 < minDepth) minDepth = mn3;

                    let maxDepth = mx[i0];
                    const mx1 = mx[i1];
                    const mx2 = mx[i2];
                    const mx3 = mx[i3];
                    if (mx1 > maxDepth) maxDepth = mx1;
                    if (mx2 > maxDepth) maxDepth = mx2;
                    if (mx3 > maxDepth) maxDepth = mx3;

                    const dst = dstOff + y * dstW + x;
                    mn[dst] = minDepth;
                    mx[dst] = maxDepth;
                }
            }
        }
    }

    function rasterizeTriangles(mesh: Float32Array, offset: number, count: number, transform: Float32Array) {
        const end = offset + count;
        for (let i = offset; i < end; i += 9) {
            transformPoint(clipA, 0, mesh[i], mesh[i + 1], mesh[i + 2], transform);
            transformPoint(clipB, 0, mesh[i + 3], mesh[i + 4], mesh[i + 5], transform);
            transformPoint(clipC, 0, mesh[i + 6], mesh[i + 7], mesh[i + 8], transform);
            rasterizeClipped(clipA, 0, clipB, 0, clipC, 0);
        }
    }

    function rasterizeIndexed(
        vertOffset: number,
        vertCount: number,
        indexOffset: number,
        indexCount: number,
        transform: Float32Array
    ) {
        if (vertCount === 0 || indexCount < 3) {
            return;
        }

        const need = vertCount * 4;
        if (clipCache.length < need) {
            let cap = Math.max(clipCache.length, 64);
            while (cap < need) {
                cap <<= 1;
            }
            clipCache = new Float32Array(cap);
        }

        const vertices = scene.meshVertices;
        const indices = scene.meshIndices;
        const cache = clipCache;
        const vbase = vertOffset * 3;
        for (let i = 0; i < vertCount; i++) {
            const o = vbase + i * 3;
            transformPoint(cache, i * 4, vertices[o], vertices[o + 1], vertices[o + 2], transform);
        }

        for (let t = 0; t < indexCount; t += 3) {
            rasterizeClipped(
                cache, indices[indexOffset + t] * 4,
                cache, indices[indexOffset + t + 1] * 4,
                cache, indices[indexOffset + t + 2] * 4
            );
        }
    }

    function rasterizeClipped(
        a: Float32Array, aOff: number,
        b: Float32Array, bOff: number,
        c: Float32Array, cOff: number
    ) {
        polyIn[0] = a[aOff]; polyIn[1] = a[aOff + 1]; polyIn[2] = a[aOff + 2]; polyIn[3] = a[aOff + 3];
        polyIn[4] = b[bOff]; polyIn[5] = b[bOff + 1]; polyIn[6] = b[bOff + 2]; polyIn[7] = b[bOff + 3];
        polyIn[8] = c[cOff]; polyIn[9] = c[cOff + 1]; polyIn[10] = c[cOff + 2]; polyIn[11] = c[cOff + 3];

        const outCount = clipPolyNear(polyIn, 3, polyOut);
        if (outCount < 3) {
            return;
        }

        for (let i = 1; i < outCount - 1; i++) {
            rasterizeScreen(
                polyOut[0], polyOut[1], polyOut[2], polyOut[3],
                polyOut[i * 4], polyOut[i * 4 + 1], polyOut[i * 4 + 2], polyOut[i * 4 + 3],
                polyOut[(i + 1) * 4], polyOut[(i + 1) * 4 + 1], polyOut[(i + 1) * 4 + 2], polyOut[(i + 1) * 4 + 3]
            );
        }
    }

    function clipPolyNear(src: Float32Array, srcCount: number, dst: Float32Array) {
        let dstCount = 0;
        for (let i = 0; i < srcCount; i++) {
            const aOff = i * 4;
            const bOff = ((i + 1) % srcCount) * 4;
            const da = src[aOff + 2] + src[aOff + 3];
            const db = src[bOff + 2] + src[bOff + 3];
            const aIn = da >= NEAR_EPS;
            const bIn = db >= NEAR_EPS;

            if (aIn) {
                dst[dstCount * 4] = src[aOff];
                dst[dstCount * 4 + 1] = src[aOff + 1];
                dst[dstCount * 4 + 2] = src[aOff + 2];
                dst[dstCount * 4 + 3] = src[aOff + 3];
                dstCount++;
            }

            if (aIn !== bIn) {
                const t = da / (da - db);
                dst[dstCount * 4]     = src[aOff]     + (src[bOff]     - src[aOff]) * t;
                dst[dstCount * 4 + 1] = src[aOff + 1] + (src[bOff + 1] - src[aOff + 1]) * t;
                dst[dstCount * 4 + 2] = src[aOff + 2] + (src[bOff + 2] - src[aOff + 2]) * t;
                dst[dstCount * 4 + 3] = src[aOff + 3] + (src[bOff + 3] - src[aOff + 3]) * t;
                dstCount++;
            }
        }
        return dstCount;
    }

    function rasterizeScreen(
        ax: number, ay: number, az: number, aw: number,
        bx: number, by: number, bz: number, bw: number,
        cx: number, cy: number, cz: number, cw: number
    ) {
        if (aw <= NEAR_EPS ||
            bw <= NEAR_EPS ||
            cw <= NEAR_EPS) {
            return;
        }

        const width = hiz.width;
        const height = hiz.height;
        const axn = ax / aw;
        const ayn = ay / aw;
        const azn = az / aw;
        const bxn = bx / bw;
        const byn = by / bw;
        const bzn = bz / bw;
        const cxn = cx / cw;
        const cyn = cy / cw;
        const czn = cz / cw;

        const x0 = (axn * 0.5 + 0.5) * width;
        const y0 = (ayn * 0.5 + 0.5) * height;
        const z0 = azn * 0.5 + 0.5;
        const x1 = (bxn * 0.5 + 0.5) * width;
        const y1 = (byn * 0.5 + 0.5) * height;
        const z1 = bzn * 0.5 + 0.5;
        const x2 = (cxn * 0.5 + 0.5) * width;
        const y2 = (cyn * 0.5 + 0.5) * height;
        const z2 = czn * 0.5 + 0.5;

        const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
        if (area <= 0) {
            return;
        }

        let minX = Math.floor(Math.min(x0, x1, x2));
        let maxX = Math.ceil(Math.max(x0, x1, x2)) - 1;
        let minY = Math.floor(Math.min(y0, y1, y2));
        let maxY = Math.ceil(Math.max(y0, y1, y2)) - 1;

        if (minX < 0) minX = 0;
        if (minY < 0) minY = 0;
        if (maxX >= width) maxX = width - 1;
        if (maxY >= height) maxY = height - 1;
        if (minX > maxX || minY > maxY) {
            return;
        }

        const invArea = 1 / area;
        const data = hiz.max!;
        const stride = hiz.mipWidth![0];

        for (let y = minY; y <= maxY; y++) {
            const py = y + 0.5;
            const row = y * stride;
            for (let x = minX; x <= maxX; x++) {
                const px = x + 0.5;
                const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * invArea;
                const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * invArea;
                const w2 = 1 - w0 - w1;
                if (w0 < 0 || w1 < 0 || w2 < 0) {
                    continue;
                }
                const z = w0 * z0 + w1 * z1 + w2 * z2;
                if (z < 0 || z > 1) {
                    continue;
                }
                const index = row + x;
                if (z < data[index]) {
                    data[index] = z;
                    hiz.dirty = true;
                }
            }
        }
    }

    function testAabb(
        cx: number, cy: number, cz: number,
        hx: number, hy: number, hz: number,
        vp: Float32Array
    ) {
        let minX = 1;
        let minY = 1;
        let minZ = 1;
        let maxX = -1;
        let maxY = -1;
        let maxZ = -1;
        let any = false;

        for (let i = 0; i < 8; i++) {
            const x = cx + ((i & 1) ? hx : -hx);
            const y = cy + ((i & 2) ? hy : -hy);
            const z = cz + ((i & 4) ? hz : -hz);
            transformPoint(clipTmp, 0, x, y, z, vp);
            if (clipTmp[3] <= NEAR_EPS) {
                return FLAG_VISIBLE;
            }
            const ndcX = clipTmp[0] / clipTmp[3];
            const ndcY = clipTmp[1] / clipTmp[3];
            const ndcZ = clipTmp[2] / clipTmp[3];
            const winZ = ndcZ * 0.5 + 0.5;
            if (!any) {
                minX = maxX = ndcX;
                minY = maxY = ndcY;
                minZ = maxZ = winZ;
                any = true;
            }
            else {
                if (ndcX < minX) minX = ndcX;
                if (ndcY < minY) minY = ndcY;
                if (winZ < minZ) minZ = winZ;
                if (ndcX > maxX) maxX = ndcX;
                if (ndcY > maxY) maxY = ndcY;
                if (winZ > maxZ) maxZ = winZ;
            }
        }

        if (maxZ >= 1 || maxX < -1 || minX > 1 || maxY < -1 || minY > 1) {
            return FLAG_VISIBLE;
        }

        const range = getRectMinMax(minX, minY, maxX, maxY);
        if (minZ > range.max) {
            return FLAG_OCCLUDED;
        }
        return FLAG_VISIBLE;
    }

    function getRectMinMax(ndcMinX: number, ndcMinY: number, ndcMaxX: number, ndcMaxY: number) {
        const px0 = clamp01(ndcMinX * 0.5 + 0.5) * hiz.width;
        const py0 = clamp01(ndcMinY * 0.5 + 0.5) * hiz.height;
        const px1 = clamp01(ndcMaxX * 0.5 + 0.5) * hiz.width;
        const py1 = clamp01(ndcMaxY * 0.5 + 0.5) * hiz.height;

        const span = Math.max(px1 - px0, py1 - py0, 1);
        let level = Math.floor(Math.log2(span)) - 1;
        if (level < 0) level = 0;
        if (level >= hiz.levels) level = hiz.levels - 1;

        const widths = hiz.mipWidth!;
        const heights = hiz.mipHeight!;
        const offsets = hiz.mipOffset!;
        const mn = hiz.min!;
        const mx = hiz.max!;

        let x0 = 0;
        let x1 = 0;
        let y0 = 0;
        let y1 = 0;
        let mipW = 1;
        let mipH = 1;

        for (;;) {
            mipW = widths[level];
            mipH = heights[level];
            x0 = Math.floor(px0 * mipW / hiz.width);
            y0 = Math.floor(py0 * mipH / hiz.height);
            x1 = Math.ceil(px1 * mipW / hiz.width) - 1;
            y1 = Math.ceil(py1 * mipH / hiz.height) - 1;
            if (x1 < x0) x1 = x0;
            if (y1 < y0) y1 = y0;
            if (x0 < 0) x0 = 0;
            if (y0 < 0) y0 = 0;
            if (x1 >= mipW) x1 = mipW - 1;
            if (y1 >= mipH) y1 = mipH - 1;

            const count = (x1 - x0 + 1) * (y1 - y0 + 1);
            if (count <= 8 || level >= hiz.levels - 1) {
                break;
            }
            level++;
        }

        const base = offsets[level];
        let minDepth = 1;
        let maxDepth = 0;
        for (let y = y0; y <= y1; y++) {
            const row = base + y * mipW;
            for (let x = x0; x <= x1; x++) {
                const i = row + x;
                const dMin = mn[i];
                const dMax = mx[i];
                if (dMin < minDepth) minDepth = dMin;
                if (dMax > maxDepth) maxDepth = dMax;
            }
        }

        return { min: minDepth, max: maxDepth };
    }

    function transformPoint(out: Float32Array, outOff: number, x: number, y: number, z: number, m: Float32Array) {
        out[outOff] = m[0] * x + m[4] * y + m[8] * z + m[12];
        out[outOff + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        out[outOff + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        out[outOff + 3] = m[3] * x + m[7] * y + m[11] * z + m[15];
    }

    function mulMat4(out: Float32Array, a: Float32Array, b: Float32Array, bOff: number) {
        for (let col = 0; col < 4; col++) {
            const i = bOff + col * 4;
            const b0 = b[i];
            const b1 = b[i + 1];
            const b2 = b[i + 2];
            const b3 = b[i + 3];
            out[col * 4]     = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
            out[col * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
            out[col * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
            out[col * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
        }
    }

    function clamp01(v: number) {
        if (v < 0) return 0;
        if (v > 1) return 1;
        return v;
    }

    function toUs(ms: number) {
        return (ms * 1000 + 0.5) | 0;
    }

    function buildBoxMesh() {
        const min = -0.5;
        const max = 0.5;
        const verts = [
            min, min, min,
            max, min, min,
            max, max, min,
            min, max, min,
            min, min, max,
            max, min, max,
            max, max, max,
            min, max, max
        ];
        const indices = [
            0, 2, 1, 0, 3, 2,
            4, 5, 6, 4, 6, 7,
            0, 1, 5, 0, 5, 4,
            3, 7, 6, 3, 6, 2,
            0, 4, 7, 0, 7, 3,
            1, 2, 6, 1, 6, 5
        ];
        return meshFromIndexed(verts, indices);
    }

    function buildPlaneMesh() {
        return new Float32Array([
            -0.5, -0.5, 0,  0.5, -0.5, 0,  0.5,  0.5, 0,
            -0.5, -0.5, 0,  0.5,  0.5, 0, -0.5,  0.5, 0
        ]);
    }

    function buildCylinderMesh(segments: number) {
        const tris: number[] = [];
        const y0 = -0.5;
        const y1 = 0.5;
        const r = 0.5;
        for (let i = 0; i < segments; i++) {
            const a0 = (i / segments) * Math.PI * 2;
            const a1 = ((i + 1) / segments) * Math.PI * 2;
            const x0 = Math.cos(a0) * r;
            const z0 = Math.sin(a0) * r;
            const x1 = Math.cos(a1) * r;
            const z1 = Math.sin(a1) * r;
            pushTri(tris, x0, y0, z0, x1, y1, z1, x1, y0, z1);
            pushTri(tris, x0, y0, z0, x0, y1, z0, x1, y1, z1);
            pushTri(tris, 0, y1, 0, x1, y1, z1, x0, y1, z0);
            pushTri(tris, 0, y0, 0, x0, y0, z0, x1, y0, z1);
        }
        return new Float32Array(tris);
    }

    function buildConeMesh(segments: number) {
        const tris: number[] = [];
        const y0 = -0.5;
        const y1 = 0.5;
        const r = 0.5;
        for (let i = 0; i < segments; i++) {
            const a0 = (i / segments) * Math.PI * 2;
            const a1 = ((i + 1) / segments) * Math.PI * 2;
            const x0 = Math.cos(a0) * r;
            const z0 = Math.sin(a0) * r;
            const x1 = Math.cos(a1) * r;
            const z1 = Math.sin(a1) * r;
            pushTri(tris, x0, y0, z0, 0, y1, 0, x1, y0, z1);
            pushTri(tris, 0, y0, 0, x0, y0, z0, x1, y0, z1);
        }
        return new Float32Array(tris);
    }

    function buildIcosahedronMesh() {
        const t = (1 + Math.sqrt(5)) * 0.5;
        const raw = [
            0,  1,  t,  0,  1, -t,  0, -1,  t,  0, -1, -t,
            1,  t,  0, -1,  t,  0,  1, -t,  0, -1, -t,  0,
            t,  0,  1, -t,  0,  1,  t,  0, -1, -t,  0, -1
        ];
        const scale = 0.5 / Math.sqrt(1 + t * t);
        const verts: number[] = [];
        for (let i = 0; i < raw.length; i++) {
            verts.push(raw[i] * scale);
        }
        const indices = [
            0, 8, 4,  0, 2, 8,  0, 9, 2,  0, 5, 9,  0, 4, 5,
            1, 4, 10, 1, 5, 4,  1, 11, 5, 1, 3, 11, 1, 10, 3,
            2, 6, 8,  2, 7, 6,  2, 9, 7,
            3, 7, 11, 3, 6, 7,  3, 10, 6,
            4, 8, 10, 5, 11, 9, 6, 10, 8, 7, 9, 11
        ];
        return meshFromIndexed(verts, indices);
    }

    function meshFromIndexed(verts: number[], indices: number[]) {
        const out = new Float32Array(indices.length * 3);
        let o = 0;
        for (let i = 0; i < indices.length; i++) {
            const v = indices[i] * 3;
            out[o++] = verts[v];
            out[o++] = verts[v + 1];
            out[o++] = verts[v + 2];
        }
        return out;
    }

    function pushTri(
        dst: number[],
        ax: number, ay: number, az: number,
        bx: number, by: number, bz: number,
        cx: number, cy: number, cz: number
    ) {
        dst.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    }
}

export function spawnSoftwareOcclusionWorker(): { worker: Worker; url: string } {
    const url = URL.createObjectURL(new Blob(
        [`"use strict";(${softwareOcclusionWorkerMain.toString()})();`],
        { type: "application/javascript" }
    ));
    return { worker: new Worker(url), url };
}
