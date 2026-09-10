import pc from "../../../engine.js";
import { ICoverageBuffer } from "../ICoverageBuffer.js";
import computeCodeCS from "./WebgpuCoverageBuffer.comp.wgsl.js";
import { getCameraDepthTexture, writeCameraParams } from "../../../Extras/CameraHelpers.js";
import { CoverageGpuReadbackQueue } from "./CoverageGpuReadbackQueue.js";
import { integerLog2 } from "../CoverageCpuBuffer.js";

const workgroupSize = 8;

/**
 * WebGPU coverage depth buffer.
 *
 * Downsamples camera depth with a 4-tap max chain that keeps the
 * 256∶128 aspect at every level. The last level is packed with a compute
 * shader (float view-space Z). GPU→CPU download lives in {@link CoverageGpuReadbackQueue}.
 */
export class WebgpuCoverageBuffer implements ICoverageBuffer {

    private _enabled: boolean;
    private _cpuReadback: boolean;
    private _resizePending: boolean;
    private _resizeTimeout: ReturnType<typeof setTimeout> | null;
    private _device: pc.WebgpuGraphicsDevice;
    private _buffers: pc.Texture[];
    private _bufferViews: pc.TextureView[];
    private _readback: CoverageGpuReadbackQueue;

    private _downsampleFromScreen: pc.Compute | null;
    private _downsampleFromColor: pc.Compute | null;
    private _packFromScreen: pc.Compute | null;
    private _packFromColor: pc.Compute | null;
    private _shaders: pc.Shader[] = [];

    private _screenWidth: number;
    private _screenHeight: number;

    private _maxWidth: number;
    private _maxHeight: number;
    private _width: number;
    private _height: number;
    private _mipLevels: number;
    private _passWidths: number[];
    private _passHeights: number[];

    private _viewProjection = new pc.Mat4();
    private _maxDownsampleStages: number;
    private _onDestroy: pc.EventHandle;

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

    /** Last GPU downsample target. The packed 256×128 download is {@link cpuDepth}, not a texture. */
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
     * @param device - WebGPU device
     * @param maxWidth - CPU width, default 256
     * @param maxHeight - CPU height, default 128
     */
    constructor(device: pc.WebgpuGraphicsDevice, maxWidth: number = 256, maxHeight: number = 128) {
        this._enabled = true;
        this._cpuReadback = true;
        this._resizePending = false;
        this._resizeTimeout = null;
        this._device = device;
        this._maxWidth = Math.max(1, maxWidth | 0);
        this._maxHeight = Math.max(1, maxHeight | 0);
        this._onDestroy = device.on("destroy", this.destroy, this);
        this._maxDownsampleStages = 4;
        this._readback = new CoverageGpuReadbackQueue(device, this._maxWidth * this._maxHeight, 4);
        this._readback.minReadbackLag = 2;
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
        this._initCompute();
        this._initRenders();
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

        const passCount = this._passWidths.length;
        const quadCount = Math.max(0, passCount - 1);

        let srcBuffer: pc.Texture | pc.TextureView = mainDepthTexture;
        let srcWidth = mainDepthTexture.width;
        let srcHeight = mainDepthTexture.height;
        let readScreenDepth = 1;

        _srcUvMaxArr[0] = (this.screenWidth - 0.5) / srcWidth;
        _srcUvMaxArr[1] = (this.screenHeight - 0.5) / srcHeight;

        for (let mip = 0; mip < quadCount; mip++) {

            const destW = this._passWidths[mip];
            const destH = this._passHeights[mip];

            this._dispatchDownsample(
                srcBuffer,
                srcWidth,
                srcHeight,
                destW,
                destH,
                readScreenDepth,
                this._bufferViews[mip]
            );

            readScreenDepth = 0;
            srcWidth = destW;
            srcHeight = destH;
            srcBuffer = this._bufferViews[mip];

            if (mip === 0) {
                _srcUvMaxArr[0] = (srcWidth - 0.5) / srcWidth;
                _srcUvMaxArr[1] = (srcHeight - 0.5) / srcHeight;
            }
        }

        if (this._cpuReadback) {
            this._pack(srcBuffer, srcWidth, srcHeight, readScreenDepth);
        }
    }

    public destroy() {
        this._onDestroy?.off();
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

        defines.set("{DST_DEPTH_FORMAT}", this._dstStorageFormat());

        return defines;
    }

    private _dstStorageFormat() {
        if (this.isFloat16()) {
            return "r16float";
        }
        if (this.isFloat32()) {
            return "r32float";
        }
        return "rgba8unorm";
    }

    private _textureFormat() {
        if (!this.isColor()) {
            return pc.PIXELFORMAT_DEPTH;
        }
        if (this.isFloat16()) {
            return pc.PIXELFORMAT_R16F;
        }
        if (this.isFloat32()) {
            return pc.PIXELFORMAT_R32F;
        }
        return pc.PIXELFORMAT_RGBA8;
    }

    private _uniformBufferFormat() {
        return {
            ub: new pc.UniformBufferFormat(this._device, [
                new pc.UniformFormat("readScreenDepth", pc.UNIFORMTYPE_INT),
                new pc.UniformFormat("invSrcSize", pc.UNIFORMTYPE_VEC2),
                new pc.UniformFormat("destPixelToUv", pc.UNIFORMTYPE_VEC2),
                new pc.UniformFormat("srcUvMax", pc.UNIFORMTYPE_VEC2),
                new pc.UniformFormat("destSize", pc.UNIFORMTYPE_VEC2),
                new pc.UniformFormat("padDest", pc.UNIFORMTYPE_VEC2),
                new pc.UniformFormat("cameraParams", pc.UNIFORMTYPE_VEC4)
            ])
        };
    }

    private _createCompute(pack: boolean, fromScreen: boolean) {

        const defines = this._coverageDefines();
        if (pack) {
            defines.set("PACK_TO_BUFFER", "");
        }

        const sampleType = fromScreen
            ? pc.SAMPLETYPE_UNFILTERABLE_FLOAT
            : pc.SAMPLETYPE_FLOAT;

        const formats: Array<
            pc.BindUniformBufferFormat | pc.BindTextureFormat | pc.BindStorageTextureFormat | pc.BindStorageBufferFormat
        > = [
            new pc.BindUniformBufferFormat("ub", pc.SHADERSTAGE_COMPUTE),
            new pc.BindTextureFormat(
                "srcDepth",
                pc.SHADERSTAGE_COMPUTE,
                pc.TEXTUREDIMENSION_2D,
                sampleType,
                true,
                "srcDepthSampler"
            )
        ];

        if (pack) {
            formats.push(new pc.BindStorageBufferFormat("outDepth", pc.SHADERSTAGE_COMPUTE));
        }
        else {
            formats.push(new pc.BindStorageTextureFormat(
                "dstDepth",
                this._textureFormat(),
                pc.TEXTUREDIMENSION_2D,
                true,
                false
            ));
        }

        const shader = new pc.Shader(this._device, {
            name: pack
                ? (fromScreen ? "CoveragePackFromScreen" : "CoveragePackFromColor")
                : (fromScreen ? "CoverageDownsampleFromScreen" : "CoverageDownsampleFromColor"),
            shaderLanguage: pc.SHADERLANGUAGE_WGSL,
            cshader: computeCodeCS,
            cdefines: defines,
            cincludes: pc.ShaderChunks.get(this._device, pc.SHADERLANGUAGE_WGSL),
            computeUniformBufferFormats: this._uniformBufferFormat(),
            computeBindGroupFormat: new pc.BindGroupFormat(this._device, formats)
        });

        this._shaders.push(shader);

        return new pc.Compute(
            this._device,
            shader,
            shader.name
        );
    }

    protected _initCompute() {

        this._downsampleFromScreen = this._createCompute(false, true);
        this._downsampleFromColor = this._createCompute(false, false);
        this._packFromScreen = this._createCompute(true, true);
        this._packFromColor = this._createCompute(true, false);
    }

    protected _initRenders() {

        const quadCount = Math.max(0, this._passWidths.length - 1);

        this._buffers = new Array(quadCount);
        this._bufferViews = new Array(quadCount);
        this._mipLevels = quadCount;

        const format = this._textureFormat();

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
                storage: true,
            });

            buffer.upload();

            this._buffers[i] = buffer;
            this._bufferViews[i] = buffer.getView(0);
        }
    }

    private _setPassParams(
        compute: pc.Compute,
        srcBuffer: pc.Texture | pc.TextureView,
        srcWidth: number,
        srcHeight: number,
        destW: number,
        destH: number,
        readScreenDepth: number
    ) {

        _invSrcSizeArr[0] = 1 / srcWidth;
        _invSrcSizeArr[1] = 1 / srcHeight;
        _destPixelToUvArr[0] = 1 / destW;
        _destPixelToUvArr[1] = 1 / destH;
        _destSizeArr[0] = destW;
        _destSizeArr[1] = destH;

        compute.setParameter("srcUvMax", _srcUvMaxArr);
        compute.setParameter("destPixelToUv", _destPixelToUvArr);
        compute.setParameter("invSrcSize", _invSrcSizeArr);
        compute.setParameter("destSize", _destSizeArr);
        compute.setParameter("padDest", _padDestArr);
        compute.setParameter("cameraParams", _cameraParamsArr);
        compute.setParameter("readScreenDepth", readScreenDepth);
        compute.setParameter("srcDepth", srcBuffer);
        compute.setupDispatch(
            Math.ceil(destW / workgroupSize),
            Math.ceil(destH / workgroupSize)
        );
    }

    private _dispatchDownsample(
        srcBuffer: pc.Texture | pc.TextureView,
        srcWidth: number,
        srcHeight: number,
        destW: number,
        destH: number,
        readScreenDepth: number,
        dstView: pc.TextureView
    ) {

        const compute = readScreenDepth ? this._downsampleFromScreen : this._downsampleFromColor;
        if (!compute) {
            return;
        }

        this._setPassParams(compute, srcBuffer, srcWidth, srcHeight, destW, destH, readScreenDepth);
        compute.setParameter("dstDepth", dstView);

        _dispatchList[0] = compute;

        this._device.computeDispatch(_dispatchList, compute.name);
    }

    protected _pack(
        srcBuffer: pc.Texture | pc.TextureView,
        srcWidth: number,
        srcHeight: number,
        readScreenDepth: number
    ) {

        const slot = this._readback.acquire();
        const compute = readScreenDepth ? this._packFromScreen : this._packFromColor;
        if (!slot || !compute) {
            return;
        }

        slot.beforeFill();
        const outputBuffer = slot.outputBuffer;
        if (!outputBuffer) {
            return;
        }

        const destW = this._maxWidth;
        const destH = this._maxHeight;

        this._setPassParams(compute, srcBuffer, srcWidth, srcHeight, destW, destH, readScreenDepth);
        compute.setParameter("outDepth", outputBuffer);

        _dispatchList[0] = compute;

        this._device.computeDispatch(_dispatchList, compute.name);
        this._readback.submit(slot, this._viewProjection.data, _cameraParamsArr);
    }

    protected _disposeGpu() {

        if (this._resizeTimeout) {
            clearTimeout(this._resizeTimeout);
            this._resizeTimeout = null;
        }

        this._resizePending = false;
        this._downsampleFromScreen?.destroy();
        this._downsampleFromColor?.destroy();
        this._packFromScreen?.destroy();
        this._packFromColor?.destroy();
        this._downsampleFromScreen = null;
        this._downsampleFromColor = null;
        this._packFromScreen = null;
        this._packFromColor = null;
        this._shaders.forEach(x => x?.destroy());
        this._shaders.length = 0;
        this._buffers?.forEach(x => x?.destroy());
        this._bufferViews = [];
        this._buffers = [];
    }
}

const UV_FACTOR: [number, number] = [1, 1];
const _dispatchList: pc.Compute[] = [null!];
const _invSrcSizeArr = new Float32Array(2);
const _destPixelToUvArr = new Float32Array(2);
const _destSizeArr = new Float32Array(2);
const _padDestArr = new Float32Array(2);
const _srcUvMaxArr = new Float32Array(2);
const _cameraParamsArr = new Float32Array(4);
