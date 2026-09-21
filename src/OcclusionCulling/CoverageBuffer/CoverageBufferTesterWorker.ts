import pc from "../../engine.js";
import { writeCameraParams } from "../../Extras/CameraHelpers.js";
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
import { CoverageAABBStore } from "./CoverageAABBStore.js";
import { CoverageBusApi, type ICoverageBusViews, type ICoverageOutputViews } from "./CoverageBufferBus.js";
import { CoverageCpuBufferViewer } from "./CoverageCpuBufferViewer.js";
import type { ICoverageBuffer } from "./ICoverageBuffer.js";
import { spawnCoverageBufferWorker } from "./CoverageBufferWorker.js";
import type {
    ICoverageBufferFrameMessage,
    TCoverageBufferMessage
} from "./CoverageBufferWorkerMessages.js";

/**
 * JS worker coverage tester. Owns the AABB pool, one transferable job bus, and a
 * two-slot ping-pong output ring (reprojected + flags). Last results stay in the
 * published slot while the write slot is with {@link coverageBufferWorkerMain}.
 * `CoverageCpuBuffer` runs only inside the worker — never on this thread.
 */
export class CoverageBufferTesterWorker implements IGPU2CPUReadbackOcclusionCullingTester {

    public static readonly DEFAULT_AABB_CAPACITY = 4096;

    readonly _ocTesterType = "gpu2cpu_readback_oct" as const;

    private _coverage: ICoverageBuffer;
    private _aabbStore: CoverageAABBStore;
    private _viewProjection = new pc.Mat4();
    private _view = new pc.Mat4();
    private _cameraParams = new Float32Array(4);
    private _appliedVersion = -1;

    private _bus: ICoverageBusViews | null = null;
    private _writeOut: ICoverageOutputViews | null = null;
    private _publishedOut: ICoverageOutputViews | null = null;
    private _dirtyAabbIds = new Set<number>();
    private _aabbFullNeeded = true;
    private _busWidth = 0;
    private _busHeight = 0;
    private _busCapacity = 0;

    private _cpuViewer = new CoverageCpuBufferViewer();
    private _queue: IndexQueueEx;
    private _worker: Worker | null = null;
    private _workerUrl: string | null = null;
    private _ready = false;
    private _transfer: Transferable[] = [];

    /**
     * World AABB inflate as a fraction of camera-to-box distance.
     * Written into the bus before each worker job.
     */
    public aabbExpand = 0;

    /**
     * Extra coverage pixels around the projected rect.
     * Written into the bus before each worker job.
     */
    public rectPadPixels = 0;

    public get coverage() { return this._coverage; }
    public set coverage(v: ICoverageBuffer) {
        this._coverage = v;
        this._coverage.cpuReadback = true;
        this._appliedVersion = -1;
        this._growIfNeeded();
    }

    public get cpuViewer(): CoverageCpuBufferViewer { return this._cpuViewer; }
    public get capacity() { return this._aabbStore.capacity; }
    public get aabbStore() { return this._aabbStore; }

    public constructor(coverage: ICoverageBuffer, aabbCapacity: number = CoverageBufferTesterWorker.DEFAULT_AABB_CAPACITY) {
        this._coverage = coverage;
        this._coverage.cpuReadback = true;
        this._aabbStore = new CoverageAABBStore(Math.max(1, aabbCapacity | 0));
        this._busCapacity = this._aabbStore.capacity;
        this._queue = new IndexQueueEx(this._aabbStore.indexManager, 0);
        this._ensureBus(coverage.cpuWidth, coverage.cpuHeight, this._busCapacity, true);
        this._publishedOut = CoverageBusApi.allocOutput(this._busWidth, this._busHeight, this._busCapacity);
        this._writeOut = CoverageBusApi.allocOutput(this._busWidth, this._busHeight, this._busCapacity);
        this._startWorker();
    }

    public lock(boundingBox: pc.BoundingBox, matrix?: pc.Mat4, extra1: number = 0, extra2: number = 0): TUnicalId {
        const id = this._aabbStore.lock(boundingBox, matrix, extra1, extra2);
        this._dirtyAabbIds.add(id);
        return id;
    }

    public lockMinMaxScalars(data: ArrayLike<number>, offset: number, matrix?: pc.Mat4, extra1?: number, extra2?: number): TUnicalId {
        const id = this._aabbStore.lockMinMaxScalars(data, offset, matrix, extra1, extra2);
        this._dirtyAabbIds.add(id);
        return id;
    }

    public unlock(id: TUnicalId): void {
        this._aabbStore.unlock(id);
        this._dirtyAabbIds.delete(id);
    }

    public enqueueAabbUpdate(id: TUnicalId, boundingBox: pc.BoundingBox, matrix?: pc.Mat4, extra1: number = 0, extra2: number = 0) {
        this._aabbStore.enqueueUpdate(id, boundingBox, matrix, extra1, extra2);
        this._dirtyAabbIds.add(id);
    }

    public enqueue(id: TUnicalId, _extra?: number | number[]): TUnicalQueueIndex {
        if (this._queue.count < this._queue.capacity) {
            return this._queue.enqueue(id);
        }
        return SOME_ENQUEUE_PROBLEM;
    }

    public getOcclusionStatus(id: TUnicalId): TOcclusionResult {
        const flags = this._publishedOut?.flags;
        const value = flags ? flags[id] : OCCLUSION_UNKNOWN;
        if (value === 1) { return OCCLUSION_OCCLUDED; }
        if (value === 0) { return OCCLUSION_VISIBLE; }
        return OCCLUSION_UNKNOWN;
    }

    public resize(newCapacity: number): void {
        this._aabbStore.resize(Math.max(1, newCapacity | 0));
        this._growIfNeeded();
    }

    public updateGPUDepthBuffer(camera: pc.Camera): void {
        if (this._coverage.enabled && !this._coverage.resizePending) {
            this._coverage.update(camera);
        }
    }

    public frameUpdate(dt: number): void {
        this._coverage.frameUpdate(dt);
    }

    public getDebugInfo(index: number) {
        this._aabbStore.get(index, _boundingBox);
        return getDebugInfo(this._coverage, this._viewProjection, _boundingBox);
    }

    public execute(camera: pc.Camera): void {

        this._growIfNeeded();
        this._viewProjection.mul2(camera.projectionMatrix, camera.viewMatrix);
        this._view.copy(camera.viewMatrix);

        writeCameraParams(this._cameraParams, camera);

        if (!this._coverage.enabled ||
            !this._coverage.cpuReady ||
            this._coverage.resizePending) {
            this._fillUnknown();
            this._queue.clear();
            return;
        }

        const bus = this._bus;
        const out = this._writeOut;
        const worker = this._worker;
        if (!worker || !this._ready || !bus || !out) {
            return;
        }

        const queueCount = this._queue.count;
        const header = bus.header;
        const newSource = this._coverage.cpuVersion !== this._appliedVersion;

        this._flushAabbToBus();

        if (newSource) {
            const src = this._coverage.cpuDepth;
            const n0 = bus.n0;
            if (src.length < n0) {
                return;
            }
            bus.srcDepth.set(src.subarray(0, n0));
            bus.srcVP.set(this._coverage.cpuViewProjection);
            bus.srcParams.set(this._coverage.cpuCameraParams);
            this._appliedVersion = this._coverage.cpuVersion;
        }

        bus.dstVP.set(this._viewProjection.data);
        bus.view.set(this._view.data);
        bus.dstParams.set(this._cameraParams);

        const camNode = camera.node as pc.GraphNode | undefined;
        const camPos = camNode ? camNode.getPosition() : _zero;
        const cam = bus.cam;

        cam[0] = camPos.x;
        cam[1] = camPos.y;
        cam[2] = camPos.z;

        bus.aabbExpand[0] = this.aabbExpand;

        header[3] = queueCount;
        header[4] = Math.max(0, this.rectPadPixels);
        bus.queue.set(this._queue.indexes.subarray(0, queueCount));

        const msg: ICoverageBufferFrameMessage = {
            t: "frame",
            bus: bus.buffer,
            out: out.buffer
        };

        const transfer = this._transfer;
        transfer.length = 0;
        transfer.push(bus.buffer, out.buffer);

        try {
            worker.postMessage(msg, transfer);
            this._bus = null;
            this._writeOut = null;
            this._queue.clear();
        }
        catch {
            this._bus = CoverageBusApi.wrap(bus.buffer);
            this._writeOut = CoverageBusApi.wrapOutput(out.buffer);
        }

        transfer.length = 0;
    }

    public destroy() {
        this._stopWorker();
        this._queue.clear();
        this._aabbStore.destroy();
        this._bus = null;
        this._writeOut = null;
        this._publishedOut = null;
        this._dirtyAabbIds.clear();
        this._cpuViewer.set(new Float32Array(0), 0, 0);
    }

    private _growIfNeeded(): void {
        const width = Math.max(1, this._coverage.cpuWidth | 0);
        const height = Math.max(1, this._coverage.cpuHeight | 0);
        const capacity = Math.max(1, this._aabbStore.capacity | 0);

        if (this._queue.capacity !== capacity) {
            this._queue.resizeIndexes();
        }

        if (this._writeOut) {
            this._writeOut = this._ensureOutput(this._writeOut, width, height, capacity);
        }

        if (!this._bus) {
            return;
        }

        if (width !== this._busWidth ||
            height !== this._busHeight ||
            capacity !== this._busCapacity) {
            this._ensureBus(width, height, capacity, false);
        }
    }

    private _ensureOutput(
        out: ICoverageOutputViews,
        width: number,
        height: number,
        capacity: number
    ): ICoverageOutputViews {
        const w = Math.max(1, width | 0);
        const h = Math.max(1, height | 0);
        const cap = Math.max(1, capacity | 0);
        if (out.width === w &&
            out.height === h &&
            out.capacity === cap) {
            return out;
        }
        return CoverageBusApi.allocOutput(w, h, cap);
    }

    private _ensureBus(width: number, height: number, capacity: number, forceFullAabb: boolean): void {

        const w = Math.max(1, width | 0);
        const h = Math.max(1, height | 0);
        const cap = Math.max(1, capacity | 0);

        const same =
            this._bus &&
            this._busWidth === w &&
            this._busHeight === h &&
            this._busCapacity === cap;

        if (same) {
            if (forceFullAabb) {
                this._aabbFullNeeded = true;
            }
            return;
        }

        this._bus = CoverageBusApi.alloc(w, h, cap);
        this._busWidth = w;
        this._busHeight = h;
        this._busCapacity = cap;
        this._aabbFullNeeded = true;
        this._appliedVersion = -1;
    }

    private _flushAabbToBus(): boolean {

        const bus = this._bus;
        if (!bus) {
            return false;
        }

        const store = this._aabbStore;
        const dirty = this._dirtyAabbIds;

        if (this._aabbFullNeeded) {
            CoverageBusApi.copyAabbFromStore(store.centersData, store.halfExtentsData, bus, null);
            this._aabbFullNeeded = false;
            dirty.clear();
            return true;
        }

        if (dirty.size === 0) {
            return true;
        }

        CoverageBusApi.copyAabbFromStore(store.centersData, store.halfExtentsData, bus, dirty);
        dirty.clear();
        return true;
    }

    private _fillUnknown(): void {
        this._publishedOut?.flags.fill(OCCLUSION_UNKNOWN);
    }

    private _attachResult(busBuffer: ArrayBuffer, outBuffer: ArrayBuffer) {
        const bus = CoverageBusApi.wrap(busBuffer);
        const incoming = CoverageBusApi.wrapOutput(outBuffer);

        this._bus = bus;
        this._writeOut = this._publishedOut;
        this._publishedOut = incoming;
        this._cpuViewer.farClip = bus.dstParams[1] || 1000;
        this._cpuViewer.set(incoming.reprojected, incoming.width, incoming.height);
        this._growIfNeeded();
    }

    private _startWorker() {
        if (typeof Worker === "undefined") {
            return;
        }

        const spawned = spawnCoverageBufferWorker();
        this._worker = spawned.worker;
        this._workerUrl = spawned.url;
        this._ready = false;

        this._worker.onmessage = (event: MessageEvent<TCoverageBufferMessage>) => {
            const msg = event.data;
            if (!msg || !this._worker) {
                return;
            }
            if (msg.t === "result") {
                this._attachResult(msg.bus, msg.out);
            }
            else if (msg.t === "ready") {
                this._ready = true;
            }
        };

        this._worker.onerror = () => {
            this._ready = false;
        };
    }

    private _stopWorker() {
        this._worker?.terminate();
        this._worker = null;
        this._ready = false;

        if (this._workerUrl) {
            URL.revokeObjectURL(this._workerUrl);
            this._workerUrl = null;
        }
    }
}

const _boundingBox = new pc.BoundingBox();
const _zero = { x: 0, y: 0, z: 0 };
