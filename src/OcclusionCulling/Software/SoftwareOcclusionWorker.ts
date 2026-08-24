/**
 * Self-contained worker entry. Stringified into a Blob so the library
 * does not need a separate worker asset. Do not close over module scope.
 *
 * Owns occluder/mesh state (updated via dirty frame patches). Hi-Z lives
 * only here: it is allocated, cleared, filled and sampled in this worker,
 * and is never copied back to the main thread.
 *
 * Types are `import type` only — erased at compile time and safe with Blob stringify.
 */
import type {
    ISoftwareOcclusionFrameMessage,
    ISoftwareOcclusionFramePatches,
    ISoftwareOcclusionJobStats,
    ISoftwareOcclusionResultMessage,
    TSoftwareOcclusionWorkerInboundMessage
} from "./SoftwareOcclusionMessages.js";

export function softwareOcclusionWorkerMain() {

    const ctx = self as unknown as {
        onmessage: ((event: MessageEvent) => void) | null;
        postMessage: (message: unknown, transfer?: Transferable[]) => void;
    };

    const OCCLUDER_MESH = 6;
    const FLAG_OCCLUDED = 1;
    const FLAG_VISIBLE = 2;
    const OCCLUDER_STRIDE = 16;
    const NEAR_EPS = 1e-5;
    const EDGE_BIAS = -1e-7;
    const MIN_RASTER_PIXELS = 4;
    const AABB_OUT = 0;
    const AABB_IN = 1;
    const AABB_NEAR = 2;
    const EMPTY_U32 = new Uint32Array(0);
    const ORTHO_EPS = 1e-6;

    interface IAabb {
        cx: number;
        cy: number;
        cz: number;
        hx: number;
        hy: number;
        hz: number;
    }

    interface IPrimMesh extends IAabb {
        vertices: Float32Array;
        indices: Uint32Array;
        edgeIndices: Uint32Array;
        vertexCount: number;
        indexCount: number;
    }

    const primitiveMeshes: (IPrimMesh | null)[] = [
        null,
        buildBoxMesh(),
        buildPlaneMesh(),
        buildCylinderMesh(8),
        buildConeMesh(8),
        buildIcosahedronMesh()
    ];

    const lastVp = new Float32Array(16);
    const mvp = new Float32Array(16);
    const polyIn = new Float32Array(16);
    const polyOut = new Float32Array(20);

    let clipCache = new Float32Array(0);

    let hizW = 0;
    let hizH = 0;
    let hizHW = 0;
    let hizHH = 0;
    let hizLevels = 0;
    let hizLast = 0;
    let hizStride0 = 0;
    let hizN0 = 0;
    let hizDirty = false;
    let hizValid = false;
    let hizHasDepth = false;
    let occludersDirty = true;
    let hizMax: Float32Array | null = null;
    let hizMipOff: Int32Array | null = null;
    let hizMipW: Int32Array | null = null;
    let hizMipH: Int32Array | null = null;
    let hizGlobalMin = 1;
    let hizGlobalMax = 1;

    interface IWorkerMesh extends IAabb {
        vertices: Float32Array;
        indices: Uint32Array;
        edgeIndices: Uint32Array;
        vertexCount: number;
        indexCount: number;
    }

    let occluderTypes = new Uint32Array(0);
    let occluderMatrices = new Float32Array(0);
    let occluderMeshIds = new Int32Array(0);

    let liveIndex = new Int32Array(0);
    let projMinX = 0;
    let projMinY = 0;
    let projMaxX = 0;
    let projMaxY = 0;
    let projMinZ = 0;
    let projMaxZ = 0;
    let meshes: (IWorkerMesh | null)[] = [];
    let aabbCenters = new Float32Array(0);
    let aabbHalfExtents = new Float32Array(0);
    let aabbCount = 0;
    let resultFlags = new Uint32Array(0);
    let lastOccluderCount = 0;

    const liveIds: number[] = [];
    const testAabbBox = primMesh([], []);
    const defaultStats: ISoftwareOcclusionJobStats = {
        clearUs: 0,
        rasterUs: 0,
        hizUs: 0,
        aabbUs: 0,
        totalUs: 0,
        occluders: 0,
        aabbs: 0,
        occluded: 0,
        visible: 0,
    };

    ctx.onmessage = function (event: MessageEvent<TSoftwareOcclusionWorkerInboundMessage>) {
        const msg = event.data;
        if (msg && typeof msg === "object") {
            switch (msg.t) {
                case "frame":
                    runFrame(msg);
                    return;
                case "init": {
                    const init = msg;
                    allocHiZ(init.width, init.height);
                    ensureOccluderCapacity(init.occluderCapacity | 0);
                    ensureMeshSlots(init.meshSlots | 0);
                    ensureAabbCapacity(init.aabbCapacity | 0);
                    ctx.postMessage({ t: "ready" });
                    return;
                }
            }
        }
    };

    function growCapacity(current: number, required: number) {
        let next = current > 0 ? current : 64;
        while (next < required) {
            const grown = next + (next >> 1);
            next = grown > next ? grown : next + 1;
        }
        return next;
    }

    function ensureLiveIndexCapacity(capacity: number) {
        const required = capacity | 0;
        if (required > liveIndex.length) {
            const nextCapacity = growCapacity(liveIndex.length, required);
            const next = new Int32Array(nextCapacity);
            next.fill(-1);
            if (liveIndex.length > 0) {
                next.set(liveIndex);
            }
            liveIndex = next;
        }
    }

    function ensureOccluderCapacity(capacity: number) {
        const required = capacity | 0;
        if (required > occluderTypes.length) {
            const nextCapacity = growCapacity(occluderTypes.length, required);
            const nextTypes = new Uint32Array(nextCapacity);
            const nextMatrices = new Float32Array(nextCapacity * OCCLUDER_STRIDE);
            const nextMeshIds = new Int32Array(nextCapacity).fill(-1);
            nextTypes.set(occluderTypes);
            nextMatrices.set(occluderMatrices);
            nextMeshIds.set(occluderMeshIds);
            occluderTypes = nextTypes;
            occluderMatrices = nextMatrices;
            occluderMeshIds = nextMeshIds;
            ensureLiveIndexCapacity(nextCapacity);
        }
    }

    function ensureMeshSlots(slotCount: number) {
        const required = Math.max(1, slotCount | 0);
        if (required > meshes.length) {
            const nextCapacity = growCapacity(meshes.length, required);
            while (meshes.length < nextCapacity) {
                meshes.push(null);
            }
        }
    }

    function ensureAabbCapacity(capacity: number) {
        const required = (capacity | 0) << 2;
        if (required > aabbCenters.length) {
            const nextFloats = growCapacity(aabbCenters.length, required);
            const nextCenters = new Float32Array(nextFloats);
            const nextHalves = new Float32Array(nextFloats);
            nextCenters.set(aabbCenters);
            nextHalves.set(aabbHalfExtents);
            aabbCenters = nextCenters;
            aabbHalfExtents = nextHalves;
        }
    }

    function ensureResultFlags(count: number): Uint32Array {
        if (count > 0) {
            if (resultFlags.length < count) {
                resultFlags = new Uint32Array(growCapacity(resultFlags.length, count));
            }
            return resultFlags.subarray(0, count);
        }
        return EMPTY_U32;
    }

    function setLive(id: number, live: boolean) {

        if (live) {
            if (liveIndex[id] >= 0) {
                return;
            }
            liveIndex[id] = liveIds.length;
            liveIds.push(id);
            return;
        }

        const idx = liveIndex[id];
        if (idx < 0) {
            return;
        }

        const last = liveIds.length - 1;
        if (idx !== last) {
            const swapped = liveIds[last];
            liveIds[idx] = swapped;
            liveIndex[swapped] = idx;
        }

        liveIds.pop();
        liveIndex[id] = -1;
    }

    function applyPatches(msg: ISoftwareOcclusionFramePatches) {

        if (msg.resize) {
            ensureOccluderCapacity(msg.resize.occluderCapacity);
            ensureMeshSlots(msg.resize.meshSlots);
            if (msg.resize.aabbCapacity) {
                ensureAabbCapacity(msg.resize.aabbCapacity);
            }
        }

        if (msg.aabbFull) {
            const centers = msg.aabbFull.centers;
            const halves = msg.aabbFull.halfExtents;
            const count = centers.length >> 2;
            ensureAabbCapacity(count);
            aabbCenters.set(centers);
            aabbHalfExtents.set(halves);
            aabbCount = count;
        }

        const aabbUpserts = msg.aabbUpserts;
        if (aabbUpserts) {
            const ids = aabbUpserts.ids;
            const centers = aabbUpserts.centers;
            const halves = aabbUpserts.halfExtents;
            const n = ids.length;
            if (n > 0) {
                let maxId = 0;
                for (let i = 0; i < n; i++) {
                    const id = ids[i];
                    if (id > maxId) {
                        maxId = id;
                    }
                }
                ensureAabbCapacity(maxId + 1);
                for (let i = 0; i < n; i++) {
                    const id = ids[i];
                    const s = i << 2;
                    const d = id << 2;
                    for (let j = 0; j < 4; j++) {
                        aabbCenters[d + j] = centers[s + j];
                        aabbHalfExtents[d + j] = halves[s + j];
                    }
                }
                const nextCount = maxId + 1;
                if (nextCount > aabbCount) {
                    aabbCount = nextCount;
                }
            }
        }

        const meshUpserts = msg.meshUpserts;
        if (meshUpserts && meshUpserts.length > 0) {
            occludersDirty = true;
            let maxSlot = 0;
            for (let i = 0; i < meshUpserts.length; i++) {
                const id = meshUpserts[i].id | 0;
                if (id > maxSlot) {
                    maxSlot = id;
                }
            }
            ensureMeshSlots(maxSlot + 1);
            for (let i = 0; i < meshUpserts.length; i++) {
                const u = meshUpserts[i];
                const id = u.id | 0;
                const aabb = boundsFromVertices(u.vertices);
                meshes[id] = {
                    vertices: u.vertices,
                    indices: u.indices,
                    edgeIndices: buildUniqueEdges(u.indices),
                    vertexCount: (u.vertices.length / 3) | 0,
                    indexCount: u.indices.length,
                    cx: aabb.cx,
                    cy: aabb.cy,
                    cz: aabb.cz,
                    hx: aabb.hx,
                    hy: aabb.hy,
                    hz: aabb.hz
                };
            }
        }

        const occluderUpserts = msg.occluderUpserts;
        if (occluderUpserts && occluderUpserts.ids.length > 0) {
            occludersDirty = true;
            const ids = occluderUpserts.ids;
            const types = occluderUpserts.types;
            const matrices = occluderUpserts.matrices;
            const meshIds = occluderUpserts.meshIds;
            const n = ids.length;
            let maxId = 0;
            for (let i = 0; i < n; i++) {
                const id = ids[i];
                if (id > maxId) {
                    maxId = id;
                }
            }
            ensureOccluderCapacity(maxId + 1);
            for (let i = 0; i < n; i++) {
                const id = ids[i];
                occluderTypes[id] = types[i];
                occluderMeshIds[id] = meshIds[i];
                const s = i << 4;
                const d = id << 4;
                for (let j = 0; j < 16; j++) {
                    occluderMatrices[d + j] = matrices[s + j];
                }
                setLive(id, types[i] !== 0);
            }
        }

        const occluderRemoves = msg.occluderRemoves;
        if (occluderRemoves && occluderRemoves.length > 0) {
            occludersDirty = true;
            for (let i = 0; i < occluderRemoves.length; i++) {
                const id = occluderRemoves[i] | 0;
                if (id < 0 || id >= occluderTypes.length) {
                    continue;
                }
                occluderTypes[id] = 0;
                occluderMeshIds[id] = -1;
                setLive(id, false);
            }
        }

        const meshRemoves = msg.meshRemoves;
        if (meshRemoves && meshRemoves.length > 0) {
            occludersDirty = true;
            for (let i = 0; i < meshRemoves.length; i++) {
                const id = meshRemoves[i] | 0;
                if (id >= 0 && id < meshes.length) {
                    meshes[id] = null;
                }
            }
        }
    }

    function runFrame(msg: ISoftwareOcclusionFrameMessage) {

        let stats = defaultStats;

        const queueIds = msg.queueIds;
        const rawCount = msg.queueCount | 0;
        const idCap = queueIds && queueIds.length ? queueIds.length : 0;
        const queueCount = rawCount < 0 ? 0 : rawCount > idCap ? idCap : rawCount;
        const flags = ensureResultFlags(queueCount);

        let debugLines: Float32Array | null = null;

        try {
            applyPatches(msg);

            // Patch-only / debug refresh: do not raster
            // or test when nothing is queued.
            if (queueCount > 0) {
                stats = runJob(msg.vp, queueIds, queueCount, flags);
            }

            if (msg.debugOccluders) {
                debugLines = buildOccluderDebugLines();
            }
        }
        catch {
            // Still return compact flags so the main thread can clear pending.
            flags.fill(FLAG_VISIBLE, 0, queueCount);
        }

        const result: ISoftwareOcclusionResultMessage = {
            t: "result",
            flags,
            ...stats
        };

        if (debugLines) {
            result.debugLines = debugLines;
            result.debugLineCount = (debugLines.length / 6) | 0;
            ctx.postMessage(result, [debugLines.buffer]);
            return;
        }

        ctx.postMessage(result);
    }

    function runJob(
        vp: Float32Array,
        queueIds: Uint32Array,
        queueCount: number,
        flags: Uint32Array
    ): ISoftwareOcclusionJobStats {
        const t0 = performance.now();
        const reuseHiz = hizValid && !occludersDirty && vpEquals(vp);

        if (reuseHiz) {
            const counts = hizHasDepth
                ? testAabbs(vp, queueIds, queueCount, flags)
                : markVisible(queueCount, flags);
            const tDone = performance.now();
            return {
                clearUs: 0,
                rasterUs: 0,
                hizUs: 0,
                aabbUs: toUs(tDone - t0),
                totalUs: toUs(tDone - t0),
                occluders: lastOccluderCount,
                aabbs: counts.tested,
                occluded: counts.occluded,
                visible: counts.visible
            };
        }

        clearDepth();
        const tClear = performance.now();

        const occluders = rasterizeOccluders(vp);
        const tRaster = performance.now();

        lastVp.set(vp.subarray(0, 16));
        occludersDirty = false;
        hizValid = true;
        hizHasDepth = occluders > 0 && hizDirty;
        lastOccluderCount = occluders;

        if (!hizHasDepth) {
            const counts = markVisible(queueCount, flags);
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

        const counts = testAabbs(vp, queueIds, queueCount, flags);
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

    function vpEquals(vp: Float32Array) {
        for (let i = 0; i < 16; i++) {
            if (vp[i] !== lastVp[i]) {
                return false;
            }
        }
        return true;
    }

    function resolveOccluderMesh(id: number): IWorkerMesh | IPrimMesh | null {
        const type = occluderTypes[id];
        if (type === OCCLUDER_MESH) {
            const meshId = occluderMeshIds[id];
            if (meshId < 0) {
                return null;
            }
            return meshes[meshId];
        }
        return primitiveMeshes[type];
    }

    function testAabb(m: Float32Array, mesh: IAabb, persp: boolean) {

        const status = persp
            ? classifyAabb(m, mesh)
            : classifyAabbOrtho(m, mesh);

        if (status !== AABB_IN) {
            return FLAG_VISIBLE;
        }

        if (projMaxZ < hizGlobalMin) {
            return FLAG_VISIBLE;
        }

        if (projMinZ > hizGlobalMax) {
            return FLAG_OCCLUDED;
        }

        if (projMaxZ >= 1 ||
            projMaxX < -1 || projMinX > 1 ||
            projMaxY < -1 || projMinY > 1) {
            return FLAG_VISIBLE;
        }

        const pxW = (projMaxX - projMinX) * hizHW;
        const pxH = (projMaxY - projMinY) * hizHH;

        if (pxW < 1 && pxH < 1) {
            return FLAG_VISIBLE;
        }

        const rectMaxDepth = sampleRectMax(projMinX, projMinY, projMaxX, projMaxY);
        return projMinZ > rectMaxDepth ? FLAG_OCCLUDED : FLAG_VISIBLE;
    }

    function testAabbs(
        vp: Float32Array,
        queueIds: Uint32Array,
        queueCount: number,
        flags: Uint32Array
    ) {
        const centers = aabbCenters;
        const halves = aabbHalfExtents;
        const box = testAabbBox;
        const persp = isPerspectiveMatrix(vp);
        const tests = queueCount;
        const aabbLimit = aabbCount;

        let occluded = 0;
        let visible = 0;

        for (let i = 0; i < tests; i++) {

            const id = queueIds[i];

            if (id >= aabbLimit) {
                flags[i] = FLAG_VISIBLE;
                visible++;
                continue;
            }

            const base = id << 2;
            box.cx = centers[base];
            box.cy = centers[base + 1];
            box.cz = centers[base + 2];
            box.hx = halves[base];
            box.hy = halves[base + 1];
            box.hz = halves[base + 2];

            const flag = testAabb(vp, box, persp);
            flags[i] = flag;
            if (flag === FLAG_OCCLUDED) {
                occluded++;
            }
            else {
                visible++;
            }
        }

        return {
            tested: tests,
            occluded,
            visible
        };
    }

    function markVisible(queueCount: number, flags: Uint32Array) {
        flags.fill(FLAG_VISIBLE, 0, queueCount);
        return { tested: queueCount, occluded: 0, visible: queueCount };
    }

    // 250k edges * 6 floats per edge = 1.5M floats
    const DEBUG_LINE_FLOAT_CAP = 250000 * 6;

    /**
     * World-space line-list for a `PRIMITIVE_LINES` mesh: each unique
     * triangle edge is two xyz endpoints `[x0,y0,z0, x1,y1,z1, ...]`.
     */
    function buildOccluderDebugLines(): Float32Array | null {

        const n = liveIds.length;
        if (n === 0) {
            return null;
        }

        let floatCount = 0;
        for (let li = 0; li < n; li++) {
            const id = liveIds[li];
            const mesh = resolveOccluderMesh(id);
            if (mesh) {
                floatCount += mesh.edgeIndices.length * 3;
                if (floatCount > DEBUG_LINE_FLOAT_CAP) {
                    floatCount = DEBUG_LINE_FLOAT_CAP;
                    break;
                }
            }
        }

        let w = 0;

        const out = new Float32Array(floatCount);
        for (let li = 0; li < n && w < floatCount; li++) {
            const id = liveIds[li];
            const mesh = resolveOccluderMesh(id);
            if (mesh) {
                const mOff = id << 4;
                const verts = mesh.vertices;
                const edges = mesh.edgeIndices;
                const edgeCount = edges.length;
                for (let e = 0; e + 1 < edgeCount && w + 6 <= floatCount; e += 2) {
                    w = writeWorldEdge(
                        out, w, occluderMatrices, mOff, verts,
                        edges[e] * 3, edges[e + 1] * 3
                    );
                }
            }
        }

        return out.slice(0, w);
    }

    function transformPoint(
        out: Float32Array,
        oi: number,
        m: Float32Array,
        o: number,
        x: number,
        y: number,
        z: number
    ) {
        out[oi] = m[o] * x + m[o + 4] * y + m[o + 8] * z + m[o + 12];
        out[oi + 1] = m[o + 1] * x + m[o + 5] * y + m[o + 9] * z + m[o + 13];
        out[oi + 2] = m[o + 2] * x + m[o + 6] * y + m[o + 10] * z + m[o + 14];
    }

    function writeWorldEdge(
        out: Float32Array,
        w: number,
        matrices: Float32Array,
        mOff: number,
        verts: Float32Array,
        i0: number,
        i1: number
    ): number {
        transformPoint(out, w, matrices, mOff, verts[i0], verts[i0 + 1], verts[i0 + 2]);
        transformPoint(out, w + 3, matrices, mOff, verts[i1], verts[i1 + 1], verts[i1 + 2]);
        return w + 6;
    }

    function nextPow2(n: number) {
        n = n | 0;
        if (n <= 1) {
            return 1;
        }
        return 1 << (32 - Math.clz32(n - 1));
    }

    function allocHiZ(width: number, height: number) {

        width = nextPow2(Math.max(1, width | 0));
        height = nextPow2(Math.max(1, height | 0));

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

            // Stop before a 1-wide/1-tall mip so every
            // reduce is a 2x2 even gather.
            if (w <= 2 ||
                h <= 2) {
                break;
            }

            w >>= 1;
            h >>= 1;
        }

        hizW = width;
        hizH = height;
        hizHW = width * 0.5;
        hizHH = height * 0.5;
        hizStride0 = width;
        hizN0 = width * height;
        hizMax = new Float32Array(total);
        hizMipOff = new Int32Array(offsets);
        hizMipW = new Int32Array(widths);
        hizMipH = new Int32Array(heights);
        hizLevels = widths.length;
        hizLast = widths.length - 1;

        hizDirty = false;
        hizValid = false;
        hizHasDepth = false;
        hizGlobalMin = 1;
        hizGlobalMax = 1;
    }

    function clearDepth() {
        hizMax!.fill(1, 0, hizN0);
        hizDirty = false;
        hizGlobalMin = 1;
        hizGlobalMax = 1;
    }

    function buildHiZ() {

        const mx = hizMax!;
        const offsets = hizMipOff!;
        const widths = hizMipW!;
        const heights = hizMipH!;
        const levels = hizLevels;

        let min = 1;
        let max = 0;

        for (let level = 1; level < levels; level++) {

            const srcOff = offsets[level - 1];
            const dstOff = offsets[level];
            const srcW = widths[level - 1];
            const dstW = widths[level];
            const dstH = heights[level];

            for (let y = 0; y < dstH; y++) {

                const y0 = y << 1;
                const row0 = srcOff + y0 * srcW;
                const row1 = row0 + srcW;
                const dstRow = dstOff + y * dstW;

                for (let x = 0; x < dstW; x++) {

                    const x0 = x << 1;
                    const rowC = row0 + x0;
                    const rowD = row1 + x0;
                    const z0 = mx[rowC];
                    const z1 = mx[rowC + 1];
                    const z2 = mx[rowD];
                    const z3 = mx[rowD + 1];

                    let maxDepth = z0;

                    if (z1 > maxDepth) maxDepth = z1;
                    if (z2 > maxDepth) maxDepth = z2;
                    if (z3 > maxDepth) maxDepth = z3;

                    if (maxDepth > max) max = maxDepth;

                    if (z0 < min) min = z0;
                    if (z1 < min) min = z1;
                    if (z2 < min) min = z2;
                    if (z3 < min) min = z3;

                    mx[dstRow + x] = maxDepth;
                }
            }
        }

        if (levels === 1) {
            const n = hizN0;
            for (let i = 0; i < n; i++) {
                const d = mx[i];
                if (d < min) min = d;
                if (d > max) max = d;
            }
        }

        hizGlobalMin = min;
        hizGlobalMax = max;
    }

    function ndcToUv(ndc: number) {
        const n = ndc * 0.5 + 0.5;
        return n < 0 ? 0 : n > 1 ? 1 : n;
    }

    function mipLevelForSize(size: number) {
        if (size <= 1) {
            return 0;
        }
        const i = size | 0;
        const ceilSize = i === size ? i : i + 1;
        return 32 - Math.clz32(ceilSize - 1);
    }

    function sampleRectMax(
        ndcMinX: number,
        ndcMinY: number,
        ndcMaxX: number,
        ndcMaxY: number
    ) {
        const ux0 = ndcToUv(ndcMinX);
        const uy0 = ndcToUv(ndcMinY);
        const ux1 = ndcToUv(ndcMaxX);
        const uy1 = ndcToUv(ndcMaxY);

        const dx = (ux1 - ux0) * hizW;
        const dy = (uy1 - uy0) * hizH;
        const halfSpan = (dx > dy ? dx : dy) * 0.5;

        let level = mipLevelForSize(halfSpan);
        if (level > hizLast) {
            level = hizLast;
        }

        const mipW = hizMipW![level];
        const mipH = hizMipH![level];
        const lastX = mipW - 1;
        const lastY = mipH - 1;
        const base = hizMipOff![level];
        const data = hizMax!;

        let x0 = (ux0 * mipW) | 0;
        let y0 = (uy0 * mipH) | 0;
        const rx1 = ux1 * mipW;
        const ry1 = uy1 * mipH;
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

        let maxDepth = 0;
        for (let y = y0; y <= y1; y++) {
            let index = base + y * mipW + x0;
            const end = index + (x1 - x0);
            for (; index <= end; index++) {
                const d = data[index];
                if (d > maxDepth) {
                    maxDepth = d;
                }
            }
        }

        return maxDepth;
    }

    function rasterizeOccluders(vp: Float32Array) {

        const matrices = occluderMatrices;
        const n = liveIds.length;
        const persp = isPerspectiveMatrix(vp);

        let occluders = 0;

        for (let li = 0; li < n; li++) {

            const id = liveIds[li];
            const mesh = resolveOccluderMesh(id);
            if (mesh && mesh.vertexCount > 0) {

                mulMat4(mvp, vp, matrices, id << 4);

                const status = persp
                    ? classifyAabb(mvp, mesh)
                    : classifyAabbOrtho(mvp, mesh);

                if (status === AABB_OUT) {
                    continue;
                }

                if (status !== AABB_NEAR) {
                    const pxW = (projMaxX - projMinX) * hizHW;
                    const pxH = (projMaxY - projMinY) * hizHH;
                    if (pxW * pxH < MIN_RASTER_PIXELS) {
                        continue;
                    }
                }

                occluders++;
                rasterizeIndexed(
                    mesh.vertices, mesh.indices,
                    0, mesh.vertexCount,
                    0, mesh.indexCount,
                    mvp
                );
            }
        }

        return occluders;
    }

    function rasterizeIndexed(
        vertices: Float32Array,
        indices: Uint32Array,
        vertOffset: number,
        vertCount: number,
        indexOffset: number,
        indexCount: number,
        mvp: Float32Array
    ) {
        if (vertCount === 0 ||
            indexCount < 3) {
            return;
        }

        const need = vertCount << 3;
        if (clipCache.length < need) {
            clipCache = new Float32Array(growCapacity(clipCache.length, need));
        }

        const cache = clipCache;
        const m0 = mvp[0], m1 = mvp[1], m2 = mvp[2], m3 = mvp[3];
        const m4 = mvp[4], m5 = mvp[5], m6 = mvp[6], m7 = mvp[7];
        const m8 = mvp[8], m9 = mvp[9], m10 = mvp[10], m11 = mvp[11];
        const m12 = mvp[12], m13 = mvp[13], m14 = mvp[14], m15 = mvp[15];
        const hw = hizHW;
        const hh = hizHH;

        let src = vertOffset * 3;
        let dst = 0;

        for (let i = 0; i < vertCount; i++) {

            const x = vertices[src];
            const y = vertices[src + 1];
            const z = vertices[src + 2];
            const cw = m3 * x + m7 * y + m11 * z + m15;
            const cx = m0 * x + m4 * y + m8 * z + m12;
            const cy = m1 * x + m5 * y + m9 * z + m13;
            const cz = m2 * x + m6 * y + m10 * z + m14;
            const near = cz + cw;

            cache[dst] = cx;
            cache[dst + 1] = cy;
            cache[dst + 2] = cz;
            cache[dst + 3] = cw;
            cache[dst + 7] = near;

            if (cw > NEAR_EPS && near >= NEAR_EPS) {
                const invW = 1 / cw;
                cache[dst + 4] = cx * invW * hw + hw;
                cache[dst + 5] = cy * invW * hh + hh;
                cache[dst + 6] = cz * invW * 0.5 + 0.5;
            }

            src += 3;
            dst += 8;
        }

        for (let t = 0; t + 2 < indexCount; t += 3) {

            const oa = indices[indexOffset + t] << 3;
            const ob = indices[indexOffset + t + 1] << 3;
            const oc = indices[indexOffset + t + 2] << 3;
            const da = cache[oa + 7];
            const db = cache[ob + 7];
            const dc = cache[oc + 7];

            if (da >= NEAR_EPS &&
                db >= NEAR_EPS &&
                dc >= NEAR_EPS &&
                cache[oa + 3] > NEAR_EPS &&
                cache[ob + 3] > NEAR_EPS &&
                cache[oc + 3] > NEAR_EPS) {
                const ax = cache[oa + 4], ay = cache[oa + 5];
                const bx = cache[ob + 4], by = cache[ob + 5];
                const cx = cache[oc + 4], cy = cache[oc + 5];
                rasterizePixels(
                    ax, ay, cache[oa + 6],
                    bx, by, cache[ob + 6],
                    cx, cy, cache[oc + 6]
                );
                continue;
            }

            if (da < NEAR_EPS &&
                db < NEAR_EPS &&
                dc < NEAR_EPS) {
                continue;
            }

            rasterizeClipped(cache, oa, ob, oc);
        }
    }

    function rasterizeClipped(a: Float32Array, aOff: number, bOff: number, cOff: number) {

        const ax = a[aOff], ay = a[aOff + 1], az = a[aOff + 2], aw = a[aOff + 3];
        const bx = a[bOff], by = a[bOff + 1], bz = a[bOff + 2], bw = a[bOff + 3];
        const cx = a[cOff], cy = a[cOff + 1], cz = a[cOff + 2], cw = a[cOff + 3];

        polyIn[0] = ax; polyIn[1] = ay; polyIn[2] = az; polyIn[3] = aw;
        polyIn[4] = bx; polyIn[5] = by; polyIn[6] = bz; polyIn[7] = bw;
        polyIn[8] = cx; polyIn[9] = cy; polyIn[10] = cz; polyIn[11] = cw;

        const outCount = clipPolyNear(polyIn, polyOut);
        if (outCount < 3) {
            return;
        }

        const ox = polyOut[0],
            oy = polyOut[1],
            oz = polyOut[2],
            ow = polyOut[3];

        if (ow <= NEAR_EPS) {
            return;
        }

        const invOw = 1 / ow;
        const px0 = ox * invOw * hizHW + hizHW;
        const py0 = oy * invOw * hizHH + hizHH;
        const pz0 = oz * invOw * 0.5 + 0.5;

        for (let i = 1; i < outCount - 1; i++) {

            const b4 = i << 2;
            const c4 = (i + 1) << 2;
            const bw = polyOut[b4 + 3];
            const cw = polyOut[c4 + 3];

            if (bw <= NEAR_EPS ||
                cw <= NEAR_EPS) {
                continue;
            }

            const invBw = 1 / bw;
            const invCw = 1 / cw;

            rasterizePixels(
                px0, py0, pz0,
                polyOut[b4] * invBw * hizHW + hizHW,
                polyOut[b4 + 1] * invBw * hizHH + hizHH,
                polyOut[b4 + 2] * invBw * 0.5 + 0.5,
                polyOut[c4] * invCw * hizHW + hizHW,
                polyOut[c4 + 1] * invCw * hizHH + hizHH,
                polyOut[c4 + 2] * invCw * 0.5 + 0.5
            );
        }
    }

    function clipPolyNear(src: Float32Array, dst: Float32Array) {

        let dstCount = 0;
        let aOff = 8;
        let da = src[10] + src[11];

        for (let i = 0; i < 3; i++) {
            const bOff = i << 2;
            const db = src[bOff + 2] + src[bOff + 3];
            const aIn = da >= NEAR_EPS;
            const bIn = db >= NEAR_EPS;
            const out = dstCount << 2;

            if (aIn) {
                dst[out] = src[aOff];
                dst[out + 1] = src[aOff + 1];
                dst[out + 2] = src[aOff + 2];
                dst[out + 3] = src[aOff + 3];
                dstCount++;
            }

            if (aIn !== bIn) {
                const t = da / (da - db);
                const o = dstCount << 2;
                dst[o] = src[aOff] + (src[bOff] - src[aOff]) * t;
                dst[o + 1] = src[aOff + 1] + (src[bOff + 1] - src[aOff + 1]) * t;
                dst[o + 2] = src[aOff + 2] + (src[bOff + 2] - src[aOff + 2]) * t;
                dst[o + 3] = src[aOff + 3] + (src[bOff + 3] - src[aOff + 3]) * t;
                dstCount++;
            }

            aOff = bOff;
            da = db;
        }

        return dstCount;
    }

    function rasterizePixels(
        x0: number, y0: number, z0: number,
        x1: number, y1: number, z1: number,
        x2: number, y2: number, z2: number
    ) {
        const e1dx = y2 - y0;
        const e2dy = x1 - x0;

        const area = e2dy * e1dx - (x2 - x0) * (y1 - y0);
        if (!(area > 0)) {
            return;
        }

        let minXF = x0;
        let maxXF = x0;
        let minYF = y0;
        let maxYF = y0;

        if (x1 < minXF) minXF = x1;
        if (x2 < minXF) minXF = x2;
        if (x1 > maxXF) maxXF = x1;
        if (x2 > maxXF) maxXF = x2;

        if (y1 < minYF) minYF = y1;
        if (y2 < minYF) minYF = y2;
        if (y1 > maxYF) maxYF = y1;
        if (y2 > maxYF) maxYF = y2;

        const width = hizW;
        const height = hizH;

        if (
            maxXF <= 0 ||
            maxYF <= 0 ||
            minXF >= width ||
            minYF >= height
        ) {
            return;
        }

        let minX = minXF | 0;
        let minY = minYF | 0;
        let maxX = maxXF | 0;
        let maxY = maxYF | 0;

        if (minX < 0) minX = 0;
        if (minY < 0) minY = 0;
        if (maxX >= width) maxX = width - 1;
        if (maxY >= height) maxY = height - 1;

        if (minX > maxX || minY > maxY) {
            return;
        }

        const e0dx = y1 - y2;
        const e0dy = x2 - x1;
        const e1dy = x0 - x2;
        const e2dx = y0 - y1;

        const px = minX + 0.5;
        const py = minY + 0.5;

        let e0row = (px - x1) * e0dx + (py - y1) * e0dy;
        let e1row = (px - x2) * e1dx + (py - y2) * e1dy;
        let e2row = (px - x0) * e2dx + (py - y0) * e2dy;

        const bias0 = e0dx < 0 || (e0dx === 0 && e0dy < 0) ? 0 : EDGE_BIAS;
        const bias1 = e1dx < 0 || (e1dx === 0 && e1dy < 0) ? 0 : EDGE_BIAS;
        const bias2 = e2dx < 0 || (e2dx === 0 && e2dy < 0) ? 0 : EDGE_BIAS;

        const invArea = 1 / area;
        const zA = z0 - z2;
        const zB = z1 - z2;

        const dzdx = (e0dx * zA + e1dx * zB) * invArea;
        const dzdy = (e0dy * zA + e1dy * zB) * invArea;

        let zRow = (e0row * zA + e1row * zB + area * z2) * invArea;

        const data = hizMax!;
        const stride = hizStride0;

        const zSafe =
            z0 >= 0 && z0 <= 1 &&
            z1 >= 0 && z1 <= 1 &&
            z2 >= 0 && z2 <= 1;

        let wrote = hizDirty;

        for (let y = minY; y <= maxY; y++) {

            let e0 = e0row;
            let e1 = e1row;
            let e2 = e2row;

            let index = y * stride + minX;
            let z = zRow;

            if (zSafe) {

                for (let x = minX; x <= maxX; x++, index++) {

                    if (
                        e0 + bias0 >= 0 &&
                        e1 + bias1 >= 0 &&
                        e2 + bias2 >= 0
                    ) {
                        if (z < data[index]) {
                            data[index] = z;
                            wrote = true;
                        }
                    }

                    e0 += e0dx;
                    e1 += e1dx;
                    e2 += e2dx;
                    z += dzdx;
                }
            }
            else {

                for (let x = minX; x <= maxX; x++, index++) {

                    if (
                        e0 + bias0 >= 0 &&
                        e1 + bias1 >= 0 &&
                        e2 + bias2 >= 0 &&
                        z >= 0 &&
                        z <= 1
                    ) {
                        if (z < data[index]) {
                            data[index] = z;
                            wrote = true;
                        }
                    }

                    e0 += e0dx;
                    e1 += e1dx;
                    e2 += e2dx;
                    z += dzdx;
                }
            }

            e0row += e0dy;
            e1row += e1dy;
            e2row += e2dy;
            zRow += dzdy;
        }

        hizDirty = wrote;
    }

    function classifyAabb(m: Float32Array, mesh: IAabb) {

        const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3];
        const m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7];
        const m8 = m[8], m9 = m[9], m10 = m[10], m11 = m[11];
        const m12 = m[12], m13 = m[13], m14 = m[14], m15 = m[15];

        const cx = mesh.cx, cy = mesh.cy, cz = mesh.cz;
        const hx = mesh.hx, hy = mesh.hy, hz = mesh.hz;

        const ccx = m0 * cx + m4 * cy + m8 * cz + m12;
        const ccy = m1 * cx + m5 * cy + m9 * cz + m13;
        const ccz = m2 * cx + m6 * cy + m10 * cz + m14;
        const ccw = m3 * cx + m7 * cy + m11 * cz + m15;
        const xx = m0 * hx, xy = m1 * hx, xz = m2 * hx, xw = m3 * hx;
        const yx = m4 * hy, yy = m5 * hy, yz = m6 * hy, yw = m7 * hy;
        const zx = m8 * hz, zy = m9 * hz, zz = m10 * hz, zw = m11 * hz;

        const rXW = absf(xx + xw) + absf(yx + yw) + absf(zx + zw);
        if (ccx + ccw + rXW < 0) return AABB_OUT;

        const rWX = absf(xw - xx) + absf(yw - yx) + absf(zw - zx);
        if (ccw - ccx + rWX < 0) return AABB_OUT;

        const rYW = absf(xy + xw) + absf(yy + yw) + absf(zy + zw);
        if (ccy + ccw + rYW < 0) return AABB_OUT;

        const rWY = absf(xw - xy) + absf(yw - yy) + absf(zw - zy);
        if (ccw - ccy + rWY < 0) return AABB_OUT;

        const rZW = absf(xz + xw) + absf(yz + yw) + absf(zz + zw);
        if (ccz + ccw + rZW < NEAR_EPS) return AABB_OUT;

        let w = ccw - xw - yw - zw;
        if (w <= NEAR_EPS) {
            return AABB_NEAR;
        }

        let invW = 1 / w;
        let minX = (ccx - xx - yx - zx) * invW;
        let minY = (ccy - xy - yy - zy) * invW;
        let minZ = (ccz - xz - yz - zz) * invW * 0.5 + 0.5;
        let maxX = minX;
        let maxY = minY;
        let maxZ = minZ;

        for (let i = 1; i < 8; i++) {
            const sx = (i & 1) ? 1 : -1;
            const sy = (i & 2) ? 1 : -1;
            const sz = (i & 4) ? 1 : -1;
            w = ccw + sx * xw + sy * yw + sz * zw;
            if (w <= NEAR_EPS) {
                return AABB_NEAR;
            }
            invW = 1 / w;
            const ndcX = (ccx + sx * xx + sy * yx + sz * zx) * invW;
            const ndcY = (ccy + sx * xy + sy * yy + sz * zy) * invW;
            const winZ = (ccz + sx * xz + sy * yz + sz * zz) * invW * 0.5 + 0.5;
            if (ndcX < minX) minX = ndcX;
            if (ndcY < minY) minY = ndcY;
            if (winZ < minZ) minZ = winZ;
            if (ndcX > maxX) maxX = ndcX;
            if (ndcY > maxY) maxY = ndcY;
            if (winZ > maxZ) maxZ = winZ;
        }

        projMinX = minX;
        projMinY = minY;
        projMaxX = maxX;
        projMaxY = maxY;
        projMinZ = minZ;
        projMaxZ = maxZ;
        return AABB_IN;
    }

    function classifyAabbOrtho(m: Float32Array, mesh: IAabb) {

        const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3];
        const m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7];
        const m8 = m[8], m9 = m[9], m10 = m[10], m11 = m[11];
        const m12 = m[12], m13 = m[13], m14 = m[14], m15 = m[15];

        const cx = mesh.cx, cy = mesh.cy, cz = mesh.cz;
        const hx = mesh.hx, hy = mesh.hy, hz = mesh.hz;

        const ccx = m0 * cx + m4 * cy + m8 * cz + m12;
        const ccy = m1 * cx + m5 * cy + m9 * cz + m13;
        const ccz = m2 * cx + m6 * cy + m10 * cz + m14;
        const ccw = m3 * cx + m7 * cy + m11 * cz + m15;
        const xx = m0 * hx, xy = m1 * hx, xz = m2 * hx, xw = m3 * hx;
        const yx = m4 * hy, yy = m5 * hy, yz = m6 * hy, yw = m7 * hy;
        const zx = m8 * hz, zy = m9 * hz, zz = m10 * hz, zw = m11 * hz;

        const rXW = absf(xx + xw) + absf(yx + yw) + absf(zx + zw);
        if (ccx + ccw + rXW < 0) return AABB_OUT;

        const rWX = absf(xw - xx) + absf(yw - yx) + absf(zw - zx);
        if (ccw - ccx + rWX < 0) return AABB_OUT;

        const rYW = absf(xy + xw) + absf(yy + yw) + absf(zy + zw);
        if (ccy + ccw + rYW < 0) return AABB_OUT;

        const rWY = absf(xw - xy) + absf(yw - yy) + absf(zw - zy);
        if (ccw - ccy + rWY < 0) return AABB_OUT;

        const rZW = absf(xz + xw) + absf(yz + yw) + absf(zz + zw);
        if (ccz + ccw + rZW < NEAR_EPS) return AABB_OUT;

        if (ccw <= NEAR_EPS) {
            return AABB_NEAR;
        }

        const invW = 1 / ccw;
        const ex = absf(m0) * hx + absf(m4) * hy + absf(m8) * hz;
        const ey = absf(m1) * hx + absf(m5) * hy + absf(m9) * hz;
        const ez = absf(m2) * hx + absf(m6) * hy + absf(m10) * hz;

        projMinX = (ccx - ex) * invW;
        projMaxX = (ccx + ex) * invW;
        projMinY = (ccy - ey) * invW;
        projMaxY = (ccy + ey) * invW;
        projMinZ = (ccz - ez) * invW * 0.5 + 0.5;
        projMaxZ = (ccz + ez) * invW * 0.5 + 0.5;

        return AABB_IN;
    }

    function isPerspectiveMatrix(m: Float32Array) {
        return absf(m[3]) > ORTHO_EPS || absf(m[7]) > ORTHO_EPS || absf(m[11]) > ORTHO_EPS;
    }

    function absf(v: number) {
        return v < 0 ? -v : v;
    }

    function mulMat4(out: Float32Array, a: Float32Array, b: Float32Array, bOff: number) {

        const a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3];
        const a4 = a[4], a5 = a[5], a6 = a[6], a7 = a[7];
        const a8 = a[8], a9 = a[9], a10 = a[10], a11 = a[11];
        const a12 = a[12], a13 = a[13], a14 = a[14], a15 = a[15];

        const b0 = b[bOff], b1 = b[bOff + 1], b2 = b[bOff + 2], b3 = b[bOff + 3];
        const b4 = b[bOff + 4], b5 = b[bOff + 5], b6 = b[bOff + 6], b7 = b[bOff + 7];
        const b8 = b[bOff + 8], b9 = b[bOff + 9], b10 = b[bOff + 10], b11 = b[bOff + 11];
        const b12 = b[bOff + 12], b13 = b[bOff + 13], b14 = b[bOff + 14], b15 = b[bOff + 15];

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

    function toUs(ms: number) {
        return (ms * 1000 + 0.5) | 0;
    }

    function buildBoxMesh(): IPrimMesh {
        return primMesh(
            [
                -0.5, -0.5, -0.5,
                 0.5, -0.5, -0.5,
                 0.5,  0.5, -0.5,
                -0.5,  0.5, -0.5,
                -0.5, -0.5,  0.5,
                 0.5, -0.5,  0.5,
                 0.5,  0.5,  0.5,
                -0.5,  0.5,  0.5
            ],
            [
                0, 2, 1, 0, 3, 2,
                4, 5, 6, 4, 6, 7,
                0, 1, 5, 0, 5, 4,
                3, 7, 6, 3, 6, 2,
                0, 4, 7, 0, 7, 3,
                1, 2, 6, 1, 6, 5
            ]
        );
    }

    function buildPlaneMesh(): IPrimMesh {
        return primMesh(
            [
                -0.5, -0.5, 0,
                 0.5, -0.5, 0,
                 0.5,  0.5, 0,
                -0.5,  0.5, 0
            ],
            [0, 1, 2, 0, 2, 3]
        );
    }

    function buildCylinderMesh(segments: number): IPrimMesh {
        const verts: number[] = [];
        const indices: number[] = [];
        const y0 = -0.5;
        const y1 = 0.5;
        const r = 0.5;
        for (let i = 0; i < segments; i++) {
            const a = (i / segments) * Math.PI * 2;
            const x = Math.cos(a) * r;
            const z = Math.sin(a) * r;
            verts.push(x, y0, z, x, y1, z);
        }
        const bot = segments << 1;
        const top = bot + 1;
        verts.push(0, y0, 0, 0, y1, 0);
        for (let i = 0; i < segments; i++) {
            const j = i + 1 === segments ? 0 : i + 1;
            const i0 = i << 1;
            const i1 = i0 + 1;
            const j0 = j << 1;
            const j1 = j0 + 1;
            indices.push(i0, j1, j0, i0, i1, j1, top, j1, i1, bot, i0, j0);
        }
        return primMesh(verts, indices);
    }

    function buildConeMesh(segments: number): IPrimMesh {
        const verts: number[] = [];
        const indices: number[] = [];
        const y0 = -0.5;
        const y1 = 0.5;
        const r = 0.5;
        for (let i = 0; i < segments; i++) {
            const a = (i / segments) * Math.PI * 2;
            verts.push(Math.cos(a) * r, y0, Math.sin(a) * r);
        }
        const apex = segments;
        const bot = segments + 1;
        verts.push(0, y1, 0, 0, y0, 0);
        for (let i = 0; i < segments; i++) {
            const j = i + 1 === segments ? 0 : i + 1;
            indices.push(i, apex, j, bot, i, j);
        }
        return primMesh(verts, indices);
    }

    function buildIcosahedronMesh(): IPrimMesh {
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
        return primMesh(verts, [
            0, 8, 4,  0, 2, 8,  0, 9, 2,  0, 5, 9,  0, 4, 5,
            1, 4, 10, 1, 5, 4,  1, 11, 5, 1, 3, 11, 1, 10, 3,
            2, 6, 8,  2, 7, 6,  2, 9, 7,
            3, 7, 11, 3, 6, 7,  3, 10, 6,
            4, 8, 10, 5, 11, 9, 6, 10, 8, 7, 9, 11
        ]);
    }

    function boundsFromVertices(vertices: ArrayLike<number>) {
        let minX = 0, minY = 0, minZ = 0, maxX = 0, maxY = 0, maxZ = 0;
        if (vertices.length >= 3) {
            minX = maxX = vertices[0];
            minY = maxY = vertices[1];
            minZ = maxZ = vertices[2];
            for (let i = 3; i < vertices.length; i += 3) {
                const x = vertices[i];
                const y = vertices[i + 1];
                const z = vertices[i + 2];
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (z < minZ) minZ = z;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
                if (z > maxZ) maxZ = z;
            }
        }
        return {
            cx: (minX + maxX) * 0.5,
            cy: (minY + maxY) * 0.5,
            cz: (minZ + maxZ) * 0.5,
            hx: (maxX - minX) * 0.5,
            hy: (maxY - minY) * 0.5,
            hz: (maxZ - minZ) * 0.5
        };
    }

    function primMesh(verts: number[], indices: number[]): IPrimMesh {
        const vertices = new Float32Array(verts);
        const aabb = boundsFromVertices(vertices);
        const indexArray = new Uint32Array(indices);
        return {
            vertices,
            indices: indexArray,
            edgeIndices: buildUniqueEdges(indexArray),
            vertexCount: (verts.length / 3) | 0,
            indexCount: indices.length,
            cx: aabb.cx,
            cy: aabb.cy,
            cz: aabb.cz,
            hx: aabb.hx,
            hy: aabb.hy,
            hz: aabb.hz
        };
    }

    function buildUniqueEdges(indices: Uint32Array): Uint32Array {
        const n = indices.length;
        const seen = new Set<number>();
        const edges: number[] = [];
        for (let t = 0; t + 2 < n; t += 3) {
            addEdge(indices[t], indices[t + 1]);
            addEdge(indices[t + 1], indices[t + 2]);
            addEdge(indices[t + 2], indices[t]);
        }
        return new Uint32Array(edges);

        function addEdge(a: number, b: number) {
            const min = a < b ? a : b;
            const max = a < b ? b : a;
            const key = min * 0x100000 + max;
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            edges.push(min, max);
        }
    }
}

export function spawnSoftwareOcclusionWorker(): { worker: Worker; url: string } {
    const url = URL.createObjectURL(new Blob(
        [`"use strict";(${softwareOcclusionWorkerMain.toString()})();`],
        { type: "application/javascript" }
    ));
    return { worker: new Worker(url), url };
}
