import pc from "../../../engine.js";
import type { IHierarchicalZBuffer } from "../IHierarchicalZBuffer.js";
import vertexCodeVS from "./WebgpuHierarchicalZBuffer.vert.wgsl.js";
import fragmentCodePS from "./WebgpuHierarchicalZBuffer.frag.wgsl.js";
import computeCodeCS from "./WebgpuHierarchicalZBuffer.comp.wgsl.js";
import { CAMERA_DEPTH_DEVICE, applySceneDepthDefines, getCameraDepthTexture, getCameraSceneDepthMode } from "../../../Extras/CameraHelpers.js";

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
    private _maxMipBatchSize: number = 4;
    private _useCompute: boolean = true;

    private _mainScreenDepthTexture: pc.Texture | null = null;
    private _depthMode = CAMERA_DEPTH_DEVICE;
    private _sourceSampleType: number = pc.SAMPLETYPE_UNFILTERABLE_FLOAT;

    private _texture: pc.Texture | null = null;
    private _textureViews: pc.TextureView[] = [];

    /**
     * Dispatch list. Index 0 samples camera depth as device Z until a scene depth map replaces it.
     * Later entries reduce HZB mips, which are already device Z.
     * Reduce passes with the same mip count share one shader.
     */
    private _batches: pc.Compute[] = [];

    private _boundDepthMode = -1;
    private _pixelRenders: pc.RenderPassShaderQuad[] = [];
    private _cameraParamsScope: pc.ScopeId;

    private _dispatchThreadIdToBufferUVScope: pc.ScopeId;
    private _inputViewportMaxBoundScope: pc.ScopeId;
    private _invSizeScope: pc.ScopeId;
    private _srcDepthScope: pc.ScopeId;

    private _uvFactorX: number;
    private _uvFactorY: number;
    private _uvFactor: [number, number];

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

    public get uvFactor() {
        return this._uvFactor;
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
            console.warn('HZB mip batch size must be 1, 2, 3 or 4');
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
        this._boundDepthMode = -1;
        this._releaseCompute();
        this._releasePixel();
        this._releaseTexture();
    }

    private _releaseTexture() {
        this._texture?.destroy();
        this._texture = null;
        this._textureViews = [];
    }

    private _releasePixel() {
        this._pixelRenders.forEach((pass) => {
            pass.shader?.destroy();
            pass.destroy()
        });
        this._pixelRenders = [];
    }

    private _releaseCompute() {
        this._batches.forEach((compute) => {
            const shader = compute.shader;
            compute.shader = null;
            compute.destroy();
            shader?.destroy();
        });
        this._batches = [];
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

        this._uvFactorX = this._screenWidth / (2 * this._width);
        this._uvFactorY = this._screenHeight / (2 * this._height);
        this._uvFactor = [this._uvFactorX, this._uvFactorY];

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
        this._invSizeScope = this._device.scope.resolve("uInvSize");
        this._srcDepthScope = this._device.scope.resolve("srcDepth");
        this._cameraParamsScope = this._device.scope.resolve("uCameraParams");
        this._boundDepthMode = CAMERA_DEPTH_DEVICE;
        this._pixelRenders = new Array(this._mipLevels);

        const reduce = this._createPixelShader(CAMERA_DEPTH_DEVICE, false);
        const source = this._createPixelShader(CAMERA_DEPTH_DEVICE, true);

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
            rp.shader = mip === 0 ? source : reduce;
            rp.init(rt);
            rp.colorOps.clear = true;
            rp.colorOps.genMipmaps = false;

            this._pixelRenders[mip] = rp;
        }
    }

    protected _initCompute() {

        if (!this._texture) {
            return;
        }

        const batchSize = this.maxMipBatchSize;
        const mipLevels = this.mipLevels;
        const batchCount = Math.ceil(mipLevels / batchSize);
        const headCount = Math.min(batchSize, mipLevels);
        const tailCount = mipLevels - (batchCount - 1) * batchSize;
        const batches = new Array<pc.Compute>(batchCount);
        const sourceShader = this._batchShader(headCount, this._depthMode, this._sourceSampleType, true);

        batches[0] = new pc.Compute(this.device, sourceShader, 'HZBSource');

        if (batchCount > 1) {

            const last = batchCount - 1;
            const depthMode = CAMERA_DEPTH_DEVICE;
            const sampleType = pc.SAMPLETYPE_UNFILTERABLE_FLOAT;
            const readScreen = false;

            if (tailCount === batchSize) {

                const reduceShader = this._batchShader(batchSize, depthMode, sampleType, readScreen);

                for (let i = 1; i <= last; i++) {
                    batches[i] = new pc.Compute(this.device, reduceShader, 'HZBReduce' + i);
                }
            }
            else {

                if (last > 1) {

                    const reduceShader = this._batchShader(batchSize, depthMode, sampleType, readScreen);

                    for (let i = 1; i < last; i++) {
                        batches[i] = new pc.Compute(this.device, reduceShader, 'HZBReduce' + i);
                    }
                }

                const tailShader = this._batchShader(tailCount, depthMode, sampleType, readScreen);
                batches[last] = new pc.Compute(this.device, tailShader, 'HZBReduce' + last);
            }
        }

        this._batches = batches;
    }

    private _storedDepthDefines(defines: Map<string, string>) {

        if (this.isFloat16()) {
            defines.set('DEPTH_IS_FLOAT16', '');
        }
        else if (this.isFloat32()) {
            defines.set('DEPTH_IS_FLOAT', '');
        }
    }

    private _createPixelShader(depthMode: number, readScreen: boolean) {

        const defines = new Map<string, string>();
        this._storedDepthDefines(defines);

        if (readScreen) {
            defines.set('READ_SCREEN_DEPTH', '');
            applySceneDepthDefines(defines, depthMode);
        }

        return pc.ShaderUtils.createShader(this._device, {
            uniqueName: readScreen ? 'HZB_PIXEL_SRC_' + depthMode : 'HZB_PIXEL_REDUCE',
            vertexWGSL: vertexCodeVS,
            fragmentWGSL: fragmentCodePS,
            fragmentDefines: defines,
            attributes: {
                aPosition: pc.SEMANTIC_POSITION
            },
        });
    }

    private _bindPixelShader(depthMode: number) {

        if (this._boundDepthMode === depthMode) {
            return;
        }

        this._pixelRenders[0].shader?.destroy();
        this._pixelRenders[0].shader = this._createPixelShader(depthMode, true);
        this._boundDepthMode = depthMode;
    }

    private _batchShader(levelCount: number, depthMode: number, sampleType: number, readScreen: boolean) {

        const textureFormat = this.getTextureFormat();
        const defines = new Map<string, string>();

        this._storedDepthDefines(defines);

        defines.set('{DST_DEPTH_FORMAT}',
            this.isFloat16() ? 'r16float' :
            this.isFloat32() ? 'r32float' :
                               'rgba8unorm'
        );

        defines.set('{DIM_MIP_LEVEL_COUNT}', levelCount.toFixed(0));
        defines.set('DIM_MIP_LEVEL_COUNT', levelCount.toFixed(0));
        defines.set('{SRC_DEPTH_FORMAT}', 'f32');
        defines.set('DIM_FURTHEST', '');

        if (readScreen) {
            defines.set('READ_SCREEN_DEPTH', '');
            applySceneDepthDefines(defines, depthMode);
        }

        const uniformFormats = [
            new pc.UniformFormat('invSize', pc.UNIFORMTYPE_VEC2),
            new pc.UniformFormat('inputViewportMaxBound', pc.UNIFORMTYPE_VEC2),
            new pc.UniformFormat('dispatchThreadIdToBufferUV', pc.UNIFORMTYPE_VEC4)
        ];

        if (readScreen && depthMode !== CAMERA_DEPTH_DEVICE) {
            uniformFormats.push(new pc.UniformFormat('cameraParams', pc.UNIFORMTYPE_VEC4));
        }

        const formats = [
            new pc.BindUniformBufferFormat('ub', pc.SHADERSTAGE_COMPUTE),
            new pc.BindTextureFormat('srcDepth', pc.SHADERSTAGE_COMPUTE, pc.TEXTUREDIMENSION_2D, sampleType, true, 'srcDepthSampler'),
        ];

        for (let level = 0; level < levelCount; level++) {
            formats.push(new pc.BindStorageTextureFormat('dstDepth' + level, textureFormat, pc.TEXTUREDIMENSION_2D, true, false));
        }

        return new pc.Shader(this.device, {
            name: readScreen ? 'HZBSource' + levelCount : 'HZBReduce' + levelCount,
            shaderLanguage: pc.SHADERLANGUAGE_WGSL,
            cshader: computeCodeCS,
            cdefines: defines,
            cincludes: pc.ShaderChunks.get(this.device, pc.SHADERLANGUAGE_WGSL),
            computeBindGroupFormat: new pc.BindGroupFormat(this.device, formats),
            computeUniformBufferFormats: {
                ub: new pc.UniformBufferFormat(this.device, uniformFormats)
            },
        });
    }

    /**
     * Rebuild batch 0 for the current camera depth.
     * Reduce shaders stay on the later batches.
     */
    private _updateSceneBatch() {

        const levelCount = Math.min(this._maxMipBatchSize, this._mipLevels);
        const previous = this._batches[0];
        const newShader = this._batchShader(levelCount, this._depthMode, this._sourceSampleType, true);

        if (previous) {
            const shader = previous.shader;
            previous.shader = null;
            previous.destroy();
            shader?.destroy();
        }

        this._batches[0] = new pc.Compute(this.device, newShader, 'HZBSource');
    }

    private _applyBatch(
        compute: pc.Compute,
        startDestMip: number,
        srcWidth: number,
        srcHeight: number,
        srcTexture: pc.Texture | pc.TextureView,
        viewportMaxBound: number[]
    ) {
        const levelCount = Math.min(this.maxMipBatchSize, this._mipLevels - startDestMip);
        const invSizeArr = [1 / srcWidth, 1 / srcHeight];
        const dispatchThreadIdToBufferUVArr = [2 / srcWidth, 2 / srcHeight, 0, 0];
        const currentWidth  = Math.max(1, this._width >> startDestMip);
        const currentHeight = Math.max(1, this._height >> startDestMip);

        compute.setParameter('invSize', invSizeArr);
        compute.setParameter('inputViewportMaxBound', viewportMaxBound);
        compute.setParameter('dispatchThreadIdToBufferUV', dispatchThreadIdToBufferUVArr);
        compute.setParameter('srcDepth', srcTexture);

        for (let level = 0; level < levelCount; level++) {
            compute.setParameter('dstDepth' + level, this._textureViews[startDestMip + level]);
        }

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
        let srcTexture: pc.Texture | pc.TextureView = this._mainScreenDepthTexture;
        do {
            const index = startDestMip / this.maxMipBatchSize;
            const compute = this._batches[index];
            this._applyBatch(
                compute,
                startDestMip,
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
        }
        while (startDestMip < this._mipLevels);
    }

    protected _tryUpdateByMainDepthTexture(mainDepthTexture: pc.Texture, depthMode: number) {

        const sampleType = sourceSampleType(mainDepthTexture);
        const mainWidth = mainDepthTexture.width;
        const mainHeight = mainDepthTexture.height;

        if (this._mainScreenDepthTexture === mainDepthTexture &&
            this._depthMode === depthMode &&
            this._sourceSampleType === sampleType) {

            if (this._screenWidth === mainWidth &&
                this._screenHeight === mainHeight) {
                return;
            }
        }

        if (this._screenWidth !== mainWidth ||
            this._screenHeight !== mainHeight) {
            this.resize(mainWidth, mainHeight);
        }

        const rebuild = depthMode !== this._depthMode ||
                        sampleType !== this._sourceSampleType;

        this._depthMode = depthMode;
        this._sourceSampleType = sampleType;

        if (this._useCompute && rebuild) {
            this._updateSceneBatch();
        }

        this._mainScreenDepthTexture = mainDepthTexture;
        this._updateComputeParameters();
    }

    protected _updateCameraParams(camera: pc.Camera, depthMode: number) {

        if (depthMode !== CAMERA_DEPTH_DEVICE) {

            camera.fillShaderParams(_cameraParamsArr);

            if (this._useCompute) {
                this._batches[0].setParameter("cameraParams", _cameraParamsArr);
            }
            else {
                this._cameraParamsScope.setValue(_cameraParamsArr);
            }
        }
    }

    protected _executeCompute() {
        this._device.computeDispatch(this._batches, this._debugName);
    }

    protected _executePixel() {

        if (!this._mainScreenDepthTexture) {
            return;
        }

        this._bindPixelShader(this._depthMode);

        const device = this.device;
        const { vx, vy, vw, vh, sx, sy, sw, sh } = device;
        const oldRenderTarget = device.getRenderTarget();

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
            this._srcDepthScope.setValue(srcBuffer);

            // Render to the current mip level
            this._pixelRenders[mip].render();

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
     * `camera.shaderParams` selects metres, packed RGBA8, or `1 / viewZ`.
     * The first pass point-samples that encoding into device Z. No-op until the map is published.
     */
    public updateSceneDepth(camera: pc.Camera) {
        this._updateFrom(camera, camera.sceneDepthMap, getCameraSceneDepthMode(camera));
    }

    private _updateFrom(camera: pc.Camera, mainDepthTexture: pc.Texture | null, depthMode: number) {

        if (!this.enabled || !mainDepthTexture) {
            return;
        }

        this._tryUpdateByMainDepthTexture(mainDepthTexture, depthMode);
        this._updateCameraParams(camera, depthMode);

        if (this._useCompute) {
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
        format === pc.PIXELFORMAT_R32F ||
        format === pc.PIXELFORMAT_R16F) {
        return pc.SAMPLETYPE_UNFILTERABLE_FLOAT;
    }

    return pc.SAMPLETYPE_FLOAT;
}

const _invSizeArr = new Float32Array(2);
const _viewportMaxBoundArr = new Float32Array(2);
const _dispatchThreadIdToBufferUVArr = new Float32Array(4);
const _cameraParamsArr = new Float32Array(4);
