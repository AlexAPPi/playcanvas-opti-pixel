// Default shader includes
import cullBoundingBoxVS from "./TesterShader/CullBoundingBox.glsl.js";
import getBoundingBoxVS from "./TesterShader/GetBoundingBox.glsl.js";
import getRectDepthVS from "./TesterShader/GetRectDepth.glsl.js";
import getDepthVS from "./TesterShader/GetDepth.glsl.js";
import getFlagsVS from "./TesterShader/GetFlags.glsl.js";
import mainVS from "./TesterShader/Main.glsl.js";
import pc from "../../../engine.js";
import { HZBTStateQueue } from "./HZBTStateQueue.js";
import { GPUAABBStore } from "../../../Extras/GPUAABBStore.js";
import { WebglHierarchicalZBuffer } from "./WebglHierarchicalZBuffer.js";
import { getDebugInfo } from "../TesterDebugInfo.js";
import type { IHierarchicalZBufferTester } from "../IHierarchicalZBufferTester.js";
import type { IGPU2CPUReadbackOcclusionCullingTester, TOcclusionResult, TUnicalId } from "../../IOcclusionCullingTester.js";
import { executeTransformFeedbackShader } from "../../../Extras/TransformFeedbackHelpers.js";

export class WebglHZBCPUFBTester implements IHierarchicalZBufferTester, IGPU2CPUReadbackOcclusionCullingTester {

    readonly _ocTesterType = "gpu2cpu_readback_oct";

    private _hzb: WebglHierarchicalZBuffer;
    private _shader: pc.Shader;
    private _hzbScope1: pc.ScopeId;
    private _hzbScope2: pc.ScopeId;
    private _hzbSizeScope: pc.ScopeId;
    private _screenSizeScope: pc.ScopeId;
    private _dataTextureScope: pc.ScopeId;
    private _pixelsSizePerInstanceScope: pc.ScopeId;
    private _matrixViewProjectionScope: pc.ScopeId;
    private _queue: HZBTStateQueue;
    private _aabbStore: GPUAABBStore;
    private _modelViewProjection = new pc.Mat4();

    public get hzb() { return this._hzb; }
    public set hzb(v: WebglHierarchicalZBuffer) {
        this._hzb = v;
        this._updateScopes();
        this._updateShader();
    }

    constructor(hzb: WebglHierarchicalZBuffer, capacity: number = 512) {
        this._hzb = hzb;
        this._aabbStore = new GPUAABBStore(hzb.device, capacity);
        this._queue = new HZBTStateQueue(hzb.device, this._aabbStore.indexManager);
        this._updateScopes();
        this._updateShader();
    }

    public lock(boundingBox: pc.BoundingBox, matrix?: pc.Mat4): TUnicalId {
        return this._aabbStore.lock(boundingBox, matrix);
    }

    public unlock(id: TUnicalId): void {
        this._aabbStore.unlock(id);
    }

    private _clearScopes() {
    }

    private _updateScopes() {

        this._clearScopes();
        this._hzbSizeScope = this._hzb.device.scope.resolve("uHZBSize");
        this._screenSizeScope = this._hzb.device.scope.resolve("uScreenSize");
        this._dataTextureScope = this._hzb.device.scope.resolve("uDataTexture");
        this._pixelsSizePerInstanceScope = this._hzb.device.scope.resolve("uPixelsSizePerInstance");
        this._matrixViewProjectionScope = this._hzb.device.scope.resolve("uMatrixViewProjection");

        this._hzbScope1 = this._hzb.device.scope.resolve("uHZB1");
        this._hzbScope2 = this._hzb.device.scope.resolve("uHZB2");
    }

    private _updateShader(
        customDefines?: Map<string, string>,
        customIncludes?: Map<string, string>
    ) {
        const vertexIncludes = new Map();
        const vertexDefines = new Map();
        const mipLevels = this.hzb.mipLevels;
        const minLevel = 0;
        const maxLevel = mipLevels - 1;

        if (!this.hzb.isColor()) {
            vertexDefines.set("READ_DEPTH", "");
        }
        else if (this.hzb.isFloat32()) {
            vertexDefines.set("DEPTH_IS_FLOAT", "");
        }

        vertexDefines.set("MIN_LEVEL", minLevel.toFixed(1));
        vertexDefines.set("MAX_LEVEL", maxLevel.toFixed(1));

        vertexIncludes.set("mainVS", mainVS);
        vertexIncludes.set("getFlagsVS", getFlagsVS);
        vertexIncludes.set("getDepthVS", getDepthVS);
        vertexIncludes.set("getRectDepthVS", getRectDepthVS);
        vertexIncludes.set("getBoundingBoxVS", getBoundingBoxVS);
        vertexIncludes.set("cullBoundingBoxVS", cullBoundingBoxVS);

        if (customDefines) {
            for (const def of customDefines) {
                vertexDefines.set(def[0], def[1]);
            }
        }

        if (customIncludes) {
            for (const inc of customIncludes) {
                vertexDefines.set(inc[0], inc[1]);
            }
        }

        this._shader?.destroy();
        this._shader = pc.ShaderUtils.createShader(this._hzb.device, {
            uniqueName: "HZB_OCCLUSION_SHADER",
            useTransformFeedback: true,
            vertexGLSL: `#include "mainVS"`,
            fragmentGLSL: "void main(void) { gl_FragColor = vec4(1.0); }",
            vertexDefines: vertexDefines,
            vertexIncludes: vertexIncludes,
            attributes: {
                aBoundingBoxIndex: pc.SEMANTIC_POSITION,
            }
        });

        const gl = (this._hzb.device as pc.WebglGraphicsDevice).gl;
        const glProgram = this._shader.impl.glProgram;

        gl.transformFeedbackVaryings(glProgram, ["out_flags"], gl.INTERLEAVED_ATTRIBS);
        gl.linkProgram(glProgram);
    }

    public setShaderProps(defines?: Map<string, string>, includes?: Map<string, string>) {
        this._updateShader(defines, includes);
    }

    public destroy() {
        this._clearScopes();
        this._shader?.destroy();
        this._queue?.destroy();
        this._aabbStore?.destroy();
    }

    public resize(count: number): void {
        this._aabbStore.resize(count);
        this._queue.resize();
    }

    public frameUpdate() {
        this._queue.frameUpdate();
    }

    public enqueue(index: number, extra?: number | number[] | undefined) {
        return this._queue.enqueue(index, extra);
    }

    private _internalTest(camera: pc.Camera) {

        const state = this._queue.next();
        const viewMatrix = camera.viewMatrix;
        const projectionMatrix = camera.projectionMatrix;

        this._modelViewProjection.mul2(projectionMatrix, viewMatrix);

        if (state && state.count > 0) {

            const count = state.count;

            _screenSizeArr[0] = this.hzb.screenWidth;
            _screenSizeArr[1] = this.hzb.screenHeight;

            _hzbSizeArr[0] = this.hzb.width;
            _hzbSizeArr[1] = this.hzb.height;

            this._pixelsSizePerInstanceScope.setValue(this._aabbStore.pixelsPerInstance);
            this._dataTextureScope.setValue(this._aabbStore.texture);
            this._screenSizeScope.setValue(_screenSizeArr);
            this._hzbSizeScope.setValue(_hzbSizeArr);

            // TODO: mobile android hzb mips slowed
            this._hzbScope1.setValue(this._hzb.texture);
            this._hzbScope2.setValue(this._hzb.texture2);

            this._matrixViewProjectionScope.setValue(this._modelViewProjection.data);

            state.indexQueue.update();

            executeTransformFeedbackShader(
                this._shader,
                count,
                state.indexQueue.buffer,
                state.outputBuffer
            );
        }

        return state;
    }

    public async execute(camera: pc.Camera) {

        if (this.hzb.enabled) {

            this._aabbStore.update();

            const state = this._internalTest(camera);

            if (state) {
                await state.read();
            }
        }
    }

    public getData(index: number): number {
        return this._queue.getData(index);
    }

    public getOcclusionStatus(index: number): TOcclusionResult {
        return this._queue.getOcclusionStatus(index);
    }

    public getDebugInfo(index: number) {
        this._aabbStore.get(index, _boundingBox);
        return getDebugInfo(this, this._modelViewProjection, _boundingBox);
    }
}

const _hzbSizeArr = new Float32Array(2);
const _screenSizeArr = new Float32Array(2);
const _boundingBox = new pc.BoundingBox();