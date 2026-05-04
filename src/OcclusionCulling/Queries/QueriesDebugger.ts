import pc from "../../engine.js";
import { OCCLUSION_OCCLUDED } from "../IOcclusionCullingTester.js";
import { WebglOcclusionQueriesTester } from "./Webgl/WebglOcclusionQueriesTester.js";

export class QueriesDebugger {

    private _app: pc.AppBase;
    private _tester: WebglOcclusionQueriesTester;

    constructor(app: pc.AppBase, tester: WebglOcclusionQueriesTester) {
        this._app = app;
        this._tester = tester;
    }

    public debugItem(index: number) {

        if (!this._tester) {
            return;
        }

        const boundingBox = this._tester.getBoundingBox(index);
        const occlusionStatus = this._tester.getOcclusionStatus(index);

        _minPoint.copy(boundingBox.center).sub(boundingBox.halfExtents);
        _maxPoint.copy(boundingBox.center).add(boundingBox.halfExtents);

        if (boundingBox) {
            this._app.drawWireAlignedBox(_minPoint, _maxPoint, occlusionStatus === OCCLUSION_OCCLUDED ? pc.Color.RED : pc.Color.GREEN, false);
        }
    }
}

const _minPoint = new pc.Vec3();
const _maxPoint = new pc.Vec3();