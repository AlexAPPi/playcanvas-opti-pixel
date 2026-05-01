import pc from "../../../engine";
import { IndexManager } from "../../../Extras/IndexManager";
import { IGPU2CPUReadbackOcclusionCullingTester, OCCLUSION_UNKNOWN, TOcclusionResult, TUnicalId } from "../../IOcclusionCullingTester";
import { WebgpuOcclusionBoxMesh } from "./WebgpuOcclusionBoxMesh";

export class WebgpuOcclusionQueriesTester implements IGPU2CPUReadbackOcclusionCullingTester {

    public readonly supportGCPUReadback = true;

    private _app: pc.AppBase;
    private _device: pc.WebgpuGraphicsDevice;
    private _mesh: WebgpuOcclusionBoxMesh;
    private _store: pc.BoundingBox[] = [];
    private _indexManager: IndexManager;

    constructor(app: pc.AppBase, capacity: number) {

        // @ts-ignore
        this._device = app.graphicsDevice;
        this._app = app;

        this._store = new Array(capacity);
        this._indexManager = new IndexManager(capacity);
        this._mesh = new WebgpuOcclusionBoxMesh(this._device);
    }

    public destroy() {
    }

    public frameUpdate() {
    }

    public getOcclusionStatus(id: TUnicalId): TOcclusionResult {
        return OCCLUSION_UNKNOWN;
    }

    public execute(camera: pc.Camera): void {
    }

    public enqueue(id: TUnicalId, extra?: number | number[]): void {
    }

    public resize(capacity: number) {
        this._store.length = capacity;
        this._indexManager.resize(capacity);
    }

    public lock(boundingBox: pc.BoundingBox, matrix?: pc.Mat4): number {

        const index = this._indexManager.reserve();
        const box = this._store[index] ?? new pc.BoundingBox();

        box.setFromTransformedAabb(boundingBox, matrix ?? pc.Mat4.IDENTITY);

        this._store[index] = box;
        return index;
    }

    public unlock(index: number): void {
        this._indexManager.free(index);
    }
}