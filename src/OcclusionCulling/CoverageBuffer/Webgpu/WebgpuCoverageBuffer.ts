import pc from "../../../engine.js";
import { ICoverageBuffer } from "../ICoverageBuffer.js";
import type { IHierarchicalZBuffer } from "../../HZB/IHierarchicalZBuffer.js";
import computeCodeCS from "./WebgpuCoverageBuffer.comp.wgsl.js";
import { CoverageGpuReadback } from "./CoverageGpuReadback.js";
import { CoverageMipCache } from "../CoverageMipCache.js";
import { hzbShaderKind, THzbShaderKind } from "../CoverageMath.js";

const workgroupSize = 8;

/**
 * WebGPU coverage depth buffer.
 *
 * Reads the HZB mip nearest to {@link maxWidth} × {@link maxHeight} and packs
 * its screen footprint to float view-space Z. Pixel `i` covers screen UV
 * `[i / width, (i + 1) / width]` and reads the HZB texels under that slice.
 * GPU→CPU download is a ring of
 * {@link readbackSlots} staging reads ({@link CoverageGpuReadback}).
 * The next pack starts when a slot is free.
 */
export class WebgpuCoverageBuffer implements ICoverageBuffer {

    private _enabled: boolean;
    private _cpuReadback: boolean;
    private _device: pc.WebgpuGraphicsDevice;
    private _readback: CoverageGpuReadback;

    private _compute: pc.Compute | null = null;
    private _computeKind: THzbShaderKind | null = null;
    private _dispatchList: pc.Compute[] = [null!];
    private _sizeArr = [0, 0, 0, 0];
    private _spanArr = new Float32Array(2);
    private _cameraParamsArr = new Float32Array(4);

    private _maxWidth: number;
    private _maxHeight: number;
    private _sourceMip = 0;
    private _mipCache = new CoverageMipCache();

    private _viewProjection = new pc.Mat4();
    private _onDestroy: pc.EventHandle;

    public get enabled() { return this._enabled; }
    public set enabled(value) { this._enabled = value; }
    public get cpuReadback() { return this._cpuReadback; }
    public set cpuReadback(value: boolean) { this._cpuReadback = value; }
    public get width() { return this._maxWidth; }
    public get height() { return this._maxHeight; }
    public get device() { return this._device; }
    public get sourceMip() { return this._sourceMip; }

    public get maxWidth() { return this._maxWidth; }
    public set maxWidth(value: number) {
        this.resize(value, this._maxHeight);
    }

    public get maxHeight() { return this._maxHeight; }
    public set maxHeight(value: number) {
        this.resize(this._maxWidth, value);
    }

    public get cpuReady() { return this._readback.cpuReady; }
    public get cpuVersion() { return this._readback.cpuVersion; }
    public get cpuDepth() { return this._readback.cpuDepth; }

    public get cpuWidth() {
        const width = this._readback.cpuWidth;
        return width > 0 ? width : this._maxWidth;
    }

    public get cpuHeight() {
        const height = this._readback.cpuHeight;
        return height > 0 ? height : this._maxHeight;
    }

    public get cpuViewProjection() { return this._readback.cpuViewProjection; }
    public get cpuCameraParams() { return this._readback.cpuCameraParams; }

    public get minReadbackLag() { return this._readback.minReadbackLag; }
    public set minReadbackLag(value: number) {
        this._readback.minReadbackLag = value;
    }

    /**
     * In-flight staging slots. Default `5`, clamped to at least `2`.
     * Changing it drops downloads that have not landed yet.
     */
    public get readbackSlots() { return this._readback.slotCount; }
    public set readbackSlots(value: number) { this._readback.slotCount = value; }

    /**
     * @param device - WebGPU device
     * @param maxWidth - CPU width, default 256
     * @param maxHeight - CPU height, default 128
     */
    constructor(device: pc.WebgpuGraphicsDevice, maxWidth: number = 256, maxHeight: number = 128) {
        this._enabled = true;
        this._cpuReadback = true;
        this._device = device;
        this._maxWidth = Math.max(1, maxWidth | 0);
        this._maxHeight = Math.max(1, maxHeight | 0);
        this._onDestroy = device.on("destroy", this.destroy, this);
        this._readback = new CoverageGpuReadback(device, this._maxWidth * this._maxHeight);
        this._readback.minReadbackLag = 2;
    }

    public resize(maxWidth: number = this.maxWidth, maxHeight: number = this.maxHeight) {
        this._maxWidth = Math.max(1, maxWidth | 0);
        this._maxHeight = Math.max(1, maxHeight | 0);
        this._readback.resize(this._maxWidth * this._maxHeight);
    }

    public frameUpdate(dt: number) {
        this._readback.frameUpdate(dt);
    }

    public capture(hzb: IHierarchicalZBuffer, camera: pc.Camera) {

        const texture = hzb.texture;
        if (!this.enabled || !this._cpuReadback || !hzb.enabled || !texture) {
            return;
        }

        const mip = this._mipCache.select(hzb, this._maxWidth, this._maxHeight);

        // WebGPU keeps every level on `texture`. WebGL's `buffers[level]` is the
        // ping-pong target that received that level; the texels still live at `level`.
        const src = hzb.buffers?.[mip.level] ?? texture;
        const kind = hzbShaderKind(hzb);
        const compute = this._computeFor(kind);
        const slot = this._readback.acquire();
        if (!slot) {
            return;
        }

        const output = this._readback.outputBuffer;
        if (!output) {
            this._readback.release(slot);
            return;
        }

        this._sourceMip = mip.level;
        this._viewProjection.mul2(camera.projectionMatrix, camera.viewMatrix);
        camera.fillShaderParams(this._cameraParamsArr);

        this._sizeArr[0] = mip.packWidth;
        this._sizeArr[1] = mip.packHeight;
        this._sizeArr[2] = mip.texelCountX;
        this._sizeArr[3] = mip.texelCountY;
        this._spanArr[0] = mip.spanX;
        this._spanArr[1] = mip.spanY;

        compute.setParameter("uCoverageMipLevel", mip.level);
        compute.setParameter("uCoverageSize", this._sizeArr);
        compute.setParameter("uCoverageSpan", this._spanArr);
        compute.setParameter("uCoverageCameraParams", this._cameraParamsArr);
        compute.setParameter("uCoverageDepth", src);
        compute.setParameter("out_depth", output);
        compute.setupDispatch(
            Math.ceil(mip.packWidth / workgroupSize),
            Math.ceil(mip.packHeight / workgroupSize)
        );

        this._dispatchList[0] = compute;
        this._device.computeDispatch(this._dispatchList, compute.name);

        slot.width = mip.packWidth;
        slot.height = mip.packHeight;

        this._readback.submit(slot, this._viewProjection.data, this._cameraParamsArr, mip.packWidth * mip.packHeight);
    }

    public destroy() {
        this._onDestroy?.off();
        this._readback.destroy();
        this._disposeGpu();
    }

    private _uniformBufferFormat() {
        return {
            ub: new pc.UniformBufferFormat(this._device, [
                new pc.UniformFormat("uCoverageMipLevel", pc.UNIFORMTYPE_INT),
                new pc.UniformFormat("uCoverageSize", pc.UNIFORMTYPE_IVEC4),
                new pc.UniformFormat("uCoverageCameraParams", pc.UNIFORMTYPE_VEC4),
                new pc.UniformFormat("uCoverageSpan", pc.UNIFORMTYPE_VEC2)
            ])
        };
    }

    private _createCompute(kind: THzbShaderKind) {

        const defines = new Map<string, string>();
        if (kind === "f16") {
            defines.set("DEPTH_IS_FLOAT16", "");
        }
        else if (kind === "f32") {
            defines.set("DEPTH_IS_FLOAT", "");
        }

        const shader = new pc.Shader(this._device, {
            name: "CoveragePackHzb" + (kind === "f16" ? "F16" : kind === "f32" ? "F32" : "U8"),
            shaderLanguage: pc.SHADERLANGUAGE_WGSL,
            cshader: computeCodeCS,
            cdefines: defines,
            cincludes: pc.ShaderChunks.get(this._device, pc.SHADERLANGUAGE_WGSL),
            computeUniformBufferFormats: this._uniformBufferFormat(),
            computeBindGroupFormat: new pc.BindGroupFormat(this._device, [
                new pc.BindUniformBufferFormat("ub", pc.SHADERSTAGE_COMPUTE),
                new pc.BindTextureFormat(
                    "uCoverageDepth",
                    pc.SHADERSTAGE_COMPUTE,
                    pc.TEXTUREDIMENSION_2D,
                    pc.SAMPLETYPE_UNFILTERABLE_FLOAT,
                    false,
                    null
                ),
                new pc.BindStorageBufferFormat("out_depth", pc.SHADERSTAGE_COMPUTE)
            ])
        });

        return new pc.Compute(this._device, shader, shader.name);
    }

    private _computeFor(kind: THzbShaderKind) {

        if (this._compute &&
            this._computeKind === kind) {
            return this._compute;
        }

        this._releaseCompute();
        this._compute = this._createCompute(kind);
        this._computeKind = kind;
        return this._compute;
    }

    private _releaseCompute() {
        const compute = this._compute;
        if (compute) {
            const shader = compute.shader;
            const format = shader?.definition.computeBindGroupFormat;
            compute.destroy();
            shader?.destroy();
            format?.destroy();
        }
        this._compute = null;
        this._computeKind = null;
    }

    private _disposeGpu() {
        this._releaseCompute();
    }
}
