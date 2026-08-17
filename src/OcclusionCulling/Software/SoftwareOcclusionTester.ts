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
import { OccluderStore } from "./OccluderStore.js";
import {
    SO_FLAG_OCCLUDED,
    SO_FLAG_VISIBLE,
    SO_I32_QUEUE_COUNT,
    SO_I32_STAT_AABB,
    SO_I32_STAT_OCCLUDED,
    SO_I32_STAT_OCCLUDERS,
    SO_I32_STAT_VISIBLE,
    SO_I32_STATUS,
    SO_I32_TIME_AABB_US,
    SO_I32_TIME_CLEAR_US,
    SO_I32_TIME_HIZ_US,
    SO_I32_TIME_RASTER_US,
    SO_I32_TIME_TOTAL_US,
    SO_I32_WRITE_SLOT,
    SO_STATUS_DONE,
    SO_STATUS_EXIT,
    SO_STATUS_IDLE,
    SO_STATUS_WORK,
    SO_DEFAULT_MESH_VERTEX_CAPACITY,
    SO_DEFAULT_MESH_INDEX_CAPACITY
} from "./SoftwareOcclusionConstants.js";
import {
    canUseSharedArrayBuffer,
    createSoftwareOcclusionShared,
    type ISoftwareOcclusionShared,
    type ISoftwareOcclusionSharedSizes
} from "./SoftwareOcclusionLayout.js";
import { spawnSoftwareOcclusionWorker } from "./SoftwareOcclusionWorker.js";

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

export interface ISoftwareOcclusionTesterParams {
    width?: number;
    height?: number;
    occluderCapacity?: number;
    meshVertexCapacity?: number;
    meshIndexCapacity?: number;
}

interface ICopyRingSlot {
    queueIds: Uint32Array;
    flags: Uint32Array;
    vp: Float32Array;
}

interface IWorkerJobStats {
    clearUs: number;
    rasterUs: number;
    hizUs: number;
    aabbUs: number;
    totalUs: number;
    occluders: number;
    aabbs: number;
    occluded: number;
    visible: number;
}

export class SoftwareOcclusionTester implements ICPUSoftwareOcclusionCullingTester {

    readonly _ocTesterType = "cpu_software_oct" as const;

    private _aabbStore: IAABBStore;
    private _occluders: OccluderStore;
    private _queue: IndexQueueEx;
    private _viewProjection = new pc.Mat4();

    private _width: number;
    private _height: number;
    private _useShared: boolean;
    private _ready = false;
    private _pending = false;
    private _readSlot = 0;
    private _copySlots: ICopyRingSlot[] | null = null;

    private _worker: Worker | null = null;
    private _workerUrl: string | null = null;
    private _shared: ISoftwareOcclusionShared | null = null;

    private _submitTime = 0;
    private _snapshotMs = 0;
    private _syncedOccludersVersion = -1;
    private _syncedMeshVersion = -1;
    private _syncedAabbVersion = -1;
    readonly stats: ISoftwareOcclusionStats = {
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
    public get results() { return this._resultFlags(); }

    constructor(aabbStore: IAABBStore, params: ISoftwareOcclusionTesterParams = {}) {
        this._aabbStore = aabbStore;
        this._width = Math.max(1, params.width ?? 256);
        this._height = Math.max(1, params.height ?? 128);
        this._occluders = new OccluderStore(
            params.occluderCapacity ?? 256,
            params.meshVertexCapacity ?? SO_DEFAULT_MESH_VERTEX_CAPACITY,
            params.meshIndexCapacity ?? SO_DEFAULT_MESH_INDEX_CAPACITY
        );
        this._queue = new IndexQueueEx(aabbStore.indexManager, 0);
        this._useShared = canUseSharedArrayBuffer();
        this._startWorker();
    }

    public destroy() {
        this._stopWorker();
        this._shared = null;
        this._ready = false;
    }

    public resize() {
        this._queue.resizeIndexes();
        this._stopWorker();
        this._startWorker();
    }

    public lock(boundingBox: pc.BoundingBox, matrix?: pc.Mat4, extra1: number = 0, extra2: number = 0): TUnicalId {
        return this._aabbStore.lock(boundingBox, matrix, extra1, extra2);
    }

    public lockMinMaxScalars(data: ArrayLike<number>, offset: number, matrix?: pc.Mat4, extra1?: number, extra2?: number): TUnicalId {
        return this._aabbStore.lockMinMaxScalars(data, offset, matrix, extra1, extra2);
    }

    public unlock(id: TUnicalId): void {
        this._aabbStore.unlock(id);
    }

    public enqueue(id: TUnicalId, _extra?: number | number[]): TUnicalQueueIndex {
        if (this._queue.count >= this._aabbStore.capacity) {
            return SOME_ENQUEUE_PROBLEM;
        }
        return this._queue.enqueue(id);
    }

    public getOcclusionStatus(id: TUnicalId): TOcclusionResult {
        const value = this.results[id];
        if (value === SO_FLAG_OCCLUDED) {
            return OCCLUSION_OCCLUDED;
        }
        if (value === 0) {
            return OCCLUSION_UNKNOWN;
        }
        return OCCLUSION_VISIBLE;
    }

    public frameUpdate(_dt?: number) {
        this._consumeDone();
    }

    public execute(camera: pc.Camera) {
        this._viewProjection.mul2(camera.projectionMatrix, camera.viewMatrix);
        this._consumeDone();

        if (this._needsLargerShared() && !this._isBusy()) {
            this._stopWorker();
            this._startWorker();
        }

        if (!this._ready || this._isBusy() || this._queue.count === 0) {
            this._queue.clear();
            return;
        }

        if (this._occluders.count === 0) {
            this._markQueuedVisible();
            this._queue.clear();
            return;
        }

        this._submit();
        this._queue.clear();
    }

    private _resultFlags(): Uint32Array {
        if (this._useShared && this._shared) {
            return this._readSlot === 0 ? this._shared.flags0 : this._shared.flags1;
        }
        return this._copySlots![this._readSlot].flags;
    }

    private _needsLargerShared() {
        if (!this._useShared || !this._shared) {
            return false;
        }
        return this._occluders.types.length > this._shared.occluderTypes.length
            || this._occluders.matrices.length > this._shared.occluderMatrices.length
            || this._occluders.meshRanges.length > this._shared.occluderMeshRanges.length
            || this._occluders.meshVertices.length > this._shared.meshVertices.length
            || this._occluders.meshIndices.length > this._shared.meshIndices.length;
    }

    private _isBusy() {
        if (!this._useShared || !this._shared) {
            return this._pending;
        }
        return Atomics.load(this._shared.control, SO_I32_STATUS) === SO_STATUS_WORK;
    }

    private _consumeDone() {
        if (this._useShared && this._shared) {
            if (Atomics.load(this._shared.control, SO_I32_STATUS) === SO_STATUS_DONE) {
                this._readSlot = Atomics.load(this._shared.control, SO_I32_WRITE_SLOT);
                this._applySharedStats(this._shared.control);
                Atomics.store(this._shared.control, SO_I32_STATUS, SO_STATUS_IDLE);
            }
            return;
        }
    }

    private _markQueuedVisible() {
        const flags = this._resultFlags();
        flags.fill(0);
        const ids = this._queue.indexes;
        const count = this._queue.count;
        for (let i = 0; i < count; i++) {
            flags[ids[i]] = SO_FLAG_VISIBLE;
        }
    }

    private _submit() {
        const queueCount = this._queue.count;
        const snapshotStart = performance.now();

        this._syncOccluders();
        this._syncAabbs();

        if (this._useShared && this._shared) {
            this._submitShared(queueCount, snapshotStart);
            return;
        }

        this._submitCopy(queueCount, snapshotStart);
    }

    private _syncOccluders() {
        const version = this._occluders.version;
        const meshVersion = this._occluders.meshVersion;
        const occludersDirty = version !== this._syncedOccludersVersion;
        const meshesDirty = meshVersion !== this._syncedMeshVersion;
        if (!occludersDirty && !meshesDirty) {
            return;
        }

        this._syncedOccludersVersion = version;
        this._syncedMeshVersion = meshVersion;

        if (this._useShared && this._shared) {
            if (occludersDirty) {
                this._shared.occluderTypes.set(this._occluders.types);
                this._shared.occluderMatrices.set(this._occluders.matrices);
                this._shared.occluderMeshRanges.set(this._occluders.meshRanges);
            }
            if (meshesDirty) {
                const usedVerts = this._occluders.meshVertexCount;
                const usedIndices = this._occluders.meshIndexCount;
                this._shared.meshVertices.set(this._occluders.meshVertices.subarray(0, usedVerts));
                this._shared.meshIndices.set(this._occluders.meshIndices.subarray(0, usedIndices));
            }
            return;
        }

        if (meshesDirty) {
            const vertices = this._occluders.meshVertices.slice(0, this._occluders.meshVertexCount);
            const indices = this._occluders.meshIndices.slice(0, this._occluders.meshIndexCount);
            this._worker?.postMessage(
                { t: "occluder-meshes", vertices, indices },
                [vertices.buffer, indices.buffer]
            );
        }

        if (occludersDirty) {
            const types = this._occluders.types.slice();
            const matrices = this._occluders.matrices.slice();
            const meshRanges = this._occluders.meshRanges.slice();
            this._worker?.postMessage(
                { t: "occluders", types, matrices, meshRanges },
                [types.buffer, matrices.buffer, meshRanges.buffer]
            );
        }
    }

    private _syncAabbs() {
        const version = this._aabbStore.version;
        if (version === this._syncedAabbVersion) {
            return;
        }

        this._syncedAabbVersion = version;
        const aabbFloats = this._aabbStore.capacity * 4;

        if (this._useShared && this._shared) {
            this._shared.aabbCenters.set(this._aabbStore.centersData.subarray(0, aabbFloats));
            this._shared.aabbHalfExtents.set(this._aabbStore.halfExtentsData.subarray(0, aabbFloats));
            return;
        }

        const centers = this._aabbStore.centersData.slice(0, aabbFloats);
        const halfExtents = this._aabbStore.halfExtentsData.slice(0, aabbFloats);
        this._worker?.postMessage(
            { t: "aabbs", centers, halfExtents },
            [centers.buffer, halfExtents.buffer]
        );
    }

    private _applySharedStats(control: Int32Array) {
        this._applyStats({
            clearUs: Atomics.load(control, SO_I32_TIME_CLEAR_US),
            rasterUs: Atomics.load(control, SO_I32_TIME_RASTER_US),
            hizUs: Atomics.load(control, SO_I32_TIME_HIZ_US),
            aabbUs: Atomics.load(control, SO_I32_TIME_AABB_US),
            totalUs: Atomics.load(control, SO_I32_TIME_TOTAL_US),
            occluders: Atomics.load(control, SO_I32_STAT_OCCLUDERS),
            aabbs: Atomics.load(control, SO_I32_STAT_AABB),
            occluded: Atomics.load(control, SO_I32_STAT_OCCLUDED),
            visible: Atomics.load(control, SO_I32_STAT_VISIBLE)
        });
    }

    private _applyStats(job: IWorkerJobStats) {
        const dst = this.stats;
        dst.clearMs = job.clearUs / 1000;
        dst.rasterMs = job.rasterUs / 1000;
        dst.hizBuildMs = job.hizUs / 1000;
        dst.aabbTestMs = job.aabbUs / 1000;
        dst.workerMs = job.totalUs / 1000;
        dst.snapshotMs = this._snapshotMs;
        dst.waitMs = this._submitTime ? performance.now() - this._submitTime : 0;
        dst.occluderCount = job.occluders;
        dst.aabbCount = job.aabbs;
        dst.occludedCount = job.occluded;
        dst.visibleCount = job.visible;
    }

    private _submitShared(queueCount: number, snapshotStart: number) {
        const shared = this._shared!;
        shared.vp.set(this._viewProjection.data);
        copyIds(shared.queueIds, this._queue.indexes, queueCount);

        this._snapshotMs = performance.now() - snapshotStart;
        this._submitTime = performance.now();

        const writeSlot = 1 - this._readSlot;
        Atomics.store(shared.control, SO_I32_WRITE_SLOT, writeSlot);
        Atomics.store(shared.control, SO_I32_QUEUE_COUNT, queueCount);
        Atomics.store(shared.control, SO_I32_STATUS, SO_STATUS_WORK);
        Atomics.notify(shared.control, SO_I32_STATUS);
    }

    private _submitCopy(queueCount: number, snapshotStart: number) {
        const writeSlot = 1 - this._readSlot;
        const slot = this._copySlots![writeSlot];
        slot.vp.set(this._viewProjection.data);
        copyIds(slot.queueIds, this._queue.indexes, queueCount);

        this._snapshotMs = performance.now() - snapshotStart;
        this._submitTime = performance.now();
        this._pending = true;
        this._worker?.postMessage(
            {
                t: "job",
                slot: writeSlot,
                vp: slot.vp,
                queueIds: slot.queueIds,
                flags: slot.flags,
                queueCount
            },
            [slot.vp.buffer, slot.queueIds.buffer, slot.flags.buffer]
        );
    }

    private _allocCopyRing() {
        const capacity = this._aabbStore.capacity;
        this._copySlots = [
            { queueIds: new Uint32Array(capacity), flags: new Uint32Array(capacity), vp: new Float32Array(16) },
            { queueIds: new Uint32Array(capacity), flags: new Uint32Array(capacity), vp: new Float32Array(16) }
        ];
        this._readSlot = 0;
    }

    private _sharedSizes(): ISoftwareOcclusionSharedSizes {
        return {
            aabbCapacity: this._aabbStore.capacity,
            occluderTypesLength: this._occluders.types.length,
            occluderMatricesLength: this._occluders.matrices.length,
            occluderMeshRangesLength: this._occluders.meshRanges.length,
            meshVerticesLength: this._occluders.meshVertices.length,
            meshIndicesLength: this._occluders.meshIndices.length
        };
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
        this._syncedOccludersVersion = -1;
        this._syncedMeshVersion = -1;
        this._syncedAabbVersion = -1;

        this._worker.onmessage = (event: MessageEvent) => {
            const msg = event.data;
            if (!msg) {
                return;
            }
            if (msg.t === "ready") {
                this._ready = true;
                return;
            }
            if (msg.t === "result" && msg.flags) {
                const slot = this._copySlots![msg.slot];
                slot.flags = msg.flags;
                slot.queueIds = msg.queueIds;
                slot.vp = msg.vp;
                this._readSlot = msg.slot;
                this._pending = false;
                this._applyStats(msg);
            }
        };

        this._worker.onerror = () => {
            this._ready = false;
            this._pending = false;
            if (!this._useShared) {
                this._allocCopyRing();
            }
        };

        if (this._useShared) {
            const sizes = this._sharedSizes();
            this._shared = createSoftwareOcclusionShared(sizes);
            this._worker.postMessage({
                t: "init-sab",
                sab: this._shared.sab,
                offsets: this._shared.offsets,
                width: this._width,
                height: this._height,
                ...sizes
            });
            return;
        }

        this._shared = null;
        this._allocCopyRing();
        this._worker.postMessage({
            t: "init-copy",
            width: this._width,
            height: this._height
        });
    }

    private _stopWorker() {

        if (this._shared) {
            Atomics.store(this._shared.control, SO_I32_STATUS, SO_STATUS_EXIT);
            Atomics.notify(this._shared.control, SO_I32_STATUS);
        }

        this._worker?.terminate();
        this._worker = null;

        if (this._workerUrl) {
            URL.revokeObjectURL(this._workerUrl);
            this._workerUrl = null;
        }
    }
}

function copyIds(dst: Uint32Array, src: ArrayLike<number>, count: number) {
    for (let i = 0; i < count; i++) {
        dst[i] = src[i];
    }
}
