import pc from "../../../engine.js";
import type { IHierarchicalZBuffer } from "../IHierarchicalZBuffer.js";
import vertexCodeVS from "./WebgpuHierarchicalZBuffer.vert.wgsl.js";
import fragmentCodePS from "./WebgpuHierarchicalZBuffer.frag.wgsl.js";
import computeCodeCS from "./WebgpuHierarchicalZBuffer.comp.wgsl.js";
import { CAMERA_DEPTH_DEVICE, applyCameraDepthDefines, getCameraDepthTexture, getCameraSceneDepthMode, writeCameraParams } from "../../../Extras/CameraHelpers.js";

const workgroupSizeX: number = 8;
const workgroupSizeY: number = 8;

export class WebgpuHierarchicalZBuffer implements IHierarchicalZBuffer {

    private _debugName: string = 'HZB';
    private _enabled: boolean = false;
    private _device: pc.WebgpuGraphicsDevice;
    private _screenWidth: number = 0;
    private _screenHeight: number = 0;
    private _width: number = 0;
    private _height: number = 0;
    private _mipLevels: number = 0;
    private _blankTexture: pc.Texture | null = null;
    private _blankTextureView: pc.TextureView[];
    private _maxMipBatchSize: number = 4;
    private _useCompute: boolean = true;

    private _mainScreenDepthTexture: pc.Texture | null = null;
    private _depthMode = CAMERA_DEPTH_DEVICE;
    private _sourceSampleType: number = pc.SAMPLETYPE_UNFILTERABLE_FLOAT;
    /** Last source variant uploaded into the compute batches. Empty for the depth-grab shader. */
    private _boundSourceKey = "";

    private _texture: pc.Texture | null = null;
    private _textureViews: pc.TextureView[] = [];

    private _batchShaders = new Map<string, pc.Shader>();
    /** First-batch computes for CameraFrame and non-depth textures. Depth grab uses `_computeMips`. */
    private _sourceComputes = new Map<string, pc.Compute>();
    private _computeMips: pc.Compute[] = [];

    private _pixelShader: pc.Shader | null = null;
    private _pixelShaders = new Map<string, pc.Shader>();
    private _boundPixelKey = "";
    private _pixelRenders: pc.RenderPassShaderQuad[] = [];
    private _cameraParamsScope: pc.ScopeId;

    private _dispatchThreadIdToBufferUVScope: pc.ScopeId;
    private _inputViewportMaxBoundScope: pc.ScopeId;
    private _invSizeScope: pc.ScopeId;
    private _readScreenDepthScope: pc.ScopeId;
    private _readLevelScope: pc.ScopeId;
    private _srcDepthScope: pc.ScopeId;

    public get enabled() { return this._enabled; }
    public set enabled(value) { this._enabled = value; }
    public get screenWidth() { return this._screenWidth; }
    public get screenHeight() { return this._screenHeight; }
    public get width() { return this._width; }
    public get height() { return this._height; }
    public get device() { return this._device; }
    public get buffers() { return undefined; }
    public get texture() { return this._texture; }
    public get mipLevels() { return this._mipLevels; }

    public get useCompute() { return this._useCompute; }
    public set useCompute(value) {
        this._useCompute = value;
        this._dispose();
        this._init();
    }

    public get maxMipBatchSize() { return this._maxMipBatchSize; }
    public set maxMipBatchSize(value: number) {
        this._maxMipBatchSize = this.getSafeMipBatchSize(value);
        this._dispose();
        this._init();
    }

    public get uvFactor(): [number, number] {
        return [
            this.screenWidth  / (2 * this.width),
            this.screenHeight / (2 * this.height)
        ];
    }

    public constructor(device: pc.WebgpuGraphicsDevice, useCompute: boolean = true, maxMipBatchSize: number = 4, debugName?: string) {

        this._device = device;
        this._useCompute = useCompute;
        this._maxMipBatchSize = this.getSafeMipBatchSize(maxMipBatchSize);
        this._debugName = debugName ?? this._debugName;

        this._init(this.device.width, this.device.height);
        this._updateComputeParameters();
        this._enabled = true;
    }

    public getSafeMipBatchSize(value: number) {
        if (value < 1 || value > 4) {
            console.warn('HZB mip batch size must be 1 or 2 or 3 or 4]');
        }
        return Math.max(1, Math.min(Math.floor(value), 4));
    }

    public getTextureFormat() {

        // TODO: webgpu supported ?
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

    protected _dispose() {
        this._mainScreenDepthTexture = null;
        this._boundSourceKey = "";
        this._boundPixelKey = "";
        this._computeMips?.forEach(x => x?.destroy());
        this._sourceComputes.forEach((compute) => compute.destroy());
        this._sourceComputes.clear();
        this._batchShaders.forEach((shader) => shader.destroy());
        this._batchShaders.clear();
        this._pixelRenders?.forEach(x => x?.destroy());
        this._pixelShaders.forEach((shader) => shader.destroy());
        this._pixelShaders.clear();
        this._pixelShader = null;
        this._blankTexture?.destroy();
        this._texture?.destroy();
    }

    protected _init(width: number = this.screenWidth, height: number = this.screenHeight) {

        this._screenWidth = width | 0;
        this._screenHeight = height | 0;

        const numMipsX = Math.max(Math.ceil(Math.log2(this._screenWidth)) - 1, 1);
        const numMipsY = Math.max(Math.ceil(Math.log2(this._screenHeight)) - 1, 1);
        const numMips  = Math.max(numMipsX, numMipsY);

        this._width  = 1 << numMipsX;
        this._height = 1 << numMipsY;
        this._mipLevels = numMips;

        const textureFormat = this.getTextureFormat();

        this._texture = new pc.Texture(this.device, {
            name: 'HZBTexture',
            width: this._width,
            height: this._height,
            format: textureFormat,
            mipmaps: true,
            numLevels: this._mipLevels,
            minFilter: pc.FILTER_NEAREST_MIPMAP_NEAREST,
            magFilter: pc.FILTER_NEAREST,
            addressU: pc.ADDRESS_CLAMP_TO_EDGE,
            addressV: pc.ADDRESS_CLAMP_TO_EDGE,
            addressW: pc.ADDRESS_CLAMP_TO_EDGE,
            storage: true,
        });

        this._texture.upload();
        this._textureViews = new Array(this._mipLevels);

        for (let i = 0; i < this._mipLevels; i++) {
            this._textureViews[i] = this._texture.getView(i);
        }

        if (this._useCompute) this._initCompute();
        else                  this._initPixel();
    }

    protected _initPixel() {

        if (!this._texture) {
            return;
        }

        this._dispatchThreadIdToBufferUVScope = this._device.scope.resolve("uDispatchThreadIdToBufferUV");
        this._inputViewportMaxBoundScope = this._device.scope.resolve("uInputViewportMaxBound");
        this._readScreenDepthScope = this._device.scope.resolve("uReadScreenDepth");
        this._readLevelScope = this._device.scope.resolve("uReadLevel");
        this._invSizeScope = this._device.scope.resolve("uInvSize");
        this._srcDepthScope = this._device.scope.resolve("srcDepth");
        this._cameraParamsScope = this._device.scope.resolve("uCameraParams");

        this._pixelShader = this._ensurePixelShader(CAMERA_DEPTH_DEVICE, pc.SAMPLETYPE_UNFILTERABLE_FLOAT);
        this._boundPixelKey = `${CAMERA_DEPTH_DEVICE}|${pc.SAMPLETYPE_UNFILTERABLE_FLOAT}`;

        this._pixelRenders = new Array(this._mipLevels);

        for (let mip = 0; mip < this._mipLevels; mip++) {

            const optsRt: ConstructorParameters<typeof pc.RenderTarget>[0] = {
                name: 'HZB_RT_LEVEL_' + mip,
                depth: false,
                autoResolve: false,
                mipLevel: mip,
                colorBuffer: this._texture,
                stencil: false,
                samples: 1,
            };

            const rt = new pc.RenderTarget(optsRt);
            const rp = new pc.RenderPassShaderQuad(this._device);

            rp.blendState = pc.BlendState.NOBLEND;
            rp.depthState = pc.DepthState.NODEPTH;
            rp.shader = this._pixelShader;
            rp.init(rt);
            rp.colorOps.clear = true;
            rp.colorOps.genMipmaps = false;

            this._pixelRenders[mip] = rp;
        }
    }

    protected _initCompute() {

        const textureFormat = this.getTextureFormat();

        this._blankTexture = new pc.Texture(this.device, {
            name: 'HZBBlankTexture',
            width: 16,
            height: 16,
            format: textureFormat,
            mipmaps: true,
            numLevels: 4,
            minFilter: pc.FILTER_NEAREST_MIPMAP_NEAREST,
            magFilter: pc.FILTER_NEAREST,
            addressU: pc.ADDRESS_CLAMP_TO_EDGE,
            addressV: pc.ADDRESS_CLAMP_TO_EDGE,
            addressW: pc.ADDRESS_CLAMP_TO_EDGE,
            storage: true,
        });

        this._blankTexture.upload();
        this._blankTextureView = [
            this._blankTexture.getView(0),
            this._blankTexture.getView(1),
            this._blankTexture.getView(2),
            this._blankTexture.getView(3)
        ];

        this._computeMips = new Array(Math.ceil(this._mipLevels / this.maxMipBatchSize));

        for (let startDestMip = 0; startDestMip < this._mipLevels; startDestMip += this.maxMipBatchSize) {

            const endDestMip = Math.min(startDestMip + this.maxMipBatchSize, this._mipLevels);
            const levelCount = endDestMip - startDestMip;
            const index = startDestMip / this.maxMipBatchSize;
            const shader = this._batchShader(levelCount, CAMERA_DEPTH_DEVICE, pc.SAMPLETYPE_UNFILTERABLE_FLOAT);

            this._computeMips[index] = new pc.Compute(
                this.device,
                shader,
                'HZBComputeMipBatch' + index
            );
        }
    }

    private _ensurePixelShader(depthMode: number, sampleType: number) {
        const key = `${depthMode}|${sampleType}`;
        const existing = this._pixelShaders.get(key);
        if (existing) {
            return existing;
        }

        const defines = new Map<string, string>();
        let workaroundForFloat = false;

        if (this.isFloat16()) {
            defines.set('DEPTH_IS_FLOAT16', '');
        }
        else if (this.isFloat32()) {
            defines.set('DEPTH_IS_FLOAT', '');
        }
        else {
            workaroundForFloat = true;
        }

        if (this.device.textureFloatRenderable) {
            defines.set('SCENE_DEPTHMAP_FLOAT', '');
        }
        else {
            workaroundForFloat = true;
        }

        if (workaroundForFloat) {
            defines.set('FLOAT_WORKAROUND', '');
        }

        const srcFormat = sampleType === pc.SAMPLETYPE_UNFILTERABLE_FLOAT
            ? (this.isFloat16() ? 'f16' : 'uff')
            : 'f32';
        defines.set('{SRC_DEPTH_FORMAT}', srcFormat);
        applyCameraDepthDefines(defines, depthMode);

        const shader = pc.ShaderUtils.createShader(this._device, {
            uniqueName: 'HZB_PIXEL_SHADER_' + key,
            vertexWGSL: vertexCodeVS,
            fragmentWGSL: fragmentCodePS,
            fragmentDefines: defines,
            attributes: {
                aPosition: pc.SEMANTIC_POSITION
            },
        });
        this._pixelShaders.set(key, shader);
        return shader;
    }

    private _bindPixelShader(depthMode: number, sampleType: number) {
        const key = `${depthMode}|${sampleType}`;
        if (this._boundPixelKey === key) {
            return;
        }
        const shader = this._ensurePixelShader(depthMode, sampleType);
        const passes = this._pixelRenders;
        for (let i = 0; i < passes.length; i++) {
            passes[i].shader = shader;
        }
        this._pixelShader = shader;
        this._boundPixelKey = key;
    }

    private _batchShader(levelCount: number, depthMode: number, sampleType: number) {
        const key = `${levelCount}|${depthMode}|${sampleType}`;
        const existing = this._batchShaders.get(key);
        if (existing) {
            return existing;
        }

        const textureFormat = this.getTextureFormat();
        const defines = new Map<string, string>();
        defines.set('{SRC_DEPTH_FORMAT}', this.isFloat16() ? 'f16' : 'f32');
        defines.set('{DST_DEPTH_FORMAT}',
            this.isFloat16() ? 'r16float' :
            this.isFloat32() ? 'r32float' :
                               'rgba8unorm'
        );
        if (this.isFloat16()) {
            defines.set('DEPTH_IS_FLOAT16', '');
        }
        else if (this.isFloat32()) {
            defines.set('DEPTH_IS_FLOAT', '');
        }
        defines.set('{DIM_MIP_LEVEL_COUNT}', levelCount.toFixed(0));
        defines.set('DIM_MIP_LEVEL_COUNT', levelCount.toFixed(0));
        defines.set('DIM_FURTHEST', '');
        applyCameraDepthDefines(defines, depthMode);

        const uniformFormats = [
            new pc.UniformFormat('readScreenDepth', pc.UNIFORMTYPE_INT),
            new pc.UniformFormat('invSize', pc.UNIFORMTYPE_VEC2),
            new pc.UniformFormat('inputViewportMaxBound', pc.UNIFORMTYPE_VEC2),
            new pc.UniformFormat('dispatchThreadIdToBufferUV', pc.UNIFORMTYPE_VEC4)
        ];
        if (depthMode !== CAMERA_DEPTH_DEVICE) {
            uniformFormats.push(new pc.UniformFormat('cameraParams', pc.UNIFORMTYPE_VEC4));
        }

        const formats = [
            new pc.BindUniformBufferFormat('ub', pc.SHADERSTAGE_COMPUTE),
            new pc.BindTextureFormat('srcDepth', pc.SHADERSTAGE_COMPUTE, pc.TEXTUREDIMENSION_2D, sampleType, true, 'srcDepthSampler'),
        ];
        for (let level = 0; level < levelCount; level++) {
            formats.push(new pc.BindStorageTextureFormat('dstDepth' + level, textureFormat, pc.TEXTUREDIMENSION_2D, true, false));
        }

        const shader = new pc.Shader(this.device, {
            name: 'HZBComputeShaderBatch' + key,
            shaderLanguage: pc.SHADERLANGUAGE_WGSL,
            cshader: computeCodeCS,
            cdefines: defines,
            cincludes: pc.ShaderChunks.get(this.device, pc.SHADERLANGUAGE_WGSL),
            // @ts-ignore
            computeUniformBufferFormats: {
                ub: new pc.UniformBufferFormat(this.device, uniformFormats)
            },
            computeBindGroupFormat: new pc.BindGroupFormat(this.device, formats)
        });
        this._batchShaders.set(key, shader);
        return shader;
    }

    /** Depth grab, sampled as unfilterable float. The default mip shaders already do this. */
    private _usesDefaultSourceShader() {
        return this._depthMode === CAMERA_DEPTH_DEVICE
            && this._sourceSampleType === pc.SAMPLETYPE_UNFILTERABLE_FLOAT;
    }

    private _firstBatchLevelCount() {
        return Math.min(this.maxMipBatchSize, this._mipLevels);
    }

    /** Empty when the default depth-grab shader is the right first batch. */
    private _sourceKey() {
        const levelCount = this._firstBatchLevelCount();
        if (levelCount < 1 || this._usesDefaultSourceShader()) {
            return "";
        }
        return `${levelCount}|${this._depthMode}|${this._sourceSampleType}`;
    }

    /**
     * Compute for the first mip batch.
     * That batch samples the camera texture. Later batches read HZB mips, which are already device Z.
     */
    private _firstBatchCompute() {
        const key = this._sourceKey();
        if (!key || !this._useCompute) {
            return this._computeMips[0];
        }

        const cached = this._sourceComputes.get(key);
        if (cached) {
            return cached;
        }

        const compute = new pc.Compute(
            this.device,
            this._batchShader(this._firstBatchLevelCount(), this._depthMode, this._sourceSampleType),
            "HZBSourceDepth" + key
        );
        this._sourceComputes.set(key, compute);
        return compute;
    }

    private _applyBatch(
        compute: pc.Compute,
        startDestMip: number,
        readScreenDepth: number,
        srcWidth: number,
        srcHeight: number,
        srcTexture: pc.Texture | pc.TextureView,
        viewportMaxBound: number[]
    ) {
        const dstTexture0 = this._textureViews[startDestMip + 0] ?? this._blankTextureView[0];
        const dstTexture1 = this._textureViews[startDestMip + 1] ?? this._blankTextureView[1];
        const dstTexture2 = this._textureViews[startDestMip + 2] ?? this._blankTextureView[2];
        const dstTexture3 = this._textureViews[startDestMip + 3] ?? this._blankTextureView[3];

        const invSizeArr = [1 / srcWidth, 1 / srcHeight];
        const dispatchThreadIdToBufferUVArr = [2 / srcWidth, 2 / srcHeight, 0, 0];
        const currentWidth  = Math.max(1, this._width >> startDestMip);
        const currentHeight = Math.max(1, this._height >> startDestMip);

        compute.setParameter('readScreenDepth', readScreenDepth);
        compute.setParameter('invSize', invSizeArr);
        compute.setParameter('inputViewportMaxBound', viewportMaxBound);
        compute.setParameter('dispatchThreadIdToBufferUV', dispatchThreadIdToBufferUVArr);
        compute.setParameter('srcDepth', srcTexture);
        compute.setParameter('dstDepth0', dstTexture0);
        compute.setParameter('dstDepth1', dstTexture1);
        compute.setParameter('dstDepth2', dstTexture2);
        compute.setParameter('dstDepth3', dstTexture3);
        compute.setupDispatch(
            Math.ceil(currentWidth / workgroupSizeX),
            Math.ceil(currentHeight / workgroupSizeY)
        );
    }

    protected _updateComputeParameters() {

        if (!this._mainScreenDepthTexture ||
            !this._useCompute) {
            return;
        }

        let srcWidth  = this._mainScreenDepthTexture.width;
        let srcHeight = this._mainScreenDepthTexture.height;

        let viewportMaxBoundArr = [
            (this.screenWidth  - 0.5) / srcWidth,
            (this.screenHeight - 0.5) / srcHeight
        ];

        let startDestMip = 0;
        let readScreenDepth = 1;
        let srcTexture: pc.Texture | pc.TextureView = this._mainScreenDepthTexture;
        do {
            const index = startDestMip / this.maxMipBatchSize;
            const compute = index === 0 ? this._firstBatchCompute() : this._computeMips[index];
            this._applyBatch(
                compute,
                startDestMip,
                readScreenDepth,
                srcWidth,
                srcHeight,
                srcTexture,
                viewportMaxBoundArr
            );

            startDestMip += this.maxMipBatchSize;
            srcWidth  = Math.max(1, this._width >> (startDestMip - 1));
            srcHeight = Math.max(1, this._height >> (startDestMip - 1));
            srcTexture = this._textureViews[startDestMip - 1];
            viewportMaxBoundArr = [1, 1];
            readScreenDepth = 0;
        }
        while (startDestMip < this._mipLevels);
    }

    protected _tryUpdateByMainDepthTexture(mainDepthTexture: pc.Texture) {

        if (this.screenWidth !== mainDepthTexture.width ||
            this.screenHeight !== mainDepthTexture.height) {
            this.resize(mainDepthTexture.width, mainDepthTexture.height);
        }

        const key = this._sourceKey();
        if (this._mainScreenDepthTexture !== mainDepthTexture || this._boundSourceKey !== key) {
            this._mainScreenDepthTexture = mainDepthTexture;
            this._boundSourceKey = key;
            this._updateComputeParameters();
        }
    }

    protected _executeCompute() {
        const batches = this._computeMips;
        const first = this._firstBatchCompute();
        if (first === batches[0]) {
            this._device.computeDispatch(batches, this._debugName);
            return;
        }

        const count = batches.length;
        _dispatchList.length = count;
        _dispatchList[0] = first;
        for (let i = 1; i < count; i++) {
            _dispatchList[i] = batches[i];
        }
        this._device.computeDispatch(_dispatchList, this._debugName);
    }

    protected _executePixel() {

        if (!this._mainScreenDepthTexture) {
            return;
        }

        this._bindPixelShader(this._depthMode, this._sourceSampleType);
        if (this._depthMode !== CAMERA_DEPTH_DEVICE) {
            this._cameraParamsScope.setValue(_cameraParamsArr);
        }

        const device = this.device;
        const { vx, vy, vw, vh, sx, sy, sw, sh } = device;
        const oldRenderTarget = device.getRenderTarget();

        let readScreenDepth = 1;
        let srcLevel  = 0;
        let srcWidth  = this._mainScreenDepthTexture.width;
        let srcHeight = this._mainScreenDepthTexture.height;
        let srcBuffer : pc.Texture | pc.TextureView = this._mainScreenDepthTexture;

        _viewportMaxBoundArr[0] = (this.screenWidth  - 0.5) / srcWidth;
        _viewportMaxBoundArr[1] = (this.screenHeight - 0.5) / srcHeight;

        let mip = 0;
        do {
            _invSizeArr[0] = 1 / srcWidth;
            _invSizeArr[1] = 1 / srcHeight;

            _dispatchThreadIdToBufferUVArr[0] = 2 / srcWidth;
            _dispatchThreadIdToBufferUVArr[1] = 2 / srcHeight;

            // Offsets to sample from the center of the pixel
            //_dispatchThreadIdToBufferUVArr[2] = 0;
            //_dispatchThreadIdToBufferUVArr[3] = 0;

            this._inputViewportMaxBoundScope.setValue(_viewportMaxBoundArr);
            this._dispatchThreadIdToBufferUVScope.setValue(_dispatchThreadIdToBufferUVArr);
            this._invSizeScope.setValue(_invSizeArr);
            this._readScreenDepthScope.setValue(readScreenDepth);
            this._readLevelScope.setValue(srcLevel);
            this._srcDepthScope.setValue(srcBuffer);

            // Render to the current mip level
            this._pixelRenders[mip].render();

            readScreenDepth = 0;
            srcLevel  = Math.max(0, mip);
            srcWidth  = Math.max(1, this._width >> mip);
            srcHeight = Math.max(1, this._height >> mip);
            srcBuffer = this._textureViews[mip];

            mip++;

            if (mip === 1) {
                _viewportMaxBoundArr[0] = 1;
                _viewportMaxBoundArr[1] = 1;
            }
        }
        while (mip < this._mipLevels);

        device.setRenderTarget(oldRenderTarget);
        device.setViewport(vx, vy, vw, vh);
        device.setScissor(sx, sy, sw, sh);
    }

    public isFloat16() {
        // TODO: unsupported on WebGPU
        return false;
    }

    public isFloat32() {
        // TODO: on mobile r32float
        // render not supported used rgba8unorm
        // for supported all platforms
        return false;
    }

    public isColor() {
        // Mip maps for depth texture
        // not supported on webgpu platform
        return true;
    }

    public resize(width: number = this.screenWidth, height: number = this.screenHeight) {
        this._dispose();
        this._init(width, height);
        this._updateComputeParameters();
    }

    public destroy() {
        this._dispose();
    }

    public update(camera: pc.Camera) {
        this._updateFrom(camera, getCameraDepthTexture(camera), CAMERA_DEPTH_DEVICE);
    }

    /**
     * Same pyramid as {@link update}, from `camera.sceneDepthMap`.
     * Linear, packed, and reciprocal CameraFrame encodings are decoded to device Z
     * on the first pass. No-op until the map is published.
     */
    public updateSceneDepth(camera: pc.Camera) {
        this._updateFrom(camera, camera.sceneDepthMap, getCameraSceneDepthMode(camera));
    }

    private _updateFrom(camera: pc.Camera, mainDepthTexture: pc.Texture | null, depthMode: number) {

        if (!this.enabled || !mainDepthTexture) {
            return;
        }

        this._depthMode = depthMode;
        this._sourceSampleType = sourceSampleType(mainDepthTexture);
        writeCameraParams(_cameraParamsArr, camera);
        this._tryUpdateByMainDepthTexture(mainDepthTexture);

        if (this._useCompute) {
            const first = this._firstBatchCompute();
            if (depthMode !== CAMERA_DEPTH_DEVICE && first !== this._computeMips[0]) {
                first.setParameter("cameraParams", _cameraParamsArr);
            }
            this._executeCompute();
        }
        else {
            this._executePixel();
        }
    }
}

function sourceSampleType(texture: pc.Texture) {
    const format = texture.format;
    if (format === pc.PIXELFORMAT_DEPTH ||
        format === pc.PIXELFORMAT_DEPTH16 ||
        format === pc.PIXELFORMAT_DEPTHSTENCIL ||
        format === pc.PIXELFORMAT_R32F) {
        return pc.SAMPLETYPE_UNFILTERABLE_FLOAT;
    }
    return pc.SAMPLETYPE_FLOAT;
}

const _invSizeArr = new Float32Array(2);
const _viewportMaxBoundArr = new Float32Array(2);
const _dispatchThreadIdToBufferUVArr = new Float32Array(4);
const _cameraParamsArr = new Float32Array(4);
const _dispatchList: pc.Compute[] = [];