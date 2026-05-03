import pc from "../engine.js";
import { IHierarchicalZBuffer } from "./HZB/IHierarchicalZBuffer.js";
import { WebglHZBCPUFBTester } from "./HZB/Webgl/WebglHZBCPUFBTester.js";
import { HierarchicalZBufferDebugger } from "./HZB/HierarchicalZBufferDebugger.js";
import { WebglHierarchicalZBuffer } from "./HZB/Webgl/WebglHierarchicalZBuffer.js";
import { WebgpuHierarchicalZBuffer } from "./HZB/Webgpu/WebgpuHierarchicalZBuffer.js";
import { WebglOcclusionQueriesTester } from "./Queries/Webgl/WebglOcclusionQueriesTester.js";
import { WebgpuOcclusionQueriesTester } from "./Queries/Webgpu/WebgpuOcclusionQueriesTester.js";
import { isGPU2CPUReadbackOcclusionCullingTester } from "./IOcclusionCullingTester.js";
import { WebgpuHZBTester } from "./HZB/Webgpu/WebgpuHZBTester.js";

export class OcclusionCullingSystem extends pc.EventHandler {

    public readonly app: pc.AppBase;

    public get camera() { return this._camera; };
    public set camera(value: pc.Camera | null) { this._camera = value; }

    private _camera: pc.Camera | null = null;
    private _active: boolean = false;
    private _capacity: number = 5000;
    private _hzb: WebglHierarchicalZBuffer | WebgpuHierarchicalZBuffer | null = null;
    private _hzbTester: WebglHZBCPUFBTester | WebgpuHZBTester | null = null;
    private _hzbDebugger: HierarchicalZBufferDebugger | null = null;
    private _queriesTester: WebglOcclusionQueriesTester | WebgpuOcclusionQueriesTester | null = null;
    private _queriesLayerName: string = "";

    private _onPostRenderLayerHandle: pc.EventHandle | null = null;
    private _onCanvasResizeHandle: pc.EventHandle | null = null;
    private _onFrameUpdateHandle: pc.EventHandle | null = null;
    private _onFrameEndHandle: pc.EventHandle | null = null;

    public get hzb(): IHierarchicalZBuffer | null { return this._hzb; }
    public get hzbTester() { return this._hzbTester; }
    public get hzbDebugger() { return this._hzbDebugger; }

    public get active(): boolean { return this._active; }
    public set active(value: boolean) { this._active = value; }

    public get queriesLayerName() { return this._queriesLayerName; }
    public set queriesLayerName(name: string) { this._queriesLayerName = name; }
    public get queriesTester() { return this._queriesTester; }

    public get capacity() { return this._capacity; }
    public set capacity(value: number) {
        this.resize(value);
    }

    constructor(app: pc.AppBase, capacity: number = 5000) {
        super();
        this.app = app;
        this._capacity = capacity;
        this._initHZB();
        this._initQueries();
        this._onHandles();
    }

    public destroy() {
        this._offHandles();
        this._hzb?.destroy();
        this._hzbTester?.destroy();
        this._hzbDebugger?.destroy();
        this._queriesTester?.destroy();
    }

    public resize(value: number) {
        this._capacity = value;
        this._hzbTester?.resize(value);
        this._queriesTester?.resize(value);
    }

    private _initHZB() {

        this._hzb = 
            this.app.graphicsDevice.isWebGL2 ? new WebglHierarchicalZBuffer(this.app.graphicsDevice as pc.WebglGraphicsDevice) :
            this.app.graphicsDevice.isWebGPU ? new WebgpuHierarchicalZBuffer(this.app.graphicsDevice as pc.WebgpuGraphicsDevice) : 
            null;

        if (this._hzb) {

            this._hzbTester =
                this._hzb instanceof WebglHierarchicalZBuffer ? new WebglHZBCPUFBTester(this._hzb, this._capacity) :
                this._hzb instanceof WebgpuHierarchicalZBuffer ? new WebgpuHZBTester(this._hzb, this._capacity) :
                null;

            this._hzbDebugger = new HierarchicalZBufferDebugger(this.app, this._hzbTester ?? this._hzb);
        }
    }

    private _resizeHZB() {

        if (this._hzb) {
            this._hzb?.resize();

            if (this._hzbTester) {
                this._hzbTester.hzb = this._hzb;
            }

            if (this._hzbDebugger) {
                this._hzbDebugger.hzbOrTester = this._hzbTester ?? this._hzb;
            }
        }
    }

    private _initQueries() {
        this._queriesTester =
            this.app.graphicsDevice.isWebGL2 ? new WebglOcclusionQueriesTester(this.app, this._capacity) :
            this.app.graphicsDevice.isWebGPU ? null : // TODO: webgpu now not supported
            null;
    }

    private _onFrameUpdate(ms: number) {
        this._hzbDebugger?.debug();
        if (this.active) {
            this._hzbTester?.frameUpdate();
            this._queriesTester?.frameUpdate();
        }
    }

    private _onFrameEnd() {

        if (this.active && this._camera) {

            if (this._hzb) {
                this._hzb.update(this._camera);
            }

            if (isGPU2CPUReadbackOcclusionCullingTester(this._hzbTester)) {
                this._hzbTester
                    .execute(this._camera)
                    .catch(console.error);
            }
        }
    }

    private _onResizeCanvas() {
        this._resizeHZB();
    }

    private _onPostRenderLayer(renderCameraComponent: pc.CameraComponent, layer: pc.Layer, transperent: boolean) {

        // Test after not transperent layer
        if (!transperent &&
            this._camera === renderCameraComponent.camera && 
            this._queriesLayerName === layer.name) {
            this._queriesTester?.execute(this._camera);
        }
    }

    private _offHandles() {
        this._onPostRenderLayerHandle?.off();
        this._onCanvasResizeHandle?.off();
        this._onFrameUpdateHandle?.off();
        this._onFrameEndHandle?.off();
        this._onPostRenderLayerHandle = null;
        this._onCanvasResizeHandle = null;
        this._onFrameUpdateHandle = null;
        this._onFrameEndHandle = null;
    }

    private _onHandles() {
        this._offHandles();
        this._onCanvasResizeHandle = this.app.graphicsDevice.on("resizecanvas", this._onResizeCanvas, this);
        this._onFrameUpdateHandle = this.app.on("frameupdate", this._onFrameUpdate, this);
        this._onFrameEndHandle = this.app.on("frameend", this._onFrameEnd, this);
        this._onPostRenderLayerHandle = this.app.scene.on(pc.EVENT_POSTRENDER_LAYER, this._onPostRenderLayer, this);
    }
}