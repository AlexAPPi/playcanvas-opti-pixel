import getIndirectMetaCS from "./TesterShader/GetIndirectMeta.wgsl.js";
import cullBoundingBoxCS from "./TesterShader/CullBoundingBox.wgsl.js";
import getBoundingBoxCS from "./TesterShader/GetBoundingBox.wgsl.js";
import getRectDepthCS from "./TesterShader/GetRectDepth.wgsl.js";
import getDepthCS from "./TesterShader/GetDepth.wgsl.js";
import mainCS from "./TesterShader/Main.wgsl.js";
import pc from "../../../engine.js";
import { AABBDataTexture } from "../../../Extras/AABBDataTexture.js";
import { GPUIndexQueue } from "../../../Extras/GPUIndexQueue.js";
import { IndexManager } from "../../../Extras/IndexManager.js";
import { MetaDataTexture } from "../../../Extras/MetaDataTexture.js";
import { IGPUIndirectDrawOcclusionCullingTester, IPrimitive, TUnicalId, TUnicalQueueIndex } from "../../IOcclusionCullingTester";
import { IHierarchicalZBufferTester } from "../IHierarchicalZBufferTester";
import { getDebugInfo } from "../TesterDebugInfo.js";
import { WebgpuHierarchicalZBuffer } from "./WebgpuHierarchicalZBuffer";

export class WebgpuHZBTester implements IHierarchicalZBufferTester, IGPUIndirectDrawOcclusionCullingTester {

    readonly _ocTesterType = "gpu_indirect_draw_oct";

    public shaderDebugName: string  = "WebgpuHZBTesterShader";
    public computeDebugName: string = "WebgpuHZBTesterCompute";

    private _indexManager: IndexManager;
    private _aabbStore: AABBDataTexture;
    private _metaStore: MetaDataTexture;
    private _indirect: GPUIndexQueue;
    private _hzb: WebgpuHierarchicalZBuffer;
    private _computeShader: pc.Shader;
    private _compute: pc.Compute;
    private _modelViewProjection = new pc.Mat4();

    private _workgroupSizeX: number = 64;
    private _workgroupSizeY: number = 1;

    public get hzb() { return this._hzb; }
    public set hzb(v: WebgpuHierarchicalZBuffer) {
        this._hzb = v;
        this._updateShader();
    }

    constructor(hzb: WebgpuHierarchicalZBuffer, capacity: number = 512, extraSize: number = 2) {
        this._hzb = hzb;
        this._indexManager = new IndexManager(capacity, true);
        this._aabbStore = new AABBDataTexture(hzb.device, capacity);
        this._metaStore = new MetaDataTexture(hzb.device, capacity);

        // extra must be 2 + (slot, instanceCount, ...)
        this._indirect = new GPUIndexQueue(hzb.device, this._indexManager, false, Math.max(2, extraSize));
        this._updateShader();
    }

    public destroy() {
        this._clearScopes();
        this._computeShader?.destroy();
        this._compute?.destroy();
        this._aabbStore?.destroy();
        this._metaStore?.destroy();
        this._indirect?.destroy();
    }

    public resize(count: number): void {
        this._indexManager.resize(count);
        this._aabbStore.resize(count);
        this._metaStore.resize(count);
        this._indirect.resize();
    }

    public lock(boundingBox: pc.BoundingBox, matrix?: pc.Mat4): TUnicalId {
        const index = this._indexManager.reserve();
        this._aabbStore.enqueueAABBUpdate(index, boundingBox, matrix);
        return index;
    }

    public unlock(id: TUnicalId): void {
        this._indexManager.free(id);
    }

    private _clearScopes() {
    }

    private _updateShader(
        customDefines?: Map<string, string>,
        customIncludes?: Map<string, string>
    ) {
        this._computeShader?.destroy();
        this._compute?.destroy();

        const cdefines = new Map<string, string>();
        const cincludes = new Map<string, string>();
        const mipLevels = this.hzb.mipLevels;
        const minLevel = 0;
        const maxLevel = mipLevels - 1;

        if (this.hzb.isFloat32()) {
            cdefines.set("DEPTH_IS_FLOAT", "");
        }

        cdefines.set("{MIN_LEVEL}", minLevel.toFixed(1));
        cdefines.set("{MAX_LEVEL}", maxLevel.toFixed(1));
        cdefines.set('{WORKGROUP_SIZE_X}', this._workgroupSizeX.toFixed(0));
        cdefines.set('{WORKGROUP_SIZE_Y}', this._workgroupSizeY.toFixed(0));

        cincludes.set("mainCS", mainCS);
        cincludes.set("getDepthCS", getDepthCS);
        cincludes.set("getRectDepthCS", getRectDepthCS);
        cincludes.set("getBoundingBoxCS", getBoundingBoxCS);
        cincludes.set("cullBoundingBoxCS", cullBoundingBoxCS);
        cincludes.set("getIndirectMetaCS", getIndirectMetaCS);

        if (customDefines) {
            for (const def of customDefines) {
                cdefines.set(def[0], def[1]);
            }
        }

        const engineIncludes = pc.ShaderChunks.get(this._hzb.device, pc.SHADERLANGUAGE_WGSL);
        for (const inc of engineIncludes) {
            cincludes.set(inc[0], inc[1]);
        }

        if (customIncludes) {
            for (const inc of customIncludes) {
                cincludes.set(inc[0], inc[1]);
            }
        }

        this._computeShader = new pc.Shader(this._hzb.device, {
            name: this.shaderDebugName,
            shaderLanguage: pc.SHADERLANGUAGE_WGSL,
            cshader: `#include "mainCS"`,
            cdefines,
            cincludes,
            // @ts-ignore
            computeUniformBufferFormats: {
                ub: new pc.UniformBufferFormat(this._hzb.device, [
                    new pc.UniformFormat("boundingBoxPixelsSizePerInstance", pc.UNIFORMTYPE_UINT),
                    new pc.UniformFormat("metaDataPixelsSizePerInstance", pc.UNIFORMTYPE_UINT),
                    new pc.UniformFormat("viewProjection", pc.UNIFORMTYPE_MAT4),
                    new pc.UniformFormat("screenSize", pc.UNIFORMTYPE_VEC2),
                    new pc.UniformFormat("hzbSize", pc.UNIFORMTYPE_VEC2),
                    new pc.UniformFormat("count", pc.UNIFORMTYPE_UINT),
                ])
            },
            computeBindGroupFormat: new pc.BindGroupFormat(this._hzb.device, [
                new pc.BindUniformBufferFormat("ub", pc.SHADERSTAGE_COMPUTE),
                new pc.BindTextureFormat("hzb", pc.SHADERSTAGE_COMPUTE, pc.TEXTUREDIMENSION_2D, pc.SAMPLETYPE_UNFILTERABLE_FLOAT, true, 'hzbSampler'),
                new pc.BindTextureFormat("boundingBoxes", pc.SHADERSTAGE_COMPUTE, pc.TEXTUREDIMENSION_2D, pc.SAMPLETYPE_UNFILTERABLE_FLOAT, false, null),
                new pc.BindTextureFormat("indirectMetaData", pc.SHADERSTAGE_COMPUTE, pc.TEXTUREDIMENSION_2D, pc.SAMPLETYPE_UINT, false, null),
                new pc.BindStorageBufferFormat("indirectDrawQueueBuffer", pc.SHADERSTAGE_COMPUTE, true),
                new pc.BindStorageBufferFormat("indirectDrawBuffer", pc.SHADERSTAGE_COMPUTE)
            ])
        });

        this._compute = new pc.Compute(this._hzb.device, this._computeShader, this.computeDebugName);
    }

    public setShaderProps(defines?: Map<string, string>, includes?: Map<string, string>) {
        this._updateShader(defines, includes);
    }

    public frameUpdate(): void {
        this._indirect.clear();
    }

    public getDebugInfo(index: number) {
        this._aabbStore.get(index, _boundingBox);
        return getDebugInfo(this, this._modelViewProjection, _boundingBox);
    }

    public enqueue(id: TUnicalId, primitive: IPrimitive, slot: number, instanceCount: number, firstInstance: number = 0, extra?: number[]): TUnicalQueueIndex {
        this._metaStore.tryEnqueueMetaUpdate(id, primitive.count, primitive.base, primitive.baseVertex, firstInstance);
        return this._indirect.enqueue(id, extra ? [slot, instanceCount, ...extra] : [slot, instanceCount]);
    }

    public execute(camera: pc.Camera, updateParams: boolean = true) {

        const count = this._indirect.count;

        if (count > 0 && this.hzb.enabled) {

            this._aabbStore.update();
            this._metaStore.update();
            this._indirect.update();

            const groupX = Math.ceil(count / this._workgroupSizeX);
            const hzbTexture = this.hzb.texture!;

            if (updateParams) {
                const viewMatrix = camera.viewMatrix;
                const projectionMatrix = camera.projectionMatrix;
                this._modelViewProjection.mul2(projectionMatrix, viewMatrix);
            }

            _screenSizeArr[0] = this.hzb.screenWidth;
            _screenSizeArr[1] = this.hzb.screenHeight;

            _hzbSizeArr[0] = this.hzb.width;
            _hzbSizeArr[1] = this.hzb.height;

            this._compute.setParameter("indirectDrawBuffer", this.hzb.device.indirectDrawBuffer!);
            this._compute.setParameter("hzb", hzbTexture);
            this._compute.setParameter("indirectMetaData", this._metaStore.texture);
            this._compute.setParameter("boundingBoxes", this._aabbStore.texture);
            this._compute.setParameter("indirectDrawQueueBuffer", this._indirect.buffer);
            this._compute.setParameter("boundingBoxPixelsSizePerInstance", this._aabbStore.pixelsPerInstance);
            this._compute.setParameter("metaDataPixelsSizePerInstance", this._metaStore.pixelsPerInstance);
            this._compute.setParameter('viewProjection', this._modelViewProjection.data);
            this._compute.setParameter('screenSize', _screenSizeArr);
            this._compute.setParameter('hzbSize', _hzbSizeArr);
            this._compute.setParameter("count", count);
            this._compute.setupDispatch(groupX, 1, 1);

            this.hzb.device.computeDispatch([this._compute], "Test" + count);
        }
    }
}

const _hzbSizeArr = new Float32Array(2);
const _screenSizeArr = new Float32Array(2);
const _boundingBox = new pc.BoundingBox();