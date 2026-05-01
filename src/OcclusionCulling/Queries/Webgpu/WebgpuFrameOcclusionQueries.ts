import pc from "../../../engine";
import { OCCLUSION_ALGORITHM_TYPE, OCCLUSION_ALGORITHM_TYPE_CONSERVATIVE } from "../Types";
import { WebgpuOcclusionBoxMesh } from "./WebgpuOcclusionBoxMesh";
import { WebgpuQueryScope } from "./WebgpuQueryScope";

// TODO

export class WebgpuFrameOcclusionQueries<TKey = number> {

    public readonly device: pc.WebgpuGraphicsDevice;
    public readonly gpu: GPUDevice;
    public readonly frameId: number;
    public readonly boxMesh: WebgpuOcclusionBoxMesh;

    private _map: Map<TKey, WebgpuQueryScope>;
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

    constructor(device: pc.WebgpuGraphicsDevice, frameId: number, boxMesh: WebgpuOcclusionBoxMesh) {

        this.device = device;
        // @ts-ignore
        this.gpu = device.wgpu;
        this.frameId = frameId;
        this.boxMesh = boxMesh;

        this._map = new Map();
        this._processing = false;
        this._beginExecuteTime = -1;
        this._endExecuteTime = -1;
        this._finishTime = -1;
    }

    public clear() {
        this._map.clear();
    }

    public destroy() {
        this.clear();
    }

    public get(key: TKey) {
        return this._map.get(key);
    }
    
    public add(key: TKey, box: pc.BoundingBox) {

        if (this._processing) {
            return false;
        }

        const newScope = new WebgpuQueryScope(this._map.size, box);
        this._map.set(key, newScope);
        return true;
    }

    public execute(camera: pc.Camera) {
        
        if (this._processing) {
            return false;
        }
        
        this._beginExecuteTime = performance.now();
        this._processing = true;

        let i = 0;
        
        const occlusionQueryCount = this._map.size;
        const last = occlusionQueryCount;

        this.boxMesh.begin(camera);

        const passEncoder = this.device.passEncoder as GPURenderPassEncoder;
        const bufferSize = occlusionQueryCount * 8;
        const occlusionQuerySet = this.gpu.createQuerySet({ type: 'occlusion', count: occlusionQueryCount });
        const queryResolveBuffer = this.gpu.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
        });

        const readBuffer = this.gpu.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });

        for (let [, scope] of this._map) {

            i++;

            scope.checking = true;

            this.boxMesh.makeQuery(passEncoder, scope, i === 1, i === last);
        }

        this.boxMesh.end();

        this._endExecuteTime = performance.now();

        const commandEncoder = this.gpu.createCommandEncoder();

        commandEncoder.resolveQuerySet(occlusionQuerySet, 0, occlusionQueryCount, queryResolveBuffer, 0);
        commandEncoder.copyBufferToBuffer(queryResolveBuffer, 0, readBuffer, 0, bufferSize);

        

        return true;
    }

    public resultAwailable() {
        return this._processing;
    }
}