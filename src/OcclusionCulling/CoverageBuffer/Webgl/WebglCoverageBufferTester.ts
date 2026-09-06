import pc from "../../../engine.js";
import { IAABBStore } from "../../../Extras/IAABBStore.js";
import { IndexQueueEx } from "../../../Extras/IndexQueueEx.js";
import { getDebugInfo } from "../../HZB/TesterDebugInfo.js";
import {
    OCCLUSION_OCCLUDED,
    OCCLUSION_UNKNOWN,
    OCCLUSION_VISIBLE,
    SOME_ENQUEUE_PROBLEM,
    type IGPU2CPUReadbackOcclusionCullingTester,
    type TOcclusionResult,
    type TUnicalId,
    type TUnicalQueueIndex
} from "../../IOcclusionCullingTester.js";
import { CoverageCpuBuffer } from "../CoverageCpuBuffer.js";
import { WebglCoverageBuffer } from "./WebglCoverageBuffer.js";

/**
 * GPU coverage depth → CPU AABB tester.
 *
 * {@link updateHZB} builds the downsample chain and submits readback (call after
 * opaque depth). {@link execute} polls async readback, reprojects the last finished
 * capture into the current camera, then tests the queued AABBs against the packed
 * CPU depth buffer in device Z. Results lag at least one GPU frame.
 */
export class WebglCoverageBufferTester implements IGPU2CPUReadbackOcclusionCullingTester {

    readonly _ocTesterType = "gpu2cpu_readback_oct" as const;

    private _coverage: WebglCoverageBuffer;
    private _aabbStore: IAABBStore;
    private _queue: IndexQueueEx;
    private _cpuBuffer = new CoverageCpuBuffer();
    private _viewProjection = new pc.Mat4();
    private _resultFlags: Int8Array;
    private _appliedVersion = -1;

    public get coverage() { return this._coverage; }
    public set coverage(v: WebglCoverageBuffer) {
        this._coverage = v;
    }

    /** Packed CPU depth after reprojection into the camera used by the last `execute`. */
    public get cpuBuffer() { return this._cpuBuffer; }

    public constructor(coverage: WebglCoverageBuffer, aabbStore: IAABBStore) {
        this._coverage = coverage;
        this._coverage.cpuReadback = true;
        this._aabbStore = aabbStore;
        this._queue = new IndexQueueEx(aabbStore.indexManager, 0);
        this._resultFlags = new Int8Array(aabbStore.capacity);
        this._resultFlags.fill(OCCLUSION_UNKNOWN);
        this._cpuBuffer.resize(coverage.cpuWidth, coverage.cpuHeight);
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
        if (this._queue.count < this._queue.capacity) {
            return this._queue.enqueue(id);
        }
        return SOME_ENQUEUE_PROBLEM;
    }

    public getOcclusionStatus(id: TUnicalId): TOcclusionResult {
        const value = this._resultFlags[id] as TOcclusionResult;
        if (value === OCCLUSION_OCCLUDED || value === OCCLUSION_VISIBLE) {
            return value;
        }
        return OCCLUSION_UNKNOWN;
    }

    public resize(): void {
        this._growIfNeeded();
        this._cpuBuffer.resize(this._coverage.cpuWidth, this._coverage.cpuHeight);
        this._appliedVersion = -1;
    }

    /**
     * Builds the coverage downsample chain from the camera depth buffer and
     * submits GPU→CPU readback. Call after opaque geometry has written depth.
     * Distinct from {@link execute}, which only tests the queued AABBs.
     */
    public updateHZB(camera: pc.Camera): void {
        if (this._coverage.enabled && !this._coverage.resizePending) {
            this._coverage.update(camera);
        }
    }

    /**
     * Polls finished readbacks, reprojects the last capture, and tests the queue.
     * Does not build the downsample chain — call {@link updateHZB} after opaque depth.
     */
    public execute(camera: pc.Camera) {

        this._growIfNeeded();
        this._aabbStore.update();
        this._coverage.frameUpdate();

        if (!this._coverage.enabled || this._coverage.resizePending) {
            this._resultFlags.fill(OCCLUSION_UNKNOWN);
            this._queue.clear();
            return;
        }

        this._viewProjection.mul2(camera.projectionMatrix, camera.viewMatrix);

        if (!this._coverage.cpuReady) {
            this._resultFlags.fill(OCCLUSION_UNKNOWN);
            this._queue.clear();
            return;
        }

        this._cpuBuffer.resize(this._coverage.cpuWidth, this._coverage.cpuHeight);

        if (this._appliedVersion !== this._coverage.cpuVersion) {
            this._cpuBuffer.setSource(this._coverage.cpuDepth, this._coverage.cpuViewProjection);
            this._appliedVersion = this._coverage.cpuVersion;
        }

        this._cpuBuffer.update(this._viewProjection.data);
        this._testQueue();
        this._queue.clear();
    }

    public getDebugInfo(index: number) {
        this._aabbStore.get(index, _boundingBox);
        return getDebugInfo(this._coverage, this._viewProjection, _boundingBox);
    }

    public destroy() {
        this._queue.clear();
    }

    private _growIfNeeded() {

        const cap = this._aabbStore.capacity;
        if (this._resultFlags.length !== cap) {
            const next = new Int8Array(cap);
            next.fill(OCCLUSION_UNKNOWN);
            next.set(this._resultFlags.subarray(0, Math.min(this._resultFlags.length, cap)));
            this._resultFlags = next;
        }

        if (this._queue.capacity !== cap) {
            this._queue.resizeIndexes();
        }
    }

    private _testQueue() {

        const count = this._queue.count;
        if (count <= 0 || !this._cpuBuffer.valid) {
            return;
        }

        const ids = this._queue.indexes;
        const centers = this._aabbStore.centersData;
        const halves = this._aabbStore.halfExtentsData;
        const flags = this._resultFlags;
        const cap = flags.length;
        const vp = this._viewProjection.data;
        const cpuBuffer = this._cpuBuffer;

        for (let i = 0; i < count; i++) {

            const id = ids[i];
            if (id >= cap) {
                continue;
            }

            const base = id << 2;
            flags[id] = cpuBuffer.testAabb(
                centers[base], centers[base + 1], centers[base + 2],
                halves[base], halves[base + 1], halves[base + 2],
                vp
            );
        }
    }
}

const _boundingBox = new pc.BoundingBox();
