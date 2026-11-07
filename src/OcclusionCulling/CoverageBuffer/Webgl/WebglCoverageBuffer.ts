import pc from "../../../engine.js";
import { ICoverageBuffer } from "../ICoverageBuffer.js";
import type { IHierarchicalZBuffer } from "../../HZB/IHierarchicalZBuffer.js";
import packCodeVS from "./WebglCoverageBuffer.pack.glsl.js";
import { executeTransformFeedbackShader } from "../../../Extras/TransformFeedbackHelpers.js";
import { CoverageTFReadback } from "./CoverageTFReadback.js";
import { hzbShaderKind, selectCoverageMip, THzbShaderKind } from "../CoverageMath.js";

const PACK_TF_VARYINGS = ["out_depth"];

/**
 * WebGL2 coverage depth buffer.
 *
 * Reads the HZB mip nearest to {@link maxWidth} × {@link maxHeight} and packs
 * its screen footprint with transform feedback to float view-space Z.
 * Pixel `i` is HZB texel `i` of that footprint. GPU→CPU download is a
 * ring of {@link readbackSlots} PBO/fence reads ({@link CoverageTFReadback}).
 * The next pack starts when a slot is free.
 */
export class WebglCoverageBuffer implements ICoverageBuffer {

    private _enabled: boolean;
    private _cpuReadback: boolean;
    private _device: pc.WebglGraphicsDevice;
    private _packShader: pc.Shader | null = null;
    private _packShaderKind: THzbShaderKind | null = null;
    private _pixelBuffer: pc.VertexBuffer;
    private _packTargetBuffer: pc.Texture;
    private _packTarget: pc.RenderTarget;
    private _readback: CoverageTFReadback;

    private _maxWidth: number;
    private _maxHeight: number;
    private _sourceMip = 0;

    private _mipLevelScope: pc.ScopeId;
    private _sizeScope: pc.ScopeId;
    private _depthScope: pc.ScopeId;
    private _cameraParamsScope: pc.ScopeId;

    private _viewProjection = new pc.Mat4();
    private _sizeArr = [0, 0, 0, 0];
    private _cameraParamsArr = new Float32Array(4);
    private _onDestroy: pc.EventHandle;
    private _onContextLost: pc.EventHandle;
    private _onContextRestored: pc.EventHandle;

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

    public get cpuGridScaleX() {
        const scale = this._readback.cpuGridScaleX;
        return scale > 0 ? scale : this.cpuWidth;
    }

    public get cpuGridScaleY() {
        const scale = this._readback.cpuGridScaleY;
        return scale > 0 ? scale : this.cpuHeight;
    }

    public get cpuViewProjection() { return this._readback.cpuViewProjection; }
    public get cpuCameraParams() { return this._readback.cpuCameraParams; }

    public get minReadbackLag() { return this._readback.minReadbackLag; }
    public set minReadbackLag(value: number) {
        this._readback.minReadbackLag = value;
    }

    /**
     * In-flight PBO slots. Default `5`, clamped to at least `2`.
     * Changing it drops downloads that have not landed yet.
     */
    public get readbackSlots() { return this._readback.slotCount; }
    public set readbackSlots(value: number) { this._readback.slotCount = value; }

    /**
     * Submit a packed capture every N attempts while a readback slot is free
     * ({@link capture}, or the tester wrapper). Harvest still polls every
     * {@link frameUpdate}. The pack is skipped when every slot is in flight
     * and on ticks that will not capture. An attempt with no free slot does
     * not advance this counter. Default `1`. Raise on devices where
     * `getBufferSubData` hitches.
     */
    public get readbackPeriod() { return this._readback.readbackPeriod; }
    public set readbackPeriod(value: number) {
        this._readback.readbackPeriod = value;
    }

    /**
     * @param device - WebGL2 device
     * @param maxWidth - CPU width, default 256
     * @param maxHeight - CPU height, default 128
     * @param minReadbackLag - minimum `frameUpdate` ticks before copying the download, default 2
     */
    constructor(device: pc.WebglGraphicsDevice, maxWidth: number = 256, maxHeight: number = 128, minReadbackLag: number = 2) {
        this._enabled = true;
        this._cpuReadback = true;
        this._device = device;
        this._maxWidth = Math.max(1, maxWidth | 0);
        this._maxHeight = Math.max(1, maxHeight | 0);
        this._mipLevelScope = this._device.scope.resolve("uCoverageMipLevel");
        this._sizeScope = this._device.scope.resolve("uCoverageSize");
        this._depthScope = this._device.scope.resolve("uCoverageDepth");
        this._cameraParamsScope = this._device.scope.resolve("uCoverageCameraParams");
        this._onDestroy = device.on("destroy", this.destroy, this);
        this._onContextLost = device.on("contextlost", this._onDeviceContextLost, this);
        this._onContextRestored = device.on("devicerestored", this._onDeviceContextRestored, this);
        this._readback = new CoverageTFReadback(device, this._maxWidth * this._maxHeight);
        this._readback.minReadbackLag = minReadbackLag;
        this._initPackTarget();
        this._initPixelBuffer();
    }

    public resize(maxWidth: number = this.maxWidth, maxHeight: number = this.maxHeight) {
        this._maxWidth = Math.max(1, maxWidth | 0);
        this._maxHeight = Math.max(1, maxHeight | 0);
        this._initPixelBuffer();
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

        const uv = hzb.uvFactor;
        const mip = selectCoverageMip(
            hzb.width,
            hzb.height,
            hzb.mipLevels,
            this._maxWidth,
            this._maxHeight,
            uv[0],
            uv[1]
        );
        // `buffers[level]` is the ping-pong texture that was rendered at that
        // mip. The texels live at lod `level`, same as the HZB debugger.
        const src = hzb.buffers?.[mip.level] ?? texture;
        const kind = hzbShaderKind(hzb);
        const packShader = this._ensurePackShader(kind);
        const slot = this._readback.acquire();
        if (!slot) {
            return;
        }

        this._sourceMip = mip.level;

        const pixelBuffer = this._ensurePixelBuffer();
        if (!this._packTarget) {
            this._readback.release(slot);
            return;
        }

        slot.beforeFill();

        const outputBuffer = slot.outputBuffer;
        if (!outputBuffer) {
            this._readback.release(slot);
            return;
        }

        this._viewProjection.mul2(camera.projectionMatrix, camera.viewMatrix);
        camera.fillShaderParams(this._cameraParamsArr);

        this._sizeArr[0] = mip.packWidth;
        this._sizeArr[1] = mip.packHeight;
        this._sizeArr[2] = mip.texelCountX;
        this._sizeArr[3] = mip.texelCountY;

        this._mipLevelScope.setValue(mip.level);
        this._sizeScope.setValue(this._sizeArr);
        this._depthScope.setValue(src);
        this._cameraParamsScope.setValue(this._cameraParamsArr);

        executeTransformFeedbackShader(
            packShader,
            mip.packWidth * mip.packHeight,
            pixelBuffer,
            outputBuffer,
            this._packTarget
        );

        slot.width = mip.packWidth;
        slot.height = mip.packHeight;
        slot.gridScaleX = mip.gridScaleX;
        slot.gridScaleY = mip.gridScaleY;
        slot.vp.set(this._viewProjection.data);
        slot.cameraParams.set(this._cameraParamsArr);
        this._readback.submit(slot, mip.packWidth * mip.packHeight);
    }

    public destroy() {
        this._onDestroy?.off();
        this._onContextLost?.off();
        this._onContextRestored?.off();
        this._readback.destroy();
        this._disposeGpu();
    }

    private _ensurePackShader(kind: THzbShaderKind) {

        if (this._packShader &&
            this._packShaderKind === kind) {
            return this._packShader;
        }

        this._releasePackShader();

        const defines = new Map<string, string>();
        if (kind === "f16") {
            defines.set("DEPTH_IS_FLOAT16", "");
        }
        else if (kind === "f32") {
            defines.set("DEPTH_IS_FLOAT", "");
        }

        const shader = pc.ShaderUtils.createShader(this._device, {
            uniqueName: "COVERAGE_PACK_HZB_" + kind,
            useTransformFeedback: true,
            vertexGLSL: packCodeVS,
            fragmentGLSL: "void main(void) { gl_FragColor = vec4(1.0); }",
            vertexDefines: defines,
            attributes: {
                aCoveragePixel: pc.SEMANTIC_POSITION
            },
        });

        const gl = this._device.gl;
        const glProgram = shader.impl.glProgram;
        if (gl && glProgram) {
            gl.transformFeedbackVaryings(glProgram, PACK_TF_VARYINGS, gl.INTERLEAVED_ATTRIBS);
            gl.linkProgram(glProgram);
        }

        this._packShader = shader;
        this._packShaderKind = kind;
        return shader;
    }

    private _initPixelBuffer() {

        this._pixelBuffer?.destroy();

        const pixelCount = this._maxWidth * this._maxHeight;
        const format = new pc.VertexFormat(this._device, [{
            semantic: pc.SEMANTIC_POSITION,
            components: 1,
            type: pc.TYPE_FLOAT32,
            normalize: false
        }]);

        this._pixelBuffer = new pc.VertexBuffer(this._device, format, pixelCount, {
            usage: pc.BUFFER_STATIC
        });
        this._pixelBuffer.unlock();
    }

    /**
     * Throwaway 1×1 target bound for the pack draw. Rasterization is off, so it
     * is never written. It exists so the pack neither binds the backbuffer
     * mid-frame (a tile flush on mobile) nor samples a render target that is
     * still the draw target.
     */
    private _initPackTarget() {

        this._packTargetBuffer?.destroy();
        this._packTarget?.destroy();

        this._packTargetBuffer = new pc.Texture(this._device, {
            name: "COVERAGE_PACK_RT_TX",
            width: 1,
            height: 1,
            format: pc.PIXELFORMAT_RGBA8,
            mipmaps: false,
            minFilter: pc.FILTER_NEAREST,
            magFilter: pc.FILTER_NEAREST,
            addressU: pc.ADDRESS_CLAMP_TO_EDGE,
            addressV: pc.ADDRESS_CLAMP_TO_EDGE,
            storage: false,
        });

        this._packTarget = new pc.RenderTarget({
            name: "COVERAGE_PACK_RT",
            colorBuffer: this._packTargetBuffer,
            depth: false,
            stencil: false,
            autoResolve: false,
            samples: 1,
        });
    }

    private _ensurePixelBuffer() {
        if (!this._pixelBuffer ||
            !this._pixelBuffer.impl?.bufferId) {
            this._initPixelBuffer();
        }
        return this._pixelBuffer;
    }

    private _onDeviceContextLost() {
        this._readback.onContextLost();
    }

    private _onDeviceContextRestored() {
        this._releasePackShader();
        this._initPackTarget();
        this._initPixelBuffer();
    }

    private _releasePackShader() {
        this._packShader?.destroy();
        this._packShader = null;
        this._packShaderKind = null;
    }

    private _disposeGpu() {
        this._releasePackShader();
        this._packTarget?.destroy();
        this._packTargetBuffer?.destroy();
        this._packTarget = null!;
        this._packTargetBuffer = null!;
        this._pixelBuffer?.destroy();
        this._pixelBuffer = null!;
    }
}
