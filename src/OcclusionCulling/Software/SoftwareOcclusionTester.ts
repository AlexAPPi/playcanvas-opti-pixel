import pc from "../../engine.js";
import { IAABBStore } from "../../Extras/IAABBStore.js";
import { IndexQueueEx } from "../../Extras/IndexQueueEx.js";
import {
    OCCLUSION_OCCLUDED,
    OCCLUSION_UNKNOWN,
    OCCLUSION_VISIBLE,
    SOME_ENQUEUE_PROBLEM,
    type ICPUSoftwareOcclusionCullingTester,
    type TOcclusionResult,
    type TUnicalId,
    type TUnicalQueueIndex
} from "../IOcclusionCullingTester.js";
import { DebugLineMesh } from "./DebugLineMesh.js";
import { OccluderStore, type IOccluderPendingBatch } from "./OccluderStore.js";
import { SO_FLAG_OCCLUDED, SO_FLAG_UNKNOWN } from "./SoftwareOcclusionConstants.js";
import { spawnSoftwareOcclusionWorker } from "./SoftwareOcclusionWorker.js";
import type {
    ISoftwareOcclusionAabbSyncPatch,
    ISoftwareOcclusionFrameMessage,
    ISoftwareOcclusionResultMessage,
    ISoftwareOcclusionResize,
    TSoftwareOcclusionMessage
} from "./SoftwareOcclusionMessages.js";

const EMPTY_U32 = new Uint32Array(0);
const nextPow2 = pc.math.nextPowerOfTwo;

/**
 * CPU software occlusion timings and counts from the last completed worker job.
 * Times are milliseconds. Worker phases are measured inside the worker.
 */
export interface ISoftwareOcclusionStats {
    clearMs: number;
    rasterMs: number;
    hizBuildMs: number;
    aabbTestMs: number;
    workerMs: number;
    snapshotMs: number;
    waitMs: number;
    occluderCount: number;
    aabbCount: number;
    occludedCount: number;
    visibleCount: number;
}

/**
 * Capacity hints for the worker-side occluder store.
 * `uniqueMeshes` / `vertexCount` / `indexCount` are retained for API
 * compatibility; geometry is stored per-mesh in the worker and no longer
 * packed into a shared scene buffer.
 *
 * `vertexCount` is the number of xyz vertices (not floats).
 */
export interface ISoftwareOcclusionPreallocate {
    occluders?: number;
    uniqueMeshes?: number;
    vertexCount?: number;
    indexCount?: number;
}

export interface ISoftwareOcclusionTesterParams {
    width?: number;
    height?: number;
    reserved?: ISoftwareOcclusionPreallocate;
    debugOccluders?: boolean;
}

export class SoftwareOcclusionTester implements ICPUSoftwareOcclusionCullingTester {

    readonly _ocTesterType = "cpu_software_oct" as const;

    private _aabbStore: IAABBStore;
    private _occluders: OccluderStore;
    private _queue: IndexQueueEx;
    private _viewProjection = new pc.Mat4();

    private _width: number;
    private _height: number;
    private _reservedVertices = 0;
    private _reservedIndices = 0;
    private _reservedMeshSlots = 1;
    private _ready = false;
    private _pending = false;
    private _hostCapacity = 0;

    private _worker: Worker | null = null;
    private _workerUrl: string | null = null;
    private _resultFlags: Uint32Array;
    private _inflightQueueIds: Uint32Array | null = null;
    private _inflightIdsScratch = new Uint32Array(0);
    private _vpScratch = new Float32Array(16);
    private _syncedAabbVersion = -1;
    private _dirtyAabbIds = new Set<number>();
    private _aabbCapacityDirty = true;
    private _lastWrittenIds = new Uint32Array(0);
    private _lastWrittenCount = 0;
    private _debugOccluders = false;
    private _debugDirty = false;
    private _debugRebuildRequested = false;
    private _debug = new DebugLineMesh();

    private _submitTime = 0;
    private _snapshotMs = 0;

    public readonly stats: ISoftwareOcclusionStats = {
        clearMs: 0,
        rasterMs: 0,
        hizBuildMs: 0,
        aabbTestMs: 0,
        workerMs: 0,
        snapshotMs: 0,
        waitMs: 0,
        occluderCount: 0,
        aabbCount: 0,
        occludedCount: 0,
        visibleCount: 0
    };

    public get occluders() { return this._occluders; }
    public get width() { return this._width; }
    public get height() { return this._height; }
    public get ready() { return this._ready; }
    public get results() { return this._resultFlags; }
    public get debugLines() { return this._debug.lines; }
    public get debugLineCount() { return this._debug.lineCount; }
    public get debugMesh() { return this._debug.mesh; }
    public get debugOccluders() { return this._debugOccluders; }
    public set debugOccluders(value: boolean) {
        const enabled = !!value;
        if (this._debugOccluders !== enabled) {
            this._debugOccluders = enabled;
            this._debugDirty = enabled;
            this._debugRebuildRequested = false;
            if (!enabled) {
                this._debug.destroy();
            }
        }
    }

    public get reserved(): Required<ISoftwareOcclusionPreallocate> {
        return {
            occluders: this._occluders.capacity,
            uniqueMeshes: this._reservedMeshSlots,
            vertexCount: (this._reservedVertices / 3) | 0,
            indexCount: this._reservedIndices
        };
    }

    public constructor(aabbStore: IAABBStore, params: ISoftwareOcclusionTesterParams = {}) {
        this._aabbStore = aabbStore;
        this._width = nextPow2(Math.max(1, params.width ?? 256));
        this._height = nextPow2(Math.max(1, params.height ?? 128));
        this._occluders = new OccluderStore(params.reserved?.occluders ?? 256);
        this._queue = new IndexQueueEx(aabbStore.indexManager, 0);
        this._resultFlags = new Uint32Array(aabbStore.capacity);
        this._hostCapacity = aabbStore.capacity;
        this._debugOccluders = !!params.debugOccluders;
        this._debugDirty = this._debugOccluders;
        this._startWorker();
        if (params.reserved) {
            this.preallocate(params.reserved);
        }
    }

    public destroy() {
        this._stopWorker();
        this._debug.destroy();
        this._inflightQueueIds = null;
        this._ready = false;
    }

    public resize() {
        this._growHostIfNeeded(true);
    }

    /**
     * Grows occluder capacity (and retained mesh/vertex hints). Does not shrink.
     * Worker capacity is updated on the next idle `execute` via a resize patch.
     */
    public preallocate(sizes: ISoftwareOcclusionPreallocate) {
        if (sizes.occluders != null && sizes.occluders > this._occluders.capacity) {
            this._occluders.resize(sizes.occluders);
        }
        if (sizes.uniqueMeshes != null) {
            this._reservedMeshSlots = Math.max(this._reservedMeshSlots, sizes.uniqueMeshes);
        }
        if (sizes.vertexCount != null) {
            this._reservedVertices = Math.max(this._reservedVertices, sizes.vertexCount * 3);
        }
        if (sizes.indexCount != null) {
            this._reservedIndices = Math.max(this._reservedIndices, sizes.indexCount);
        }
    }

    public lock(boundingBox: pc.BoundingBox, matrix?: pc.Mat4, extra1: number = 0, extra2: number = 0): TUnicalId {
        const id = this._aabbStore.lock(boundingBox, matrix, extra1, extra2);
        this._markAabbDirty(id);
        return id;
    }

    public lockMinMaxScalars(data: ArrayLike<number>, offset: number, matrix?: pc.Mat4, extra1?: number, extra2?: number): TUnicalId {
        const id = this._aabbStore.lockMinMaxScalars(data, offset, matrix, extra1, extra2);
        this._markAabbDirty(id);
        return id;
    }

    public unlock(id: TUnicalId): void {
        this._aabbStore.unlock(id);
        this._dirtyAabbIds.delete(id);
    }

    /**
     * Forwards AABB updates to the store and marks the id dirty for worker sync.
     * Prefer this over calling {@link IAABBStore.enqueueUpdate} directly so the
     * worker mirror stays incremental instead of a full resync.
     */
    public enqueueAabbUpdate(id: TUnicalId, boundingBox: pc.BoundingBox, matrix?: pc.Mat4, extra1: number = 0, extra2: number = 0) {
        this._aabbStore.enqueueUpdate(id, boundingBox, matrix, extra1, extra2);
        this._markAabbDirty(id);
    }

    public enqueue(id: TUnicalId, _extra?: number | number[]): TUnicalQueueIndex {
        if (this._queue.count < this._queue.capacity) {
            return this._queue.enqueue(id);
        }
        return SOME_ENQUEUE_PROBLEM;
    }

    public getOcclusionStatus(id: TUnicalId): TOcclusionResult {
        const value = this._resultFlags[id];
        if (value === SO_FLAG_OCCLUDED) return OCCLUSION_OCCLUDED;
        if (value === SO_FLAG_UNKNOWN) return OCCLUSION_UNKNOWN;
        return OCCLUSION_VISIBLE;
    }

    public frameUpdate(_dt?: number) {
    }

    public execute(camera: pc.Camera) {

        this._growHostIfNeeded(false);

        if (!this._ready ||
            this._pending) {
            return;
        }

        const queueCount = this._queue.count;
        this._viewProjection.mul2(camera.projectionMatrix, camera.viewMatrix);
        this._submit(queueCount);
        this._queue.clear();
    }

    private _markAabbDirty(id: number) {
        this._dirtyAabbIds.add(id);
    }

    private _submit(queueCount: number) {

        const worker = this._worker;
        if (!worker) {
            return;
        }

        const snapshotStart = performance.now();
        let inflightIds = EMPTY_U32;
        if (queueCount > 0) {
            if (this._inflightIdsScratch.length < queueCount) {
                this._inflightIdsScratch = new Uint32Array(nextPow2(queueCount));
            }
            inflightIds = this._inflightIdsScratch;
            inflightIds.set(this._queue.indexes.subarray(0, queueCount));
            inflightIds = inflightIds.subarray(0, queueCount);
        }

        this._vpScratch.set(this._viewProjection.data);

        const pending = this._occluders.drainPending();
        const geometryDirty = pending.meshUpserts.length > 0
            || pending.meshRemoves.length > 0
            || pending.occluderUpserts !== null
            || pending.occluderRemoves.length > 0;

        if (geometryDirty) {
            this._debugDirty = true;
        }

        const transfer: Transferable[] = [];
        const requestDebug = this._debugOccluders && this._debugDirty;
        this._debugRebuildRequested = requestDebug;
        const msg: ISoftwareOcclusionFrameMessage = {
            t: "frame",
            vp: this._vpScratch,
            queueIds: inflightIds,
            queueCount,
            debugOccluders: requestDebug || undefined
        };

        this._applyPendingToMessage(msg, pending, transfer);
        this._applyAabbSyncToMessage(msg, transfer);

        const submitted = performance.now();
        this._snapshotMs = submitted - snapshotStart;
        this._submitTime = submitted;
        this._inflightQueueIds = queueCount > 0 ? inflightIds : null;
        this._pending = true;

        if (transfer.length > 0) {
            worker.postMessage(msg, transfer);
        }
        else {
            worker.postMessage(msg);
        }
    }

    private _applyAabbSyncToMessage(msg: ISoftwareOcclusionAabbSyncPatch, transfer: Transferable[]) {

        const store = this._aabbStore;
        const cap = store.capacity;
        const version = store.version;

        if (this._aabbCapacityDirty) {
            const resize: ISoftwareOcclusionResize = msg.resize ?? {
                occluderCapacity: this._occluders.capacity,
                meshSlots: Math.max(this._occluders.meshSlotCount, 1)
            };
            resize.aabbCapacity = cap;
            msg.resize = resize;
            this._aabbCapacityDirty = false;
        }

        if (this._dirtyAabbIds.size === 0) {

            // External store updates (no dirty ids): full mirror resync.
            // Prefer tester.lock / enqueueAabbUpdate so sync stays incremental.
            if (this._syncedAabbVersion !== version) {

                const floats = cap << 2;
                const centers = new Float32Array(floats);
                const halfExtents = new Float32Array(floats);

                centers.set(store.centersData.subarray(0, floats));
                halfExtents.set(store.halfExtentsData.subarray(0, floats));

                msg.aabbFull = {
                    centers,
                    halfExtents
                };

                transfer.push(centers.buffer);
                transfer.push(halfExtents.buffer);

                this._syncedAabbVersion = version;
            }

            return;
        }

        const n = this._dirtyAabbIds.size;
        const ids = new Uint32Array(n);
        const centers = new Float32Array(n << 2);
        const halfExtents = new Float32Array(n << 2);

        const srcC = store.centersData;
        const srcH = store.halfExtentsData;

        let i = 0;

        for (const id of this._dirtyAabbIds) {

            ids[i] = id;

            const s = id << 2;
            const d = i << 2;

            for (let j = 0; j < 4; j++) {
                centers[d + j] = srcC[s + j];
                halfExtents[d + j] = srcH[s + j];
            }

            i++;
        }

        msg.aabbUpserts = { ids, centers, halfExtents };
        transfer.push(ids.buffer);
        transfer.push(centers.buffer);
        transfer.push(halfExtents.buffer);

        this._dirtyAabbIds.clear();
        this._syncedAabbVersion = version;
    }

    private _clearLastWrittenFlags() {
        const ids = this._lastWrittenIds;
        const flags = this._resultFlags;
        const n = this._lastWrittenCount;
        for (let i = 0; i < n; i++) {
            flags[ids[i]] = 0;
        }
    }

    private _saveLastWritten(ids: ArrayLike<number>, count: number) {
        if (this._lastWrittenIds.length < count) {
            this._lastWrittenIds = new Uint32Array(nextPow2(count));
        }
        const dst = this._lastWrittenIds;
        for (let i = 0; i < count; i++) {
            dst[i] = ids[i];
        }
        this._lastWrittenCount = count;
    }

    private _applyPendingToMessage(
        msg: ISoftwareOcclusionFrameMessage,
        pending: IOccluderPendingBatch,
        transfer: Transferable[]
    ) {
        if (pending.resize) {
            msg.resize = {
                ...pending.resize,
                aabbCapacity: this._aabbStore.capacity
            };
            this._aabbCapacityDirty = false;
        }
        if (pending.meshUpserts.length > 0) {
            msg.meshUpserts = pending.meshUpserts;
            for (let i = 0; i < pending.meshUpserts.length; i++) {
                const mesh = pending.meshUpserts[i];
                transfer.push(mesh.vertices.buffer);
                transfer.push(mesh.indices.buffer);
            }
        }
        if (pending.meshRemoves.length > 0) {
            msg.meshRemoves = pending.meshRemoves;
        }
        if (pending.occluderUpserts) {
            const batch = pending.occluderUpserts;
            msg.occluderUpserts = batch;
            transfer.push(batch.ids.buffer);
            transfer.push(batch.types.buffer);
            transfer.push(batch.matrices.buffer);
            transfer.push(batch.meshIds.buffer);
        }
        if (pending.occluderRemoves.length > 0) {
            msg.occluderRemoves = pending.occluderRemoves;
        }
    }

    private _growHostIfNeeded(force: boolean) {

        const cap = this._aabbStore.capacity;

        if (!force && cap === this._hostCapacity) {
            return;
        }

        if (cap !== this._hostCapacity) {
            this._aabbCapacityDirty = true;
            this._syncedAabbVersion = -1;
        }

        this._hostCapacity = cap;

        if (this._resultFlags.length !== cap) {
            this._resultFlags = new Uint32Array(cap);
        }

        if (this._queue.capacity !== cap) {
            this._queue.resizeIndexes();
        }
    }

    private _attachResult(job: ISoftwareOcclusionResultMessage) {

        this._growHostIfNeeded(false);

        const ids = this._inflightQueueIds;
        const flags = job.flags;
        const dst = this._resultFlags;

        if (ids && ids.length > 0 && flags) {
            this._clearLastWrittenFlags();
            const n = Math.min(ids.length, flags.length);
            for (let i = 0; i < n; i++) {
                dst[ids[i]] = flags[i];
            }
            this._saveLastWritten(ids, n);
        }

        this._inflightQueueIds = null;
        this._pending = false;

        if (this._debugRebuildRequested) {
            this._debugDirty = false;
            this._debugRebuildRequested = false;
            if (this._debugOccluders) {
                const lines = job.debugLines;
                const count = job.debugLineCount ?? (lines ? (lines.length / 6) | 0 : 0);
                this._debug.setLines(lines, count);
            }
        }

        const stats = this.stats;
        stats.clearMs = job.clearUs / 1000;
        stats.rasterMs = job.rasterUs / 1000;
        stats.hizBuildMs = job.hizUs / 1000;
        stats.aabbTestMs = job.aabbUs / 1000;
        stats.workerMs = job.totalUs / 1000;
        stats.snapshotMs = this._snapshotMs;
        stats.waitMs = this._submitTime ? performance.now() - this._submitTime : 0;
        stats.occluderCount = job.occluders;
        stats.aabbCount = job.aabbs;
        stats.occludedCount = job.occluded;
        stats.visibleCount = job.visible;
    }

    /**
     * Draws the last worker debug wireframe via Immediate (`app.drawMesh`).
     * The GPU mesh is rebuilt only when the worker sends new {@link debugLines}.
     */
    public debugDraw(app: pc.AppBase, color: pc.Color = pc.Color.YELLOW, depthTest: boolean = true) {
        if (this._debugOccluders) {
            this._debug.draw(app, color, depthTest);
        }
    }

    private _startWorker() {

        if (typeof Worker === "undefined") {
            return;
        }

        const spawned = spawnSoftwareOcclusionWorker();
        this._worker = spawned.worker;
        this._workerUrl = spawned.url;
        this._ready = false;
        this._pending = false;

        this._worker.onmessage = (event: MessageEvent<TSoftwareOcclusionMessage>) => {
            const msg = event.data;
            if (msg && this._worker) {
                if (msg.t === "result") {
                    this._attachResult(msg);
                }
                else if (msg.t === "ready") {
                    this._ready = true;
                }
            }
        };

        this._worker.onerror = () => {
            this._ready = false;
            this._pending = false;
            this._inflightQueueIds = null;
        };

        this._worker.postMessage({
            t: "init",
            width: this._width,
            height: this._height,
            occluderCapacity: this._occluders.capacity,
            meshSlots: Math.max(this._occluders.meshSlotCount, 1),
            aabbCapacity: this._aabbStore.capacity
        });
    }

    private _stopWorker() {

        this._worker?.terminate();
        this._worker = null;
        this._pending = false;
        this._inflightQueueIds = null;

        if (this._workerUrl) {
            URL.revokeObjectURL(this._workerUrl);
            this._workerUrl = null;
        }
    }
}
