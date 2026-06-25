import pc from "../../../engine.js";
import { IAABBStore } from "../../../Extras/IAABBStore.js";
import { IGPU2CPUReadbackOcclusionCullingTester, OCCLUSION_UNKNOWN, TOcclusionResult, TUnicalId } from "../../IOcclusionCullingTester.js";
import { OCCLUSION_ALGORITHM_TYPE, OCCLUSION_ALGORITHM_TYPE_CONSERVATIVE } from "../Types.js";
import { WebgpuOcclusionBoxMesh } from "./WebgpuOcclusionBoxMesh.js";

export class WebgpuOcclusionQueriesTester implements IGPU2CPUReadbackOcclusionCullingTester {

    readonly _ocTesterType = 'gpu2cpu_readback_oct';

    private _app: pc.AppBase;
    private _device: pc.WebgpuGraphicsDevice;
    private _mesh: WebgpuOcclusionBoxMesh;
    private _aabbStore: IAABBStore;
    private _algorithmType: OCCLUSION_ALGORITHM_TYPE;

    public freeze: boolean = false;

    constructor(app: pc.AppBase, aabbStore: IAABBStore, algoritmType: OCCLUSION_ALGORITHM_TYPE = OCCLUSION_ALGORITHM_TYPE_CONSERVATIVE) {

        // @ts-ignore
        this._device = app.graphicsDevice;
        this._app = app;
        this._mesh = new WebgpuOcclusionBoxMesh(this._device, aabbStore);
        this._aabbStore = aabbStore;
        this._algorithmType = algoritmType;
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

    public enqueue(id: TUnicalId, extra?: number | number[]): number {
        return -1;
    }

    public resize() {
    }

    public lock(boundingBox: pc.BoundingBox, matrix?: pc.Mat4, extra1: number = 0, extra2: number = 0): TUnicalId {
        return this._aabbStore.lock(boundingBox, matrix, extra1, extra2);
    }

    public unlock(id: TUnicalId): void {
        this._aabbStore.unlock(id);
    }
}