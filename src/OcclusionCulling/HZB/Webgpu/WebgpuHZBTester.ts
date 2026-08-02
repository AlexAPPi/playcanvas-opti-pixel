import cullBoundingBoxCS from "./TesterShader/CullBoundingBox.wgsl.js";
import getBoundingBoxCS from "./TesterShader/GetBoundingBox.wgsl.js";
import getRectDepthCS from "./TesterShader/GetRectDepth.wgsl.js";
import getDepthCS from "./TesterShader/GetDepth.wgsl.js";
import mainCS from "./TesterShader/Main.wgsl.js";
import pc from "../../../engine.js";
import { IAABBStore } from "../../../Extras/IAABBStore.js";
import { GPUIndexQueue } from "../../../Extras/GPUIndexQueue.js";
import { IndirectDataBuffer } from "../../../Extras/IndirectDataBuffer.js";
import { IGPUIndirectDrawOcclusionCullingTester, IPrimitive, TUnicalId, TUnicalQueueIndex } from "../../IOcclusionCullingTester";
import { IHierarchicalZBufferTester } from "../IHierarchicalZBufferTester";
import { getDebugInfo } from "../TesterDebugInfo.js";
import { WebgpuHierarchicalZBuffer } from "./WebgpuHierarchicalZBuffer";

export class WebgpuHZBTester implements IHierarchicalZBufferTester, IGPUIndirectDrawOcclusionCullingTester {

    readonly _ocTesterType = "gpu_indirect_draw_oct";

    public shaderDebugName: string  = "WebgpuHZBTesterShader";
    public computeDebugName: string = "WebgpuHZBTesterCompute";

    private _aabbStore: IAABBStore;
    private _indirectDataStore: IndirectDataBuffer;
    private _indirectQueue: GPUIndexQueue;
    private _hzb: WebgpuHierarchicalZBuffer;
    private _computeShader: pc.Shader;
    private _compute: pc.Compute;
    private _modelViewProjection = new pc.Mat4();
    private _cameraPosition = new pc.Vec3();

    private _workgroupSizeX: number = 64;

    public get hzb() { return this._hzb; }
    public set hzb(v: WebgpuHierarchicalZBuffer) {
        this._hzb = v;
        this._updateShader();
    }

    constructor(hzb: WebgpuHierarchicalZBuffer, aabbStore: IAABBStore, extraSize: number = 1) {
        this._hzb = hzb;
        this._aabbStore = aabbStore;
        this._indirectDataStore = new IndirectDataBuffer(hzb.device, aabbStore.capacity);

        // extra must be more 1 => (slot, ...)
        this._indirectQueue = new GPUIndexQueue(hzb.device, aabbStore.indexManager, false, Math.max(1, extraSize));
        this._updateShader();
    }

    public destroy() {
        this._clearScopes();
        this._computeShader?.destroy();
        this._compute?.destroy();
        this._indirectDataStore?.destroy();
        this._indirectQueue?.destroy();
    }

    public resize(): void {
        const capacity = this._aabbStore.capacity;
        this._indirectDataStore.resize(capacity);
        this._indirectQueue.resize();
    }

    public lock(boundingBox: pc.BoundingBox, matrix?: pc.Mat4, extra1: number = 0, extra2: number = 0): TUnicalId {
        return this._aabbStore.lock(boundingBox, matrix, extra1, extra2);
    }

    public lockMinMaxScalars(data: ArrayLike<number>, offset: number, matrix?: pc.Mat4, extra1?: number, extra2?: number): TUnicalId {
        return this._aabbStore.lockMinMaxScalars(data, offset, matrix, extra1, extra2);
    }

    public unlock(id: TUnicalId): void {
        this._aabbStore.unlock(id);
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

        if (this.hzb.isFloat16()) {
            cdefines.set("DEPTH_IS_FLOAT16", "");
            cdefines.set("{DEPTH_STORAGE_FORMAT}", "f16");
        }
        else {

            // For r32float or rgba8unorm,
            // store depth as float in shader for easier processing,
            // even if the actual storage format is uint.
            cdefines.set("{DEPTH_STORAGE_FORMAT}", "f32");

            if (this.hzb.isFloat32()) {
                cdefines.set("DEPTH_IS_FLOAT", "");
            }
        }

        cdefines.set("{MIN_LEVEL}", minLevel.toFixed(1));
        cdefines.set("{MAX_LEVEL}", maxLevel.toFixed(1));
        cdefines.set("{WORKGROUP_SIZE_X}", this._workgroupSizeX.toFixed(0));

        cincludes.set("mainCS", mainCS);
        cincludes.set("getDepthCS", getDepthCS);
        cincludes.set("getRectDepthCS", getRectDepthCS);
        cincludes.set("getBoundingBoxCS", getBoundingBoxCS);
        cincludes.set("cullBoundingBoxCS", cullBoundingBoxCS);

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
                    new pc.UniformFormat("nonIndexedSign", pc.UNIFORMTYPE_INT),
                    new pc.UniformFormat("cameraPosition", pc.UNIFORMTYPE_VEC3),
                    new pc.UniformFormat("viewProjection", pc.UNIFORMTYPE_MAT4),
                    new pc.UniformFormat("hzbUvFactor", pc.UNIFORMTYPE_VEC3),
                    new pc.UniformFormat("screenSize", pc.UNIFORMTYPE_VEC2),
                    new pc.UniformFormat("hzbSize", pc.UNIFORMTYPE_VEC2),
                    new pc.UniformFormat("count", pc.UNIFORMTYPE_UINT),
                ])
            },
            computeBindGroupFormat: new pc.BindGroupFormat(this._hzb.device, [
                new pc.BindUniformBufferFormat("ub", pc.SHADERSTAGE_COMPUTE),
                new pc.BindTextureFormat("hzb", pc.SHADERSTAGE_COMPUTE, pc.TEXTUREDIMENSION_2D, pc.SAMPLETYPE_UNFILTERABLE_FLOAT, true, "hzbSampler"),
                new pc.BindTextureFormat("boundingBoxCenters", pc.SHADERSTAGE_COMPUTE, pc.TEXTUREDIMENSION_2D, pc.SAMPLETYPE_UNFILTERABLE_FLOAT, false, null),
                new pc.BindTextureFormat("boundingBoxHalfExtents", pc.SHADERSTAGE_COMPUTE, pc.TEXTUREDIMENSION_2D, pc.SAMPLETYPE_UNFILTERABLE_FLOAT, false, null),
                new pc.BindStorageBufferFormat("indirectDataBuffer", pc.SHADERSTAGE_COMPUTE, true),
                new pc.BindStorageBufferFormat("indirectDrawQueueBuffer", pc.SHADERSTAGE_COMPUTE, true),
                new pc.BindStorageBufferFormat("indirectDrawBuffer", pc.SHADERSTAGE_COMPUTE)
            ])
        });

        this._compute = new pc.Compute(this._hzb.device, this._computeShader, this.computeDebugName);
    }

    public setShaderProps(defines?: Map<string, string>, includes?: Map<string, string>) {
        this._updateShader(defines, includes);
    }

    public frameUpdate(dt: number): void {
        this._indirectQueue.clear();
        this._indirectDataStore.reset();
    }

    public getDebugInfo(index: number) {
        this._aabbStore.get(index, _boundingBox);
        return getDebugInfo(this, this._modelViewProjection, _boundingBox);
    }

    public enqueue(id: TUnicalId, slot: number, primitive: IPrimitive, instanceCount: number, firstInstance: number = 0, extra?: number[]): TUnicalQueueIndex {
        this._indirectDataStore.tryEnqueueUpdate(id, primitive, instanceCount, firstInstance);
        return this._indirectQueue.enqueue(id, extra !== undefined ? [slot, ...extra] : slot);
    }

    public test(
        count: number,
        viewProjection: pc.Mat4,
        cameraPosition: pc.Vec3,
        aabbStore: IAABBStore,
        indirectDrawQueueBuffer: pc.VertexBuffer | pc.StorageBuffer,
        indirectDataBuffer: IndirectDataBuffer,
        indirectDrawBuffer: pc.StorageBuffer,
        debugName: string = "TestHZB"
    ) {

        if (count > 0 && this.hzb.enabled) {

            const groupX = Math.ceil(count / this._workgroupSizeX);
            const hzbTexture = this.hzb.texture!;
            const uvFactor = this.hzb.uvFactor;

            _hzbUvFactorArr[0] = uvFactor[0];
            _hzbUvFactorArr[1] = uvFactor[1];

            _screenSizeArr[0] = this.hzb.screenWidth;
            _screenSizeArr[1] = this.hzb.screenHeight;

            _hzbSizeArr[0] = this.hzb.width;
            _hzbSizeArr[1] = this.hzb.height;

            _cameraPosition[0] = cameraPosition.x;
            _cameraPosition[1] = cameraPosition.y;
            _cameraPosition[2] = cameraPosition.z;

            this._compute.setParameter("nonIndexedSign", indirectDataBuffer.nonIndexedSign);
            this._compute.setParameter("cameraPosition", _cameraPosition);
            this._compute.setParameter("indirectDrawBuffer", indirectDrawBuffer);
            this._compute.setParameter("hzb", hzbTexture);
            this._compute.setParameter("indirectDataBuffer", indirectDataBuffer.buffer);
            this._compute.setParameter("boundingBoxCenters", aabbStore.centersTexture);
            this._compute.setParameter("boundingBoxHalfExtents", aabbStore.halfExtentsTexture);
            this._compute.setParameter("indirectDrawQueueBuffer", indirectDrawQueueBuffer);
            this._compute.setParameter("viewProjection", viewProjection.data);
            this._compute.setParameter("hzbUvFactor", _hzbUvFactorArr);
            this._compute.setParameter("screenSize", _screenSizeArr);
            this._compute.setParameter("hzbSize", _hzbSizeArr);
            this._compute.setParameter("count", count);
            this._compute.setupDispatch(groupX, 1, 1);

            this.hzb.device.computeDispatch([this._compute], debugName);
        }
    }

    public execute(camera: pc.Camera, updateParams: boolean = true, debugName: string = "TestHZB") {

        const count = this._indirectQueue.count;

        if (count > 0 && this.hzb.enabled) {

            this._aabbStore.update();
            this._indirectQueue.update();
            this._indirectDataStore.update();

            if (updateParams) {
                const viewMatrix = camera.viewMatrix;
                const projectionMatrix = camera.projectionMatrix;
                this._modelViewProjection.mul2(projectionMatrix, viewMatrix);
                this._cameraPosition.copy((camera.node as pc.GraphNode).getPosition());
            }

            this.test(
                count,
                this._modelViewProjection,
                this._cameraPosition,
                this._aabbStore,
                this._indirectQueue.buffer,
                this._indirectDataStore,
                this.hzb.device.indirectDrawBuffer!, // TODO: add available check
                debugName
            );
        }
    }
}

const _hzbSizeArr = new Float32Array(2);
const _screenSizeArr = new Float32Array(2);
const _hzbUvFactorArr = new Float32Array(2);
const _cameraPosition = new Float32Array(3);
const _boundingBox = new pc.BoundingBox();