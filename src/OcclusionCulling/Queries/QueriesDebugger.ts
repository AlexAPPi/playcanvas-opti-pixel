import pc from "../../engine.js";
import { OCCLUSION_OCCLUDED } from "../IOcclusionCullingTester.js";
import { WebglOcclusionQueriesTester } from "./Webgl/WebglOcclusionQueriesTester.js";

const _aabb = new pc.BoundingBox();

export class QueriesDebugger {

    private _app: pc.AppBase;
    private _wireRenderer: pc.WireRenderer;
    private _tester: WebglOcclusionQueriesTester;

    constructor(app: pc.AppBase, tester: WebglOcclusionQueriesTester) {
        this._app = app;
        this._wireRenderer = new pc.WireRenderer(app);
        this._wireRenderer.depthTest = false;
        this._tester = tester;
    }

    public debugItem(index: number) {

        if (!this._tester) {
            return;
        }

        this._tester.getBoundingBox(index, _aabb);

        const occlusionStatus = this._tester.getOcclusionStatus(index);

        _minPoint.copy(_aabb.center).sub(_aabb.halfExtents);
        _maxPoint.copy(_aabb.center).add(_aabb.halfExtents);

        this._wireRenderer.color.copy(occlusionStatus === OCCLUSION_OCCLUDED ? pc.Color.RED : pc.Color.GREEN);
        this._wireRenderer.boxMinMax(_minPoint, _maxPoint);
    }
}

const _minPoint = new pc.Vec3();
const _maxPoint = new pc.Vec3();
