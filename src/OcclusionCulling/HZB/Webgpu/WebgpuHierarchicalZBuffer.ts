import pc from "../../../engine.js";
import type { IHierarchicalZBuffer } from "../IHierarchicalZBuffer.js";
import cshader from "./WebgpuHierarchicalZBuffer.wgsl.js";
import { getCameraDepthTexture } from "../../../Extras/CameraHelpers.js";

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

    private _texture: pc.Texture | null = null;
    private _computeMipsShaders: pc.Shader[] = [];
    private _textureViews: pc.TextureView[] = [];
    private _computeMips: pc.Compute[] = [];
    private _workgroupSizeX: number = 8;
    private _workgroupSizeY: number = 8;
    private _mainScreenDepthTexture: pc.Texture | null = null;

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
    public get maxMipBatchSize() { return this._maxMipBatchSize; }
    public set maxMipBatchSize(value: number) {
        this._maxMipBatchSize = this.getSafeMipBatchSize(value);
        this._free();
        this._init();
    }

    public get uvFactor(): [number, number] {
        return [
            this.screenWidth  / (2 * this.width),
            this.screenHeight / (2 * this.height)
        ];
    }

    public constructor(device: pc.WebgpuGraphicsDevice, maxMipBatchSize: number = 4, debugName?: string) {

        this._device = device;
        this._maxMipBatchSize = this.getSafeMipBatchSize(maxMipBatchSize);

        if (debugName !== undefined) {
            this._debugName = debugName;
        }

        if (!device.supportsCompute) {
            return;
        }

        this._init(this.device.width, this.device.height);
        this._updateComputeParameters();
        this._enabled = true;
    }

    public getSafeMipBatchSize(value: number) {
        if (value < 1 || value > 4) {
            console.warn("HZB mip batch size must be 1 or 2 or 3 or 4]");
        }
        return Math.max(1, Math.min(Math.floor(value), 4));
    }

    private _free() {
        this._mainScreenDepthTexture = null;
        this._computeMips.forEach(x => x?.destroy());
        this._computeMipsShaders?.forEach(x => x?.destroy());
        this._blankTexture?.destroy();
        this._texture?.destroy();
    }

    private _init(width: number = this.screenWidth, height: number = this.screenHeight) {

        this._screenWidth = width | 0;
        this._screenHeight = height | 0;

        const numMipsX = Math.max(Math.ceil(Math.log2(this._screenWidth)) - 1, 1);
        const numMipsY = Math.max(Math.ceil(Math.log2(this._screenHeight)) - 1, 1);
        const numMips  = Math.max(numMipsX, numMipsY);

        this._width  = 1 << numMipsX;
        this._height = 1 << numMipsY;
        this._mipLevels = numMips;

        const format = (
            !this.isColor()  ? pc.PIXELFORMAT_DEPTH :
            this.isFloat16() ? pc.PIXELFORMAT_R16F :
            this.isFloat32() ? pc.PIXELFORMAT_R32F :
                               pc.PIXELFORMAT_RGBA8
        );

        this._blankTexture = new pc.Texture(this.device, {
            name: "HZBBlankTexture",
            width: 16,
            height: 16,
            format: format,
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

        this._texture = new pc.Texture(this.device, {
            name: "HZBTexture",
            width: this._width,
            height: this._height,
            format: format,
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

        const computeUniformBufferFormats = {
            ub: new pc.UniformBufferFormat(this.device, [
                new pc.UniformFormat('readScreenDepth', pc.UNIFORMTYPE_INT),
                new pc.UniformFormat('invSize', pc.UNIFORMTYPE_VEC2),
                new pc.UniformFormat('inputViewportMaxBound', pc.UNIFORMTYPE_VEC2),
                new pc.UniformFormat('dispatchThreadIdToBufferUV', pc.UNIFORMTYPE_VEC4)
            ])
        };

        const cdefines = new Map<string, string>();
        const cincludes = pc.ShaderChunks.get(this.device, pc.SHADERLANGUAGE_WGSL);

        cdefines.set('{WORKGROUP_SIZE_X}', this._workgroupSizeX.toFixed(0));
        cdefines.set('{WORKGROUP_SIZE_Y}', this._workgroupSizeY.toFixed(0));
        cdefines.set('{SRC_DEPTH_FORMAT}', this.isFloat16() ? 'f16' : 'f32');
        cdefines.set('{DST_DEPTH_FORMAT}',
            this.isFloat16() ? 'r16float' :
            this.isFloat32() ? 'r32float' :
                               'rgba8unorm' // fallback to color format for unsupported depth texture mipmap on webgpu platform
        );

        if (this.isFloat16()) {
            cdefines.set('DEPTH_IS_FLOAT16', '');
        }
        else if (this.isFloat32()) {
            cdefines.set('DEPTH_IS_FLOAT', '');
        }

        this._textureViews = new Array(this._mipLevels);
        this._computeMips  = new Array(Math.ceil(this._mipLevels / this.maxMipBatchSize));
        this._computeMipsShaders = new Array(this.maxMipBatchSize);

        for (let i = 0; i < this._mipLevels; i++) {
            this._textureViews[i] = this._texture.getView(i);
        }

        for (let startDestMip = 0; startDestMip < this._mipLevels; startDestMip += this.maxMipBatchSize) {

            const endDestMip = Math.min(startDestMip + this.maxMipBatchSize, this._mipLevels);
            const levelCount = endDestMip - startDestMip;
            const index = startDestMip / this.maxMipBatchSize;

            // Create shader for level count
            if (this._computeMipsShaders[levelCount] === undefined) {

                const tmpDefines = new Map(cdefines);

                tmpDefines.set('{DIM_MIP_LEVEL_COUNT}', levelCount.toFixed(0));
                tmpDefines.set('DIM_MIP_LEVEL_COUNT', levelCount.toFixed(0));
                tmpDefines.set('DIM_FURTHEST', '');

                const formats = [
                    new pc.BindUniformBufferFormat('ub', pc.SHADERSTAGE_COMPUTE),
                    new pc.BindTextureFormat('srcDepth', pc.SHADERSTAGE_COMPUTE, pc.TEXTUREDIMENSION_2D, pc.SAMPLETYPE_UNFILTERABLE_FLOAT, true, 'srcDepthSampler'),
                ];

                // Set dst textures for levels
                for (let level = 0; level < levelCount; level++) {
                    formats.push(new pc.BindStorageTextureFormat('dstDepth' + level, format, pc.TEXTUREDIMENSION_2D, true, false));
                }

                const computeBindGroupFormat = new pc.BindGroupFormat(this.device, formats);

                this._computeMipsShaders[levelCount] = new pc.Shader(this.device, {
                    name: 'HZBComputeShaderBatch' + levelCount,
                    shaderLanguage: pc.SHADERLANGUAGE_WGSL,
                    cshader: cshader,
                    cdefines: tmpDefines,
                    cincludes: cincludes,
                    // @ts-ignore
                    computeUniformBufferFormats,
                    computeBindGroupFormat
                });
            }

            this._computeMips[index] = new pc.Compute(
                this.device,
                this._computeMipsShaders[levelCount],
                'HZBComputeMipBatch' + index
            );
        }
    }

    private _updateComputeParameters() {

        if (!this._mainScreenDepthTexture) {
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
        let srcTexture = this._mainScreenDepthTexture as (pc.Texture | pc.TextureView);
        do {
            const dstTexture0 = this._textureViews[startDestMip + 0] ?? this._blankTextureView[0];
            const dstTexture1 = this._textureViews[startDestMip + 1] ?? this._blankTextureView[1];
            const dstTexture2 = this._textureViews[startDestMip + 2] ?? this._blankTextureView[2];
            const dstTexture3 = this._textureViews[startDestMip + 3] ?? this._blankTextureView[3];

            const invSizeArr = [1 / srcWidth, 1 / srcHeight];
            const dispatchThreadIdToBufferUVArr = [2 / srcWidth, 2 / srcHeight, 0, 0];
            const index = startDestMip / this.maxMipBatchSize;

            // Calc work-groups for current
            const currentWidth  = Math.max(1, this._width >> startDestMip);
            const currentHeight = Math.max(1, this._height >> startDestMip);
            const w = Math.ceil(currentWidth  / this._workgroupSizeX);
            const h = Math.ceil(currentHeight / this._workgroupSizeY);

            this._computeMips[index].setParameter('readScreenDepth', readScreenDepth);
            this._computeMips[index].setParameter('invSize', invSizeArr);
            this._computeMips[index].setParameter('inputViewportMaxBound', viewportMaxBoundArr);
            this._computeMips[index].setParameter('dispatchThreadIdToBufferUV', dispatchThreadIdToBufferUVArr);
            this._computeMips[index].setParameter('srcDepth', srcTexture);
            this._computeMips[index].setParameter('dstDepth0', dstTexture0);
            this._computeMips[index].setParameter('dstDepth1', dstTexture1);
            this._computeMips[index].setParameter('dstDepth2', dstTexture2);
            this._computeMips[index].setParameter('dstDepth3', dstTexture3);
            this._computeMips[index].setupDispatch(w, h);

            startDestMip += this.maxMipBatchSize;
            srcWidth  = Math.max(1, this._width >> (startDestMip - 1));
            srcHeight = Math.max(1, this._height >> (startDestMip - 1));
            srcTexture = this._textureViews[startDestMip - 1];
            viewportMaxBoundArr = [1, 1];
            readScreenDepth = 0;
        }
        while (startDestMip < this._mipLevels);
    }

    private _needUpdate(mainDepthTexture: pc.Texture) {

        // TODO: need more tests

        if (mainDepthTexture.width !== this._screenWidth ||
            mainDepthTexture.height !== this._screenHeight ||
            mainDepthTexture !== this._mainScreenDepthTexture) {
            return true;
        }

        return false;
    }

    private _tryUpdateMainDepthTexture(mainDepthTexture: pc.Texture) {
        if (this._needUpdate(mainDepthTexture)) {
            this._mainScreenDepthTexture = mainDepthTexture;
            this._updateComputeParameters();
        }
    }

    public isFloat16() {
        // TODO: unsupported on WebGPU
        return false;
    }

    public isFloat32() {
        // TODO: on mobile r32float
        // render not supported used rgba8unorm
        // for supported all platforms
        return true;
    }

    public isColor() {
        // Mip maps for depth texture
        // not support on webgpu platform
        return true;
    }

    public calculateMipLevels(width: number, height: number): number {
        const maxSize = Math.max(width, height);
        return 1 + Math.floor(Math.log2(maxSize));
    }

    public resize(width: number = this.screenWidth, height: number = this.screenHeight) {
        this.destroy();
        this._init(width, height);
        this._updateComputeParameters();
    }

    public destroy() {
        this._free();
    }

    public update(camera: pc.Camera) {

        if (!this.enabled ||
            !this.device.supportsCompute) {
            return;
        }

        const mainDepthTexture = getCameraDepthTexture(camera);

        if (mainDepthTexture) {

            if (mainDepthTexture.width !== this.screenWidth ||
                mainDepthTexture.height !== this.screenHeight) {
                this.resize(mainDepthTexture.width, mainDepthTexture.height);
            }

            this._tryUpdateMainDepthTexture(mainDepthTexture);
            this._device.computeDispatch(this._computeMips, this._debugName);
        }
    }
}