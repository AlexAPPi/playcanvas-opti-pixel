import pc from "../../engine.js";
import { IAABBStore } from "../../Extras/IAABBStore.js";
import { IndexQueueEx } from "../../Extras/IndexQueueEx.js";
import { getDebugInfo } from "../HZB/TesterDebugInfo.js";
import {
    OCCLUSION_OCCLUDED,
    OCCLUSION_UNKNOWN,
    OCCLUSION_VISIBLE,
    SOME_ENQUEUE_PROBLEM,
    type IGPU2CPUReadbackOcclusionCullingTester,
    type TOcclusionResult,
    type TUnicalId,
    type TUnicalQueueIndex
} from "../IOcclusionCullingTester.js";
import { writeCameraParams } from "../../Extras/CameraHelpers.js";
import { CoverageCpuBuffer } from "./CoverageCpuBuffer.js";
import { ICoverageBuffer } from "./ICoverageBuffer.js";

/**
 * GPU coverage depth → CPU AABB tester.
 *
 * {@link updateGPUDepthBuffer} downsamples scene depth (4-tap max, 256∶128 chain) and
 * packs the last level as view-space Z for GPU→CPU download. {@link frameUpdate} polls
 * finished readbacks. {@link execute} reprojects the last capture and tests queued AABBs
 * on the CPU. Results lag at least one GPU frame.
 *
 * Works with {@link WebglCoverageBuffer} (transform feedback + PBO) and
 * {@link WebgpuCoverageBuffer} (compute pack + mapAsync).
 */
export class CoverageBufferTester implements IGPU2CPUReadbackOcclusionCullingTester {

    readonly _ocTesterType = "gpu2cpu_readback_oct" as const;

    private _coverage: ICoverageBuffer;
    private _aabbStore: IAABBStore;
    private _queue: IndexQueueEx;
    private _cpuBuffer = new CoverageCpuBuffer();
    private _viewProjection = new pc.Mat4();
    private _view = new pc.Mat4();
    private _cameraParams = new Float32Array(4);
    private _resultFlags: Int8Array;
    private _appliedVersion = -1;

    public get coverage() { return this._coverage; }
    public set coverage(v: ICoverageBuffer) {
        this._coverage = v;
        this._coverage.cpuReadback = true;
        this._appliedVersion = -1;
        this._cpuBuffer.resize(v.cpuWidth, v.cpuHeight);
    }

    /** Packed CPU depth after reprojection into the camera used by the last `execute`. */
    public get cpuBuffer() { return this._cpuBuffer; }

    /**
     * World AABB inflate as a fraction of camera-to-box distance.
     * Default 0. Set to `0.02` for the old distance-scaled expand (hurts far culls).
     */
    public get aabbExpand() { return this._cpuBuffer.aabbExpand; }
    public set aabbExpand(v: number) { this._cpuBuffer.aabbExpand = v; }

    /**
     * Extra coverage pixels around the projected test rect.
     * Default 0. Raise if fast camera motion pops occluded far objects back to visible.
     */
    public get rectPadPixels() { return this._cpuBuffer.rectPadPixels; }
    public set rectPadPixels(v: number) { this._cpuBuffer.rectPadPixels = v; }

    public constructor(coverage: ICoverageBuffer, aabbStore: IAABBStore) {
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
     * packs the last level for readback. Call after opaque geometry has
     * written depth. Distinct from {@link frameUpdate} (harvest) and
     * {@link execute} (AABB tests).
     */
    public updateGPUDepthBuffer(camera: pc.Camera): void {
        if (this._coverage.enabled && !this._coverage.resizePending) {
            this._coverage.update(camera);
        }
    }

    /**
     * Increments the coverage frame id and harvests finished GPU→CPU downloads.
     * Call every frame (typically on `frameupdate`, or at the start of `update`).
     * Distinct from {@link execute}, which only tests queued AABBs.
     * @param dt - The time since the last frame.
     */
    public frameUpdate(dt: number): void {
        this._coverage.frameUpdate(dt);
    }

    /**
     * Reprojects the last harvested capture and tests the queue.
     * Does not poll readbacks — call {@link frameUpdate} every frame.
     * Does not build the downsample chain — call {@link updateGPUDepthBuffer} after opaque depth.
     */
    public execute(camera: pc.Camera) {

        this._growIfNeeded();
        this._aabbStore.update();

        if (!this._coverage.enabled || this._coverage.resizePending) {
            this._appliedVersion = -1;
            this._resultFlags.fill(OCCLUSION_UNKNOWN);
            this._queue.clear();
            return;
        }

        this._viewProjection.mul2(camera.projectionMatrix, camera.viewMatrix);
        this._view.copy(camera.viewMatrix);

        writeCameraParams(this._cameraParams, camera);

        if (!this._coverage.cpuReady) {
            this._appliedVersion = -1;
            this._resultFlags.fill(OCCLUSION_UNKNOWN);
            this._queue.clear();
            return;
        }

        this._cpuBuffer.resize(this._coverage.cpuWidth, this._coverage.cpuHeight);

        if (this._appliedVersion !== this._coverage.cpuVersion) {
            this._cpuBuffer.setSource(
                this._coverage.cpuDepth,
                this._coverage.cpuViewProjection,
                this._coverage.cpuCameraParams
            );
            this._appliedVersion = this._coverage.cpuVersion;
        }

        const node = camera.node as pc.GraphNode | undefined;

        let cameraX = 0;
        let cameraY = 0;
        let cameraZ = 0;

        if (node) {
            const d = node.getWorldTransform().data;
            cameraX = d[12];
            cameraY = d[13];
            cameraZ = d[14];
        }

        this._cpuBuffer.update(this._viewProjection.data, cameraX, cameraY, cameraZ, this._cameraParams);
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
            const old = this._resultFlags;
            const n = old.length < cap ? old.length : cap;
            for (let i = 0; i < n; i++) {
                next[i] = old[i];
            }
            this._resultFlags = next;
        }

        if (this._queue.capacity !== cap) {
            this._queue.resizeIndexes();
        }
    }

    private _testQueue() {

        const count = this._queue.count;
        const flags = this._resultFlags;

        if (count <= 0 || !this._cpuBuffer.valid) {
            flags.fill(OCCLUSION_UNKNOWN);
            return;
        }

        const ids = this._queue.indexes;
        const centers = this._aabbStore.centersData;
        const halves = this._aabbStore.halfExtentsData;
        const cap = flags.length;
        const vp = this._viewProjection.data;
        const view = this._view.data;
        const cpuBuffer = this._cpuBuffer;

        for (let i = 0; i < count; i++) {

            const id = ids[i];
            if (id < cap) {

                const base = id << 2;
                flags[id] = cpuBuffer.testAabb(
                    centers[base], centers[base + 1], centers[base + 2],
                    halves[base], halves[base + 1], halves[base + 2],
                    vp,
                    view
                );
            }
        }
    }
}

const _boundingBox = new pc.BoundingBox();
