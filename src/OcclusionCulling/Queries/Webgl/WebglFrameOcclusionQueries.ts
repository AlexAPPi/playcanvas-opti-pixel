import pc from "../../../engine.js";
import { OCCLUSION_ALGORITHM_TYPE, OCCLUSION_ALGORITHM_TYPE_CONSERVATIVE } from "../Types.js";
import { WebglOcclusionBoxMesh } from "./WebglOcclusionBoxMesh.js";
import { WebglQueryScope } from "./WebglQueryScope.js";

export class WebglFrameOcclusionQueries<TKey = number> {

    public readonly gl: WebGL2RenderingContext;
    public readonly frameId: number;
    public readonly boxMesh: WebglOcclusionBoxMesh;

    private _lastScope: WebglQueryScope | null;
    private _map: Map<TKey, WebglQueryScope>;
    private _processing: boolean;
    private _beginExecuteTime: number;
    private _endExecuteTime: number;
    private _finishTime: number;

    public get size() { return this._map.size; }

    public get beginExecuteTime() { return this._beginExecuteTime; }
    public get endExecuteTime() { return this._endExecuteTime; }
    public get finishTime() { return this._finishTime; }
    public get processing() { return this._processing; }

    public get time() {

        if (this._processing) {
            return -1;
        }

        return this._finishTime - this._beginExecuteTime;
    }

    public get queryTime() {
        return this._endExecuteTime - this._beginExecuteTime;
    }

    constructor(gl: WebGL2RenderingContext, frameId: number, boxMesh: WebglOcclusionBoxMesh) {

        this.gl = gl;
        this.frameId = frameId;
        this.boxMesh = boxMesh;

        this._lastScope = null;
        this._map = new Map();
        this._processing = false;
        this._beginExecuteTime = -1;
        this._endExecuteTime = -1;
        this._finishTime = -1;
    }

    public clear() {

        for (let [key, scope] of this._map) {

            if (scope.query) {
                this.gl.deleteQuery(scope.query);
            }

            scope.checking = false;
            scope.query = null;
        }

        this._lastScope = null;
        this._map.clear();
    }

    public destroy() {
        this.clear();
    }

    public get(key: TKey) {
        return this._map.get(key);
    }

    public add(key: TKey, box: pc.BoundingBox, algorithmType: OCCLUSION_ALGORITHM_TYPE = OCCLUSION_ALGORITHM_TYPE_CONSERVATIVE) {

        if (this._processing) {
            return -1;
        }

        const newScope = new WebglQueryScope(box, algorithmType);
        this._map.set(key, newScope);
        return key;
    }

    public execute(camera: pc.Camera) {
        
        if (this._processing) {
            return false;
        }
        
        this._beginExecuteTime = performance.now();
        this._processing = true;

        let i = 0;
        const last = this._map.size;

        this.boxMesh.begin(camera);

        for (let [, scope] of this._map) {

            i++;

            scope.query ??= this.gl.createQuery();
            scope.checking = true;

            this.boxMesh.makeQuery(scope, i === 1, i === last);

            if (scope.query) {
                this._lastScope = scope;
            }
            else {
                this._finishScope(scope, true);
            }
        }

        this.boxMesh.end();

        this._endExecuteTime = performance.now();

        return true;
    }

    public resultAwailable() {
        
        if (this._processing) {

            if (this._awaitLastScope()) {
                return false;
            }

            this._lastScope = null;
            this._processing = false;

            for (const [, scope] of this._map) {
                
                if (!this._testScope(scope)) {
                    
                    this._processing = true;
                }
            }

            if (!this._processing) {
                this._finishTime = performance.now();
            }
        }

        return !this._processing;
    }

    private _finishScope(scope: WebglQueryScope, visible: boolean) {

        this.gl.deleteQuery(scope.query);

        scope.visible = visible;
        scope.checking = false;
        scope.query = null;
    }

    private _awaitLastScope() {

        if (!this._lastScope ||
            !this._lastScope.checking ||
            !this._lastScope.query) {
            return false;
        }

        if (this.gl.getQueryParameter(this._lastScope.query, this.gl.QUERY_RESULT_AVAILABLE)) {

            return false;
        }

        return true;
    }

    private _testScope(scope: WebglQueryScope) {

        if (!scope.checking || !scope.query) {
            return true;
        }

        // We don't need check gl.QUERY_RESULT_AVAILABLE because last query result ready
        /*
        if (!this.gl.getQueryParameter(scope.query, this.gl.QUERY_RESULT_AVAILABLE)) {
            console.log("HM,HM,HM");
            return false;
        }
        */

        const visible = this.gl.getQueryParameter(scope.query, this.gl.QUERY_RESULT) > 0;
        this._finishScope(scope, visible);
        return true;
    }
}