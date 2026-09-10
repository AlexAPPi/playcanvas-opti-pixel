import pc from "../../../engine.js";
import { ICoverageBuffer } from "../ICoverageBuffer.js";
import vertexCodeVS from "./WebglCoverageBuffer.vert.glsl.js";
import fragmentCodePS from "./WebglCoverageBuffer.frag.glsl.js";
import packCodeVS from "./WebglCoverageBuffer.pack.glsl.js";
import { getCameraDepthTexture, writeCameraParams } from "../../../Extras/CameraHelpers.js";
import { executeTransformFeedbackShader } from "../../../Extras/TransformFeedbackHelpers.js";
import { CoverageTFStateQueue } from "./CoverageTFStateQueue.js";
import { TFState } from "../../../GPUReadback/Webgl/TFState.js";
import type { TFStateQueue } from "../../../GPUReadback/Webgl/TFStateQueue.js";
import { integerLog2 } from "../CoverageCpuBuffer.js";

/**
 * WebGL2 coverage depth buffer.
 *
 * Downsamples camera depth with a 4-tap max chain that keeps the
 * 256∶128 aspect at every level. The last level is packed with transform
 * feedback (float view-space Z). GPU->CPU download lives in {@link CoverageTFStateQueue}
 * ({@link TFStateQueue} + PBO/FIFO shared with WebGL HZB).
 */
export class WebglCoverageBuffer implements ICoverageBuffer {

    private _enabled: boolean;
    private _cpuReadback: boolean;
    private _resizePending: boolean;
    private _resizeTimeout: number | null;
    private _device: pc.WebglGraphicsDevice;
    private _shader: pc.Shader;
    private _packShader: pc.Shader;
    private _renderTargets: pc.RenderTarget[];
    private _quadRenderPasses: pc.RenderPassShaderQuad[];
    private _buffers: pc.Texture[];
    private _pixelBuffer: pc.VertexBuffer;
    private _packTargetBuffer: pc.Texture;
    private _packTarget: pc.RenderTarget;
    private _readback: CoverageTFStateQueue;

    private _screenWidth: number;
    private _screenHeight: number;

    private _maxWidth: number;
    private _maxHeight: number;
    private _width: number;
    private _height: number;
    private _mipLevels: number;
    private _passWidths: number[];
    private _passHeights: number[];

    private _readScreenDepthScope: pc.ScopeId;
    private _invSrcSizeScope: pc.ScopeId;
    private _destPixelToUvScope: pc.ScopeId;
    private _destSizeScope: pc.ScopeId;
    private _srcUvMaxScope: pc.ScopeId;
    private _depthScope: pc.ScopeId;
    private _cameraParamsScope: pc.ScopeId;

    private _viewProjection = new pc.Mat4();
    private _maxDownsampleStages: number;
    private _onDestroy: pc.EventHandle;
    private _onContextLost: pc.EventHandle;
    private _onContextRestored: pc.EventHandle;

    public get enabled() { return this._enabled; }
    public set enabled(value) { this._enabled = value; }
    public get cpuReadback() { return this._cpuReadback; }
    public set cpuReadback(value: boolean) { this._cpuReadback = value; }
    public get screenWidth() { return this._screenWidth; }
    public get screenHeight() { return this._screenHeight; }
    public get width() { return this._width; }
    public get height() { return this._height; }
    public get device() { return this._device; }
    public get texture() {
        const buffers = this._buffers;
        return buffers && buffers.length > 0 ? buffers[buffers.length - 1] : null;
    }

    /**
     * Last GPU downsample target.
     * The packed {@link maxWidth}x{@link maxHeight} download is {@link cpuDepth}, not a texture.
     */
    public get cpuTexture() { return this.texture; }
    public get buffers() { return this._buffers; }
    public get mipLevels() { return this._mipLevels; }

    public get maxWidth() { return this._maxWidth; }
    public set maxWidth(value: number) {
        this.resize(this.screenWidth, this.screenHeight, value, this._maxHeight);
    }

    public get maxHeight() { return this._maxHeight; }
    public set maxHeight(value: number) {
        this.resize(this.screenWidth, this.screenHeight, this._maxWidth, value);
    }

    public get resizePending() {
        return this._resizePending;
    }

    public get uvFactor(): [number, number] {
        return UV_FACTOR;
    }

    public get cpuReady() { return this._readback.cpuReady; }
    public get cpuVersion() { return this._readback.cpuVersion; }
    public get cpuDepth() { return this._readback.cpuDepth; }

    public get cpuWidth() { return this._maxWidth; }
    public get cpuHeight() { return this._maxHeight; }
    public get cpuViewProjection() { return this._readback.cpuViewProjection; }
    public get cpuCameraParams() { return this._readback.cpuCameraParams; }
    public get cpuUvFactor(): [number, number] {
        return UV_FACTOR;
    }

    public get maxDownsampleStages() { return this._maxDownsampleStages; }
    public set maxDownsampleStages(value: number) {
        const next = Math.max(1, value | 0);
        if (next === this._maxDownsampleStages) {
            return;
        }
        this._maxDownsampleStages = next;
        this.resize();
    }

    public get readbackSlots() { return this._readback.slotCount; }
    public set readbackSlots(value: number) {
        this._readback.slotCount = value;
    }

    public get minReadbackLag() { return this._readback.minReadbackLag; }
    public set minReadbackLag(value: number) {
        this._readback.minReadbackLag = value;
    }

    /**
     * Submit a packed capture every N pack attempts (`update` /
     * `updateGPUDepthBuffer`). Harvest still polls every {@link frameUpdate}.
     * The downsample chain is skipped on ticks that will not capture.
     * Default `1`. Raise on devices where `getBufferSubData` hitches.
     */
    public get readbackPeriod() { return this._readback.readbackPeriod; }
    public set readbackPeriod(value: number) {
        this._readback.readbackPeriod = value;
    }

    /**
     * @param device - WebGL2 device
     * @param maxWidth - CPU width, default 256
     * @param maxHeight - CPU height, default 128
     * @param slotCount - number of readback slots, default 4
     * @param minReadbackLag - minimum `frameUpdate` ticks before polling a slot, default 2
     */
    constructor(device: pc.WebglGraphicsDevice, maxWidth: number = 256, maxHeight: number = 128, slotCount: number = 4, minReadbackLag: number = 2) {
        this._enabled = true;
        this._cpuReadback = true;
        this._resizePending = false;
        this._resizeTimeout = null;
        this._device = device;
        this._maxWidth = Math.max(1, maxWidth | 0);
        this._maxHeight = Math.max(1, maxHeight | 0);
        this._readScreenDepthScope = this._device.scope.resolve("uCoverageReadScreenDepth");
        this._invSrcSizeScope = this._device.scope.resolve("uCoverageInvSrcSize");
        this._destPixelToUvScope = this._device.scope.resolve("uCoverageDestPixelToUv");
        this._destSizeScope = this._device.scope.resolve("uCoverageDestSize");
        this._srcUvMaxScope = this._device.scope.resolve("uCoverageSrcUvMax");
        this._depthScope = this._device.scope.resolve("uCoverageDepth");
        this._cameraParamsScope = this._device.scope.resolve("uCoverageCameraParams");
        this._onDestroy = device.on("destroy", this.destroy, this);
        this._onContextLost = device.on("contextlost", this._onDeviceContextLost, this);
        this._onContextRestored = device.on("devicerestored", this._onDeviceContextRestored, this);
        this._maxDownsampleStages = 4;
        this._readback = new CoverageTFStateQueue(device, this._maxWidth * this._maxHeight, slotCount);
        this._readback.minReadbackLag = minReadbackLag;
        this.resize(this.device.width, this.device.height, this._maxWidth, this._maxHeight);
    }

    public isFloat16() {
        return false;
    }

    public isFloat32() {
        return false;
    }

    public isColor() {
        return true;
    }

    public resizeWithDelay(delay: number = 300) {

        if (this._resizeTimeout) {
            clearTimeout(this._resizeTimeout);
        }

        this._resizePending = true;
        this._resizeTimeout = setTimeout(() => {
            this.resize();
        }, delay);
    }

    public resize(
        width: number = this.screenWidth,
        height: number = this.screenHeight,
        maxWidth: number = this.maxWidth,
        maxHeight: number = this.maxHeight
    ) {

        this._disposeGpu();

        this._resizePending = false;
        this._maxWidth = Math.max(1, maxWidth | 0);
        this._maxHeight = Math.max(1, maxHeight | 0);
        this._screenWidth = width | 0;
        this._screenHeight = height | 0;
        this._width = this._maxWidth;
        this._height = this._maxHeight;

        this._buildPassSizes();
        this._initShader();
        this._initRenders();
        this._initPackTarget();
        this._initPixelBuffer();
        this._readback.resize(this._maxWidth * this._maxHeight);
    }

    public frameUpdate(dt: number) {
        this._readback.frameUpdate(dt);
    }

    public update(camera: pc.Camera) {

        if (!this.enabled) {
            return;
        }

        const mainDepthTexture = getCameraDepthTexture(camera);
        if (!mainDepthTexture) {
            return;
        }

        if (mainDepthTexture.width !== this.screenWidth ||
            mainDepthTexture.height !== this.screenHeight) {
            this.resize(mainDepthTexture.width, mainDepthTexture.height);
        }

        this._viewProjection.mul2(camera.projectionMatrix, camera.viewMatrix);
        writeCameraParams(_cameraParamsArr, camera);

        // Android getBufferSubData waits for the GPU process to drain, so we
        // only build the chain on ticks that will actually pack a capture.
        // `acquire()` consumes {@link readbackPeriod} even when it returns null.
        let slot: TFState | null = null;
        if (this._cpuReadback) {
            slot = this._readback.acquire();
            if (!slot) {
                return;
            }
        }

        const device = this.device;
        const { vx, vy, vw, vh, sx, sy, sw, sh } = device;
        const oldRenderTarget = device.getRenderTarget();
        const passCount = this._passWidths.length;
        const quadCount = Math.max(0, passCount - 1);

        let srcBuffer = mainDepthTexture;
        let srcWidth = mainDepthTexture.width;
        let srcHeight = mainDepthTexture.height;
        let readScreenDepth = 1;

        _srcUvMaxArr[0] = (this.screenWidth - 0.5) / srcWidth;
        _srcUvMaxArr[1] = (this.screenHeight - 0.5) / srcHeight;

        for (let mip = 0; mip < quadCount; mip++) {

            const destW = this._passWidths[mip];
            const destH = this._passHeights[mip];

            _invSrcSizeArr[0] = 1 / srcWidth;
            _invSrcSizeArr[1] = 1 / srcHeight;
            _destPixelToUvArr[0] = 1 / destW;
            _destPixelToUvArr[1] = 1 / destH;

            this._srcUvMaxScope.setValue(_srcUvMaxArr);
            this._destPixelToUvScope.setValue(_destPixelToUvArr);
            this._invSrcSizeScope.setValue(_invSrcSizeArr);
            this._readScreenDepthScope.setValue(readScreenDepth);
            this._depthScope.setValue(srcBuffer);

            this._quadRenderPasses[mip].render();

            readScreenDepth = 0;
            srcWidth = destW;
            srcHeight = destH;
            srcBuffer = this._buffers[mip];

            if (mip === 0) {
                _srcUvMaxArr[0] = (srcWidth - 0.5) / srcWidth;
                _srcUvMaxArr[1] = (srcHeight - 0.5) / srcHeight;
            }
        }

        if (slot) {
            this._pack(slot, srcBuffer, srcWidth, srcHeight, readScreenDepth);
        }

        device.setRenderTarget(oldRenderTarget);
        device.setViewport(vx, vy, vw, vh);
        device.setScissor(sx, sy, sw, sh);
    }

    public destroy() {
        this._onDestroy?.off();
        this._onContextLost?.off();
        this._onContextRestored?.off();
        this._readback.destroy();
        this._disposeGpu();
    }

    /**
     * `stages = min(maxDownsampleStages, max(1+log2(src/cap)))`, dest[i] = cap << (stages-i-1).
     */
    protected _buildPassSizes() {

        this._passWidths = [];
        this._passHeights = [];

        const capW = this._maxWidth;
        const capH = this._maxHeight;
        const downX = Math.max(0, 1 + integerLog2((this._screenWidth / capW) | 0));
        const downY = Math.max(0, 1 + integerLog2((this._screenHeight / capH) | 0));
        const stages = Math.max(1, Math.min(this._maxDownsampleStages, Math.max(downX, downY)));

        for (let i = 0; i < stages; i++) {
            const shift = stages - i - 1;
            this._passWidths.push(Math.max(1, capW << shift));
            this._passHeights.push(Math.max(1, capH << shift));
        }
    }

    protected _coverageDefines() {

        const defines = new Map<string, string>();
        let workaroundFloat = false;

        if (!this.isColor()) {
            defines.set("READ_DEPTH", "");
            defines.set("WRITE_DEPTH", "");
        }
        else if (this.isFloat16()) {
            defines.set("DEPTH_IS_FLOAT16", "");
        }
        else if (this.isFloat32()) {
            defines.set("DEPTH_IS_FLOAT", "");
        }
        else {
            workaroundFloat = true;
        }

        if (this.device.textureFloatRenderable) {
            defines.set("SCENE_DEPTHMAP_FLOAT", "");
        }
        else {
            workaroundFloat = true;
        }

        if (workaroundFloat) {
            defines.set("WORKAROUND_FLOAT", "");
        }

        return defines;
    }

    protected _initShader() {

        const defines = this._coverageDefines();

        this._shader = pc.ShaderUtils.createShader(this._device, {
            uniqueName: "COVERAGE_DEPTH_SHADER",
            useTransformFeedback: false,
            vertexGLSL: vertexCodeVS,
            fragmentGLSL: fragmentCodePS,
            fragmentDefines: defines,
            attributes: {
                aPosition: pc.SEMANTIC_POSITION
            },
        });

        const packDefines = this._coverageDefines();
        packDefines.delete("WRITE_DEPTH");

        this._packShader = pc.ShaderUtils.createShader(this._device, {
            uniqueName: "COVERAGE_PACK_TF_SHADER",
            useTransformFeedback: true,
            vertexGLSL: packCodeVS,
            fragmentGLSL: "void main(void) { gl_FragColor = vec4(1.0); }",
            vertexDefines: packDefines,
            attributes: {
                aCoveragePixel: pc.SEMANTIC_POSITION
            },
        });

        const gl = this._device.gl;
        const glProgram = this._packShader.impl.glProgram;
        if (gl && glProgram) {
            gl.transformFeedbackVaryings(glProgram, PACK_TF_VARYINGS, gl.INTERLEAVED_ATTRIBS);
            gl.linkProgram(glProgram);
        }
    }

    protected _initRenders() {

        const quadCount = Math.max(0, this._passWidths.length - 1);

        this._buffers = new Array(quadCount);
        this._renderTargets = new Array(quadCount);
        this._quadRenderPasses = new Array(quadCount);
        this._mipLevels = quadCount;

        const depthByColor = this.isColor();
        const format = (
            !depthByColor    ? pc.PIXELFORMAT_DEPTH :
            this.isFloat16() ? pc.PIXELFORMAT_R16F :
            this.isFloat32() ? pc.PIXELFORMAT_R32F :
                               pc.PIXELFORMAT_RGBA8
        );

        for (let i = 0; i < quadCount; i++) {

            const buffer = new pc.Texture(this._device, {
                name: "COVERAGE_DS_TX_" + i,
                width: this._passWidths[i],
                height: this._passHeights[i],
                format: format,
                mipmaps: false,
                minFilter: pc.FILTER_NEAREST,
                magFilter: pc.FILTER_NEAREST,
                addressU: pc.ADDRESS_CLAMP_TO_EDGE,
                addressV: pc.ADDRESS_CLAMP_TO_EDGE,
                storage: false,
            });

            const optsRt: ConstructorParameters<typeof pc.RenderTarget>[0] = {
                name: "COVERAGE_DS_RT_" + i,
                depth: false,
                autoResolve: false,
                mipLevel: 0,
                colorBuffer: buffer,
                stencil: false,
                samples: 1,
            };

            if (!depthByColor) {
                optsRt.depth = true;
                optsRt.colorBuffer = null!;
                optsRt.depthBuffer = buffer;
            }

            const rt = new pc.RenderTarget(optsRt);
            const rps = new pc.RenderPassShaderQuad(this._device);

            if (depthByColor) {
                rps.blendState = pc.BlendState.NOBLEND;
                rps.depthState = pc.DepthState.NODEPTH;
            }
            else {
                rps.blendState = pc.BlendState.NOWRITE;
                rps.depthState = pc.DepthState.WRITEDEPTH;
            }

            rps.shader = this._shader;
            rps.init(rt);

            if (depthByColor) {
                rps.colorOps.clear = true;
                rps.colorOps.genMipmaps = false;
            }

            this._buffers[i] = buffer;
            this._renderTargets[i] = rt;
            this._quadRenderPasses[i] = rps;
        }
    }

    protected _initPixelBuffer() {

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

    protected _pack(
        slot: TFState,
        srcBuffer: pc.Texture,
        srcWidth: number,
        srcHeight: number,
        readScreenDepth: number
    ) {

        const pixelBuffer = this._ensurePixelBuffer();
        if (!pixelBuffer || !this._packShader || !this._packTarget) {
            slot.reserved = false;
            return;
        }

        slot.beforeFill();

        const outputBuffer = slot.outputBuffer;
        if (!outputBuffer) {
            slot.reserved = false;
            return;
        }

        const destW = this._maxWidth;
        const destH = this._maxHeight;
        const pixelCount = destW * destH;

        _invSrcSizeArr[0] = 1 / srcWidth;
        _invSrcSizeArr[1] = 1 / srcHeight;
        _destPixelToUvArr[0] = 1 / destW;
        _destPixelToUvArr[1] = 1 / destH;
        _destSizeArr[0] = destW;
        _destSizeArr[1] = destH;

        this._srcUvMaxScope.setValue(_srcUvMaxArr);
        this._destPixelToUvScope.setValue(_destPixelToUvArr);
        this._destSizeScope.setValue(_destSizeArr);
        this._invSrcSizeScope.setValue(_invSrcSizeArr);
        this._readScreenDepthScope.setValue(readScreenDepth);
        this._depthScope.setValue(srcBuffer);
        this._cameraParamsScope.setValue(_cameraParamsArr);

        executeTransformFeedbackShader(
            this._packShader,
            pixelCount,
            pixelBuffer,
            outputBuffer,
            this._packTarget
        );

        slot.vp.set(this._viewProjection.data);
        slot.cameraParams.set(_cameraParamsArr);
        this._readback.submit(slot);
    }

    /**
     * Throwaway 1×1 target bound for the pack draw. Rasterization is off, so it
     * is never written. It exists so the pack neither binds the backbuffer
     * mid-frame (a tile flush on mobile) nor keeps the last chain target bound,
     * which would sample the render target's own color buffer.
     */
    protected _initPackTarget() {

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
        if (!this._pixelBuffer || !this._pixelBuffer.impl?.bufferId) {
            this._initPixelBuffer();
        }
        return this._pixelBuffer;
    }

    private _onDeviceContextLost() {
        this._readback.onContextLost();
    }

    private _onDeviceContextRestored() {
        this.resize();
    }

    protected _disposeGpu() {

        if (this._resizeTimeout) {
            clearTimeout(this._resizeTimeout);
            this._resizeTimeout = null;
        }

        this._resizePending = false;
        this._quadRenderPasses?.forEach(x => x?.destroy());
        this._renderTargets?.forEach(x => x?.destroy());
        this._buffers?.forEach(x => x?.destroy());
        this._packTarget?.destroy();
        this._packTargetBuffer?.destroy();
        this._packTarget = null!;
        this._packTargetBuffer = null!;
        this._pixelBuffer?.destroy();
        this._pixelBuffer = null!;
        this._shader?.destroy();
        this._packShader?.destroy();
    }
}

const UV_FACTOR: [number, number] = [1, 1];
const PACK_TF_VARYINGS = ["out_depth"];
const _invSrcSizeArr = new Float32Array(2);
const _destPixelToUvArr = new Float32Array(2);
const _destSizeArr = new Float32Array(2);
const _srcUvMaxArr = new Float32Array(2);
const _cameraParamsArr = new Float32Array(4);
