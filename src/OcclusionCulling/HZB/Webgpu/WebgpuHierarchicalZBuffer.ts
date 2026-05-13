import pc from "../../../engine.js";
import type { IHierarchicalZBuffer } from "../IHierarchicalZBuffer.js";
import cshader from "./WebgpuHierarchicalZBuffer.wgsl.js";
import { getCameraDepthTexture } from "../../../Extras/CameraHelpers.js";

export class WebgpuHierarchicalZBuffer implements IHierarchicalZBuffer {

    public readonly maxMipBatchSize: number = 1;

    private _debugName: string = "HZB";
    private _enabled: boolean = false;
    private _device: pc.WebgpuGraphicsDevice;
    private _screenWidth: number = 0;
    private _screenHeight: number = 0;
    private _width: number = 0;
    private _height: number = 0;
    private _mipLevels: number = 0;
    private _minLevel: number = 0;
    private _texture: pc.Texture | null = null;
    private _computeMipsShader: pc.Shader | null = null;
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
    public get minLevel() { return this._minLevel; }

    public get uvFactor(): [number, number] {
        return [
            this.screenWidth  / (2 * this.width),
            this.screenHeight / (2 * this.height)
        ];
    }

    public constructor(device: pc.WebgpuGraphicsDevice, debugName?: string) {

        this._device = device;

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

        const computeBindGroupFormat = new pc.BindGroupFormat(this.device, [
            new pc.BindUniformBufferFormat('ub', pc.SHADERSTAGE_COMPUTE),
            new pc.BindTextureFormat('srcDepth', pc.SHADERSTAGE_COMPUTE, pc.TEXTUREDIMENSION_2D, pc.SAMPLETYPE_UNFILTERABLE_FLOAT, true, 'srcDepthSampler'),
            new pc.BindStorageTextureFormat('dstDepth', format, pc.TEXTUREDIMENSION_2D, true, false)
        ]);

        const cdefines = new Map<string, string>();
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

        this._computeMipsShader = new pc.Shader(this.device, {
            name: 'HZBComputeShader',
            shaderLanguage: pc.SHADERLANGUAGE_WGSL,
            cshader: cshader,
            cdefines: cdefines,
            cincludes: pc.ShaderChunks.get(this.device, pc.SHADERLANGUAGE_WGSL),
            // @ts-ignore
            computeUniformBufferFormats,
            computeBindGroupFormat
        });

        this._textureViews = new Array(this._mipLevels);
        this._computeMips  = new Array(this._mipLevels / this.maxMipBatchSize);

        for (let i = 0; i < this._mipLevels; i++) {
            this._textureViews[i] = this._texture.getView(i);
        }

        //for (let i = this.maxMipBatchSize; i < this._mipLevels; i += this.maxMipBatchSize) {
        //    const idx = (i / this.maxMipBatchSize) - 1;
        for (let idx = 0; idx < this._mipLevels; idx++) {
            this._computeMips[idx] = new pc.Compute(this.device, this._computeMipsShader, 'HZBComputeMipBatch' + idx);
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

        let mip = 0;
        let readScreenDepth = 1;
        let srcTexture = this._mainScreenDepthTexture as (pc.Texture | pc.TextureView);
        let dstTexture = this._textureViews[mip];
        do {
            const invSizeArr = [1 / srcWidth, 1 / srcHeight];
            const dispatchThreadIdToBufferUVArr = [2 / srcWidth, 2 / srcHeight, 0, 0];

            this._computeMips[mip].setParameter('readScreenDepth', readScreenDepth);
            this._computeMips[mip].setParameter('invSize', invSizeArr);
            this._computeMips[mip].setParameter('inputViewportMaxBound', viewportMaxBoundArr);
            this._computeMips[mip].setParameter('dispatchThreadIdToBufferUV', dispatchThreadIdToBufferUVArr);
            this._computeMips[mip].setParameter('srcDepth', srcTexture);
            this._computeMips[mip].setParameter('dstDepth', dstTexture);

            readScreenDepth = 0;
            srcWidth  = Math.max(1, this._width >> mip);
            srcHeight = Math.max(1, this._height >> mip);

            // src = current mip level
            const w = Math.ceil(srcWidth  / this._workgroupSizeX);
            const h = Math.ceil(srcHeight / this._workgroupSizeY);

            this._computeMips[mip].setupDispatch(w, h);

            mip++;
            srcTexture = this._textureViews[mip - 1];
            dstTexture = this._textureViews[mip];

            if (mip === 1) {
                viewportMaxBoundArr = [1, 1];
            }
        }
        while (mip < this._mipLevels);
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

    private _updateMainDepthTexture(mainDepthTexture: pc.Texture) {
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
        this._mainScreenDepthTexture = null;
        this._computeMips.forEach(x => x?.destroy());
        this._texture?.destroy();
        this._computeMipsShader?.destroy();
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

            this._updateMainDepthTexture(mainDepthTexture);
            this._device.computeDispatch(this._computeMips, this._debugName);
        }
    }
}