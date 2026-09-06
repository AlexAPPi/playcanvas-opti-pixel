import pc from "../../../engine.js";
import { IHierarchicalZBuffer } from "../../HZB/IHierarchicalZBuffer.js";
import vertexCodeVS from "../../HZB/Webgl/WebglHierarchicalZBuffer.vert.glsl.js";
import fragmentCodePS from "../../HZB/Webgl/WebglHierarchicalZBuffer.frag.glsl.js";
import { getCameraDepthTexture } from "../../../Extras/CameraHelpers.js";

interface ICoverageReadbackSlot {
    rgba: Uint8Array;
    vp: Float32Array;
    uvFactor: Float32Array;
    pbo: WebGLBuffer | null;
    pboBytes: number;
    sync: WebGLSync | null;
    pending: boolean;
    unread: boolean;
    ready: boolean;
    submitFrame: number;
}

/**
 * WebGL2 coverage depth buffer.
 *
 * Downsamples camera depth with a 2×2 max chain (same gather shader as
 * {@link WebglHierarchicalZBuffer}) until the buffer fits in 256×128.
 * Each level is its own texture. The last level is packed into a full-screen
 * 256×128 target and can be downloaded to the CPU via async PIXEL_PACK readback.
 */
export class WebglCoverageBuffer implements IHierarchicalZBuffer {

    private _enabled: boolean;
    private _cpuReadback: boolean;
    private _resizePending: boolean;
    private _resizeTimeout: number | null;
    private _device: pc.WebglGraphicsDevice;
    private _shader: pc.Shader;
    private _renderTargets: pc.RenderTarget[];
    private _quadRenderPasses: pc.RenderPassShaderQuad[];
    private _buffers: pc.Texture[];

    private _cpuTexture: pc.Texture;
    private _cpuRenderTarget: pc.RenderTarget;
    private _cpuBlitPass: pc.RenderPassShaderQuad;

    private _screenWidth: number;
    private _screenHeight: number;
    private _globalMipWidth: number;
    private _globalMipHeight: number;

    private _maxWidth: number;
    private _maxHeight: number;
    private _width: number;
    private _height: number;
    private _mipLevels: number;
    private _uvFactorX: number;
    private _uvFactorY: number;
    private _passWidths: number[];
    private _passHeights: number[];

    private _dispatchThreadIdToBufferUVScope: pc.ScopeId;
    private _inputViewportMaxBoundScope: pc.ScopeId;
    private _invSizeScope: pc.ScopeId;
    private _readScreenDepthScope: pc.ScopeId;
    private _readLevelScope: pc.ScopeId;
    private _depthMipScope: pc.ScopeId;

    private _viewProjection = new pc.Mat4();
    private _frameId = 0;
    private _readbackSlots: number;
    private _minReadbackLatency: number;
    private _slots: ICoverageReadbackSlot[] = [];
    private _cpuDepth: Float32Array;
    private _cpuVP = new Float32Array(16);
    private _cpuUvFactor = new Float32Array(2);
    private _cpuReady = false;
    private _cpuVersion = 0;
    private _submitFrame = -1;
    private _onDestroy: pc.EventHandle;
    private _onContextLost: pc.EventHandle;

    public get enabled() { return this._enabled; }
    public set enabled(value) { this._enabled = value; }
    public get cpuReadback() { return this._cpuReadback; }
    public set cpuReadback(value: boolean) { this._cpuReadback = value; }
    public get screenWidth() { return this._screenWidth; }
    public get screenHeight() { return this._screenHeight; }
    public get width() { return this._width; }
    public get height() { return this._height; }
    public get device() { return this._device; }
    public get texture() { return this._buffers[this._buffers.length - 1] ?? null; }
    public get cpuTexture() { return this._cpuTexture; }
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
        return [this._uvFactorX, this._uvFactorY];
    }

    /** True once at least one GPU→CPU download has finished. */
    public get cpuReady() { return this._cpuReady; }

    /** Increments each time a new CPU depth capture is applied. */
    public get cpuVersion() { return this._cpuVersion; }

    /** Packed 256×128 (or current cap) device-depth, Y-up, UV 0..1 = full screen. */
    public get cpuDepth() { return this._cpuDepth; }

    public get cpuWidth() { return this._maxWidth; }
    public get cpuHeight() { return this._maxHeight; }
    public get cpuViewProjection() { return this._cpuVP; }
    public get cpuUvFactor(): [number, number] {
        return [this._cpuUvFactor[0], this._cpuUvFactor[1]];
    }

    /** Number of in-flight PIXEL_PACK readback slots. */
    public get readbackSlots() { return this._readbackSlots; }
    public set readbackSlots(value: number) {
        const next = Math.max(1, value | 0);
        if (next === this._readbackSlots) {
            return;
        }
        this._readbackSlots = next;
        this._initReadback();
    }

    /** Minimum frames to wait before polling a submitted readback. */
    public get minReadbackLatency() { return this._minReadbackLatency; }
    public set minReadbackLatency(value: number) {
        this._minReadbackLatency = Math.max(0, value | 0);
    }

    /**
     * @param device - WebGL2 device
     * @param maxWidth - Packed CPU width cap (default 256)
     * @param maxHeight - Packed CPU height cap (default 128)
     */
    constructor(device: pc.WebglGraphicsDevice, maxWidth: number = 256, maxHeight: number = 128) {
        this._enabled = true;
        this._cpuReadback = true;
        this._resizePending = false;
        this._resizeTimeout = null;
        this._device = device;
        this._maxWidth = Math.max(1, maxWidth | 0);
        this._maxHeight = Math.max(1, maxHeight | 0);
        this._dispatchThreadIdToBufferUVScope = this._device.scope.resolve("uDispatchThreadIdToBufferUV");
        this._inputViewportMaxBoundScope = this._device.scope.resolve("uInputViewportMaxBound");
        this._readScreenDepthScope = this._device.scope.resolve("uReadScreenDepth");
        this._readLevelScope = this._device.scope.resolve("uReadLevel");
        this._invSizeScope = this._device.scope.resolve("uInvSize");
        this._depthMipScope = this._device.scope.resolve("uDepthMip");
        this._onDestroy = device.on("destroy", this.destroy, this);
        this._onContextLost = device.on("contextlost", this._onDeviceContextLost, this);
        this._readbackSlots = 4;
        this._minReadbackLatency = 2;
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

        this._disposeReadback();
        this._disposeGpu();

        this._resizePending = false;
        this._maxWidth = Math.max(1, maxWidth | 0);
        this._maxHeight = Math.max(1, maxHeight | 0);
        this._screenWidth = width | 0;
        this._screenHeight = height | 0;

        const numMipsX = Math.max(Math.ceil(Math.log2(Math.max(this._screenWidth, 2))) - 1, 1);
        const numMipsY = Math.max(Math.ceil(Math.log2(Math.max(this._screenHeight, 2))) - 1, 1);

        this._globalMipWidth = 1 << numMipsX;
        this._globalMipHeight = 1 << numMipsY;
        this._uvFactorX = this._screenWidth / (2 * this._globalMipWidth);
        this._uvFactorY = this._screenHeight / (2 * this._globalMipHeight);

        this._buildPassSizes();
        this._initShader();
        this._initRenders();
        this._initCpuTarget();
        this._initReadback();
    }

    public frameUpdate() {
        this._frameId++;
        this._pollReadback();
    }

    public update(camera: pc.Camera) {

        if (!this.enabled) {
            return;
        }

        this._pollReadback();

        const mainDepthTexture = getCameraDepthTexture(camera);
        if (!mainDepthTexture) {
            return;
        }

        if (mainDepthTexture.width !== this.screenWidth ||
            mainDepthTexture.height !== this.screenHeight) {
            this.resize(mainDepthTexture.width, mainDepthTexture.height);
        }

        this._viewProjection.mul2(camera.projectionMatrix, camera.viewMatrix);

        const device = this.device;
        const { vx, vy, vw, vh, sx, sy, sw, sh } = device;
        const oldRenderTarget = device.getRenderTarget();
        const passCount = this._passWidths.length;

        let srcBuffer = mainDepthTexture;
        let srcWidth = mainDepthTexture.width;
        let srcHeight = mainDepthTexture.height;
        let readScreenDepth = 1;

        _viewportMaxBoundArr[0] = (this.screenWidth - 0.5) / srcWidth;
        _viewportMaxBoundArr[1] = (this.screenHeight - 0.5) / srcHeight;

        for (let mip = 0; mip < passCount; mip++) {

            const destW = this._passWidths[mip];
            const destH = this._passHeights[mip];

            _invSizeArr[0] = 1 / srcWidth;
            _invSizeArr[1] = 1 / srcHeight;

            if (readScreenDepth) {
                _dispatchThreadIdToBufferUVArr[0] = 2 / srcWidth;
                _dispatchThreadIdToBufferUVArr[1] = 2 / srcHeight;
            }
            else {
                _dispatchThreadIdToBufferUVArr[0] = 1 / destW;
                _dispatchThreadIdToBufferUVArr[1] = 1 / destH;
            }
            _dispatchThreadIdToBufferUVArr[2] = 0;
            _dispatchThreadIdToBufferUVArr[3] = 0;

            this._inputViewportMaxBoundScope.setValue(_viewportMaxBoundArr);
            this._dispatchThreadIdToBufferUVScope.setValue(_dispatchThreadIdToBufferUVArr);
            this._invSizeScope.setValue(_invSizeArr);
            this._readScreenDepthScope.setValue(readScreenDepth);
            this._readLevelScope.setValue(0);
            this._depthMipScope.setValue(srcBuffer);

            this._quadRenderPasses[mip].render();

            readScreenDepth = 0;
            srcWidth = destW;
            srcHeight = destH;
            srcBuffer = this._buffers[mip];

            if (mip === 0) {
                _viewportMaxBoundArr[0] = 1;
                _viewportMaxBoundArr[1] = 1;
            }
        }

        this._blitPackedCpuTarget();

        device.setRenderTarget(oldRenderTarget);
        device.setViewport(vx, vy, vw, vh);
        device.setScissor(sx, sy, sw, sh);

        if (this._cpuReadback) {
            this._beginReadback();
        }
    }

    public destroy() {
        this._onDestroy?.off();
        this._onContextLost?.off();
        this._disposeReadback();
        this._disposeGpu();
    }

    protected _buildPassSizes() {

        this._passWidths = [];
        this._passHeights = [];

        let w = this._globalMipWidth;
        let h = this._globalMipHeight;

        while (true) {
            this._passWidths.push(w);
            this._passHeights.push(h);

            if (w <= this._maxWidth && h <= this._maxHeight) {
                break;
            }

            if (w > this._maxWidth) {
                w = Math.max(this._maxWidth, w >> 1);
            }
            if (h > this._maxHeight) {
                h = Math.max(this._maxHeight, h >> 1);
            }

            const last = this._passWidths.length - 1;
            if (w === this._passWidths[last] && h === this._passHeights[last]) {
                break;
            }
        }

        this._width = w;
        this._height = h;
        this._mipLevels = this._passWidths.length;
    }

    protected _initShader() {

        const defines = new Map();

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

        this._shader = pc.ShaderUtils.createShader(this._device, {
            uniqueName: "COVERAGE_HZB_SHADER",
            useTransformFeedback: false,
            vertexGLSL: vertexCodeVS,
            fragmentGLSL: fragmentCodePS,
            fragmentDefines: defines,
            attributes: {
                aPosition: pc.SEMANTIC_POSITION
            },
        });
    }

    protected _initRenders() {

        const passCount = this._passWidths.length;

        this._buffers = new Array(passCount);
        this._renderTargets = new Array(passCount);
        this._quadRenderPasses = new Array(passCount);

        const depthByColor = this.isColor();
        const format = (
            !depthByColor    ? pc.PIXELFORMAT_DEPTH :
            this.isFloat16() ? pc.PIXELFORMAT_R16F :
            this.isFloat32() ? pc.PIXELFORMAT_R32F :
                               pc.PIXELFORMAT_RGBA8
        );

        for (let mip = 0; mip < passCount; mip++) {

            const buffer = new pc.Texture(this._device, {
                name: "COVERAGE_HZB_TX_" + mip,
                width: this._passWidths[mip],
                height: this._passHeights[mip],
                format: format,
                mipmaps: false,
                minFilter: pc.FILTER_NEAREST,
                magFilter: pc.FILTER_NEAREST,
                addressU: pc.ADDRESS_CLAMP_TO_EDGE,
                addressV: pc.ADDRESS_CLAMP_TO_EDGE,
                storage: false,
            });

            const optsRt: ConstructorParameters<typeof pc.RenderTarget>[0] = {
                name: "COVERAGE_HZB_RT_LEVEL_" + mip,
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

            this._buffers[mip] = buffer;
            this._renderTargets[mip] = rt;
            this._quadRenderPasses[mip] = rps;
        }
    }

    protected _initCpuTarget() {

        const format = (
            this.isFloat16() ? pc.PIXELFORMAT_R16F :
            this.isFloat32() ? pc.PIXELFORMAT_R32F :
                               pc.PIXELFORMAT_RGBA8
        );

        this._cpuTexture = new pc.Texture(this._device, {
            name: "COVERAGE_CPU_TX",
            width: this._maxWidth,
            height: this._maxHeight,
            format: format,
            mipmaps: false,
            minFilter: pc.FILTER_NEAREST,
            magFilter: pc.FILTER_NEAREST,
            addressU: pc.ADDRESS_CLAMP_TO_EDGE,
            addressV: pc.ADDRESS_CLAMP_TO_EDGE,
            storage: false,
        });

        this._cpuRenderTarget = new pc.RenderTarget({
            name: "COVERAGE_CPU_RT",
            depth: false,
            autoResolve: false,
            colorBuffer: this._cpuTexture,
            stencil: false,
            samples: 1,
        });

        this._cpuBlitPass = new pc.RenderPassShaderQuad(this._device);
        this._cpuBlitPass.blendState = pc.BlendState.NOBLEND;
        this._cpuBlitPass.depthState = pc.DepthState.NODEPTH;
        this._cpuBlitPass.shader = this._shader;
        this._cpuBlitPass.init(this._cpuRenderTarget);
        this._cpuBlitPass.colorOps.clear = false;
        this._cpuBlitPass.colorOps.genMipmaps = false;
    }

    protected _blitPackedCpuTarget() {

        // Pack the used coverage region (uv * uvFactor) into a 256×128 target so
        // CPU pixels map to the full screen: ndc = (pixel + 0.5) / size * 2 - 1.

        _invSizeArr[0] = 1 / this._width;
        _invSizeArr[1] = 1 / this._height;

        _dispatchThreadIdToBufferUVArr[0] = this._uvFactorX / this._maxWidth;
        _dispatchThreadIdToBufferUVArr[1] = this._uvFactorY / this._maxHeight;
        _dispatchThreadIdToBufferUVArr[2] = 0;
        _dispatchThreadIdToBufferUVArr[3] = 0;

        _viewportMaxBoundArr[0] = this._uvFactorX;
        _viewportMaxBoundArr[1] = this._uvFactorY;

        this._inputViewportMaxBoundScope.setValue(_viewportMaxBoundArr);
        this._dispatchThreadIdToBufferUVScope.setValue(_dispatchThreadIdToBufferUVArr);
        this._invSizeScope.setValue(_invSizeArr);
        this._readScreenDepthScope.setValue(0);
        this._readLevelScope.setValue(0);
        this._depthMipScope.setValue(this.texture);

        this._cpuBlitPass.render();
    }

    protected _initReadback() {

        this._disposeReadback();

        const bytes = this._maxWidth * this._maxHeight * 4;
        this._cpuDepth = new Float32Array(this._maxWidth * this._maxHeight);
        this._cpuDepth.fill(1);
        this._cpuReady = false;
        this._cpuVersion = 0;

        this._slots = new Array(this._readbackSlots);
        for (let i = 0; i < this._readbackSlots; i++) {
            this._slots[i] = this._createSlot(bytes);
        }
    }

    protected _beginReadback() {

        if (this._submitFrame === this._frameId) {
            return;
        }

        const slot = this._findFreeSlot();
        const rt = this._cpuRenderTarget;
        if (!slot || !rt) {
            return;
        }

        const device = this._glDevice();
        const gl = device.gl;
        if (!gl) {
            return;
        }

        if (slot.unread) {
            this._deletePbo(slot);
        }

        if (!slot.pbo) {
            this._ensureSlotPbo(slot);
        }
        else {
            this._orphanPbo(slot);
        }

        if (!slot.pbo) {
            return;
        }

        this._submitFrame = this._frameId;

        slot.vp.set(this._viewProjection.data);
        slot.uvFactor[0] = 1;
        slot.uvFactor[1] = 1;
        slot.submitFrame = this._frameId;
        slot.pending = true;
        slot.unread = true;
        slot.ready = false;

        // PlayCanvas setRenderTarget() only stores the JS field. readPixels
        // needs the GL framebuffer bound, same as device.readTextureAsync.
        const oldRt = device.getRenderTarget();
        const prevFb = device.activeFramebuffer;
        device.setRenderTarget(rt);
        device.initRenderTarget(rt);
        device.setFramebuffer(rt.impl._glFrameBuffer);

        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
        gl.readPixels(0, 0, this._maxWidth, this._maxHeight, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

        this._deleteSync(slot);
        slot.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (!slot.sync) {
            this._deletePbo(slot);
            slot.pending = false;
            slot.unread = false;
        }
        else {
            gl.flush();
        }

        device.setRenderTarget(oldRt);
        device.setFramebuffer(prevFb);
    }

    protected _pollReadback() {

        let newest = -1;

        for (let i = 0; i < this._slots.length; i++) {

            const slot = this._slots[i];
            if (!slot.pending) {
                continue;
            }

            this._pollSlot(slot);

            if (slot.ready && (newest < 0 || slot.submitFrame > this._slots[newest].submitFrame)) {
                newest = i;
            }
        }

        if (newest < 0) {
            return;
        }

        const slot = this._slots[newest];

        decodeRgba8Depth(slot.rgba, this._cpuDepth);

        this._cpuVP.set(slot.vp);
        this._cpuUvFactor.set(slot.uvFactor);
        this._cpuReady = true;
        this._cpuVersion++;

        for (let i = 0; i < this._slots.length; i++) {
            if (this._slots[i].ready && this._slots[i].submitFrame <= slot.submitFrame) {
                this._recycleSlot(this._slots[i]);
            }
        }
    }

    private _pollSlot(slot: ICoverageReadbackSlot) {

        if (!slot.sync) {
            this._failSlot(slot);
            return;
        }

        if (this._frameId - slot.submitFrame < this._minReadbackLatency) {
            return;
        }

        const gl = this._device.gl;
        const res = gl.clientWaitSync(slot.sync, 0, 0);
        if (res === gl.TIMEOUT_EXPIRED) {
            return;
        }

        if (res === gl.WAIT_FAILED || !slot.pbo) {
            this._failSlot(slot);
            return;
        }

        gl.bindBuffer(gl.COPY_READ_BUFFER, slot.pbo);
        gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, slot.rgba, 0, slot.rgba.length);
        gl.bindBuffer(gl.COPY_READ_BUFFER, null);

        this._deleteSync(slot);
        slot.unread = false;
        slot.ready = true;
    }

    private _findFreeSlot(): ICoverageReadbackSlot | null {
        for (let i = 0; i < this._slots.length; i++) {
            const slot = this._slots[i];
            if (!slot.pending && !slot.unread) {
                return slot;
            }
        }
        return null;
    }

    private _glDevice() {
        return this._device as pc.WebglGraphicsDevice & {
            initRenderTarget(rt: pc.RenderTarget): void;
            setFramebuffer(fb: WebGLFramebuffer | null): void;
            activeFramebuffer: WebGLFramebuffer | null;
        };
    }

    private _ensureSlotPbo(slot: ICoverageReadbackSlot) {
        if (slot.pbo) {
            return;
        }

        const gl = this._device.gl;
        if (!gl) {
            return;
        }

        const pbo = gl.createBuffer();
        slot.pbo = pbo;
        if (pbo) {
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
            gl.bufferData(gl.PIXEL_PACK_BUFFER, slot.pboBytes, gl.STREAM_READ);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        }
    }

    private _orphanPbo(slot: ICoverageReadbackSlot) {
        const gl = this._device.gl;
        if (!gl || !slot.pbo) {
            return;
        }

        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, slot.pboBytes, gl.STREAM_READ);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }

    private _deletePbo(slot: ICoverageReadbackSlot) {
        this._deleteSync(slot);
        if (slot.pbo) {
            this._device.gl?.deleteBuffer(slot.pbo);
            slot.pbo = null;
        }
        slot.unread = false;
    }

    private _failSlot(slot: ICoverageReadbackSlot) {
        this._deletePbo(slot);
        slot.pending = false;
        slot.ready = false;
    }

    private _createSlot(bytes: number): ICoverageReadbackSlot {

        const slot: ICoverageReadbackSlot = {
            rgba: new Uint8Array(bytes),
            vp: new Float32Array(16),
            uvFactor: new Float32Array(2),
            pbo: null,
            pboBytes: bytes,
            sync: null,
            pending: false,
            unread: false,
            ready: false,
            submitFrame: 0
        };

        this._ensureSlotPbo(slot);
        return slot;
    }

    private _recycleSlot(slot: ICoverageReadbackSlot) {
        slot.pending = false;
        slot.ready = false;
        slot.unread = false;
        this._deleteSync(slot);
    }

    private _deleteSync(slot: ICoverageReadbackSlot) {
        if (slot.sync) {
            this._device.gl?.deleteSync(slot.sync);
            slot.sync = null;
        }
    }

    private _onDeviceContextLost() {
        for (let i = 0; i < this._slots.length; i++) {
            const slot = this._slots[i];
            this._deleteSync(slot);
            slot.pbo = null;
            slot.pending = false;
            slot.unread = false;
            slot.ready = false;
        }
        this._cpuReady = false;
    }

    protected _disposeReadback() {

        for (let i = 0; i < this._slots.length; i++) {
            this._deletePbo(this._slots[i]);
            this._slots[i].pending = false;
            this._slots[i].ready = false;
        }

        this._slots.length = 0;
        this._cpuReady = false;
    }

    protected _disposeGpu() {

        if (this._resizeTimeout) {
            clearTimeout(this._resizeTimeout);
            this._resizeTimeout = null;
        }

        this._resizePending = false;
        this._quadRenderPasses?.forEach(x => x?.destroy());
        this._cpuBlitPass?.destroy();
        this._renderTargets?.forEach(x => x?.destroy());
        this._cpuRenderTarget?.destroy();

        const destroyed = new Set<pc.Texture>();
        const destroyTex = (tex?: pc.Texture | null) => {
            if (tex && !destroyed.has(tex)) {
                destroyed.add(tex);
                tex.destroy();
            }
        };

        this._buffers?.forEach(destroyTex);
        destroyTex(this._cpuTexture);
        this._shader?.destroy();
    }
}

function decodeRgba8Depth(rgba: Uint8Array, dest: Float32Array) {
    const n = dest.length << 2;
    const src = rgba;
    const dst = new Uint8Array(dest.buffer, dest.byteOffset, n);
    for (let i = 0; i < n; i += 4) {
        dst[i]     = src[i + 3];
        dst[i + 1] = src[i + 2];
        dst[i + 2] = src[i + 1];
        dst[i + 3] = src[i];
    }
}

const _invSizeArr = new Float32Array(2);
const _viewportMaxBoundArr = new Float32Array(2);
const _dispatchThreadIdToBufferUVArr = new Float32Array(4);
