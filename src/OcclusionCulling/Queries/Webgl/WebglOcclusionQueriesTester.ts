import pc from "../../../engine.js";
import { IndexManager } from "../../../Extras/IndexManager.js";
import { OCCLUSION_OCCLUDED, OCCLUSION_UNKNOWN, OCCLUSION_VISIBLE, TUnicalId, type IGPU2CPUReadbackOcclusionCullingTester, type TOcclusionResult } from "../../IOcclusionCullingTester.js";
import { OCCLUSION_ALGORITHM_TYPE, OCCLUSION_ALGORITHM_TYPE_CONSERVATIVE } from "../Types.js";
import { WebglFrameOcclusionQueries } from "./WebglFrameOcclusionQueries.js";
import { WebglOcclusionBoxMesh } from "./WebglOcclusionBoxMesh.js";

export class WebglOcclusionQueriesTester implements IGPU2CPUReadbackOcclusionCullingTester {

    readonly _ocTesterType = "gpu2cpu_readback_oct";

    private _app: pc.AppBase;
    private _device: pc.WebglGraphicsDevice;
    private _mesh: WebglOcclusionBoxMesh;
    private _queue: WebglFrameOcclusionQueries[] = [];
    private _tmpFrame: WebglFrameOcclusionQueries | null = null;
    private _finishFrame: WebglFrameOcclusionQueries | null = null;
    private _algorithmType: OCCLUSION_ALGORITHM_TYPE;
    private _store: pc.BoundingBox[] = [];
    private _indexManager: IndexManager;

    public get algoritmType() { return this._algorithmType; }
    public set algoritmType(value: OCCLUSION_ALGORITHM_TYPE) { this._algorithmType = value; }
    public get finishTime() { return this._finishFrame?.finishTime ?? -1; }
    public get capacity() { return this._store.length; }

    constructor(app: pc.AppBase, capacity: number, algoritmType: OCCLUSION_ALGORITHM_TYPE = OCCLUSION_ALGORITHM_TYPE_CONSERVATIVE) {

        // @ts-ignore
        this._device = app.graphicsDevice;
        this._app = app;
        this._algorithmType = algoritmType;

        this._store = new Array(capacity);
        this._indexManager = new IndexManager(capacity);
        this._mesh = new WebglOcclusionBoxMesh(this._device);
    }

    public resize(capacity: number) {
        this._store.length = capacity;
        this._indexManager.resize(capacity);
    }

    public frameUpdate() {

        if (this._tmpFrame) {
            console.warn('The test for the previous frame was not run, a reset was performed');
            this._tmpFrame.destroy();
            this._tmpFrame = null;
        }

        if (this._queue.length === 0) {
            this._finishFrame?.destroy();
            this._finishFrame = null;
        }
        else {

            // We check the results from new to old,
            // if newer results are ready, we ignore the old ones
            for (let i = this._queue.length - 1; i > -1; i--) {

                const frameState = this._queue[i];

                if (frameState.resultAwailable()) {

                    this._finishFrame?.destroy();
                    this._finishFrame = frameState;

                    // Skip test for prev frame queries
                    if (i > 0) {

                        for (let j = 0; j < i; j++) {
                            this._queue[j].destroy();
                        }

                        this._queue.splice(0, i);
                    }

                    break;
                }
            }
        }
    }

    public execute(camera: pc.Camera) {
        if (this._tmpFrame && this._tmpFrame.size > 0) {
            this._tmpFrame.execute(camera);
            this._queue.push(this._tmpFrame);
            this._tmpFrame = null; // free tmp
        }
    }

    public destroy() {

        this._finishFrame?.destroy();
        this._tmpFrame?.destroy();

        for (let i = 0; i < this._queue.length; i++) {
            this._queue[i]?.destroy();
        }

        this._queue.length = 0;
    }

    public lock(boundingBox: pc.BoundingBox, matrix?: pc.Mat4): TUnicalId {

        const index = this._indexManager.reserve();
        const box = this._store[index] ?? new pc.BoundingBox();

        if (matrix) {
            box.setFromTransformedAabb(boundingBox, matrix);
        }
        else {
            box.center.copy(boundingBox.center);
            box.halfExtents.copy(boundingBox.halfExtents);
        }

        this._store[index] = box;
        return index;
    }

    public unlock(index: TUnicalId): void {
        this._indexManager.free(index);
    }

    public enqueue(index: TUnicalId, algoritm: OCCLUSION_ALGORITHM_TYPE) {
        // Create new tmp frame for queue if not exists
        this._tmpFrame ??= new WebglFrameOcclusionQueries(this._device.gl, this._app.frame, this._mesh);
        return this._tmpFrame.add(index, this._store[index], algoritm ?? this._algorithmType);
    }

    public getOcclusionStatus(index: TUnicalId): TOcclusionResult {

        const scope = this._finishFrame?.get(index);

        if (!scope) {
            return OCCLUSION_UNKNOWN;
        }

        if (scope.visible) {
            return OCCLUSION_VISIBLE;
        }

        return OCCLUSION_OCCLUDED;
    }

    public getBoundingBox(index: TUnicalId) {
        return this._store[index];
    }
}