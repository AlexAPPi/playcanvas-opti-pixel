import { IHierarchicalZBuffer } from "../IHierarchicalZBuffer.js";
import cshader from "./WebgpuHierarchicalZBuffer.wsgl.js";
import pc from "../../../engine.js";

export class WebgpuHierarchicalZBuffer implements IHierarchicalZBuffer {

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

    public constructor(device: pc.WebgpuGraphicsDevice, debugName?: string) {

        if (debugName !== undefined) {
            this._debugName = debugName;
        }

        if (!device.supportsCompute) {
            return;
        }

        this._enabled = true;
        this._device = device;

        this._init();
        this._updateComputeParameters();
    }

    private _init() {

        this._screenWidth = this.device.width | 0;
        this._screenHeight = this.device.height | 0;
        this._width = this._screenWidth >> 1;
        this._height = this._screenHeight >> 1;
        this._mipLevels = this.calculateMipLevels(this._width, this._height);

        const depthByColor = this.isColor();
        const format = depthByColor ?
            (this.isFloat32() ? pc.PIXELFORMAT_R32F : pc.PIXELFORMAT_RGBA8) :
            pc.PIXELFORMAT_DEPTH;

        this._texture = new pc.Texture(this.device, {
            name: "HierarchicalZBufferTexture",
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
                new pc.UniformFormat('includeSrcExtraColumn', pc.UNIFORMTYPE_INT),
                new pc.UniformFormat('includeSrcExtraRow', pc.UNIFORMTYPE_INT),
            ])
        };

        const computeBindGroupFormat = new pc.BindGroupFormat(this.device, [
            new pc.BindUniformBufferFormat('ub', pc.SHADERSTAGE_COMPUTE),
            new pc.BindTextureFormat('screenDepth', pc.SHADERSTAGE_COMPUTE, pc.TEXTUREDIMENSION_2D, pc.SAMPLETYPE_DEPTH, false, null),
            new pc.BindTextureFormat('srcDepth', pc.SHADERSTAGE_COMPUTE, pc.TEXTUREDIMENSION_2D, pc.SAMPLETYPE_UNFILTERABLE_FLOAT, false, null),
            new pc.BindStorageTextureFormat('dstDepth', format, pc.TEXTUREDIMENSION_2D, true, false)
        ]);

        const cdefines = new Map<string, string>();
        cdefines.set('{WORKGROUP_SIZE_X}', this._workgroupSizeX.toString());
        cdefines.set('{WORKGROUP_SIZE_Y}', this._workgroupSizeY.toString());

        if (this.isFloat32()) {
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
        this._computeMips = new Array(this._mipLevels);

        for (let i = 0; i < this._mipLevels; i++) {
            this._textureViews[i] = this._texture.getView(i);
            this._computeMips[i] = new pc.Compute(this.device, this._computeMipsShader, 'HZBComputeMip' + i);
        }
    }

    private _updateMainScreenDepthTexture() {
        if (this._mainScreenDepthTexture) {
            for (let mip = 0; mip < this._mipLevels; mip++) {
                this._computeMips[mip].setParameter('screenDepth', this._mainScreenDepthTexture);
            }
        }
    }

    private _updateComputeParameters() {

        for (let mip = 0; mip < this._mipLevels; mip++) {

            const srcMip = mip - 1;
            const srcWidth = Math.max(1, this._screenWidth >> mip);
            const srcHeight = Math.max(1, this._screenHeight >> mip);
            const readScreenDepth = mip === 0 ? 1 : 0;
            const includeSrcExtraColumn = srcWidth & 1;
            const includeSrcExtraRow = srcHeight & 1;
            const srcTexture = mip === 0 ? this._textureViews[this._mipLevels - 1] : this._textureViews[srcMip];
            const dstTexture = this._textureViews[mip];

            this._computeMips[mip].setParameter('readScreenDepth', readScreenDepth);
            this._computeMips[mip].setParameter('includeSrcExtraColumn', includeSrcExtraColumn);
            this._computeMips[mip].setParameter('includeSrcExtraRow', includeSrcExtraRow);
            this._computeMips[mip].setParameter('srcDepth', srcTexture);
            this._computeMips[mip].setParameter('dstDepth', dstTexture);

            if (this._mainScreenDepthTexture) {
                this._computeMips[mip].setParameter('screenDepth', this._mainScreenDepthTexture);
            }

            const dstWidth  = Math.max(1, srcWidth >> 1);
            const dstHeight = Math.max(1, srcHeight >> 1);

            const w = Math.ceil(dstWidth / this._workgroupSizeX);
            const h = Math.ceil(dstHeight / this._workgroupSizeY);

            this._computeMips[mip].setupDispatch(w, h);
        }
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
            this._updateMainScreenDepthTexture();
        }
    }

    public isFloat32() {
        return false;
    }

    public isColor() {
        return true;
    }

    public calculateMipLevels(width: number, height: number): number {
        const maxSize = Math.max(width, height);
        return 1 + Math.floor(Math.log2(maxSize));
    }

    public resize() {
        this.destroy();
        this._init();
        this._updateComputeParameters();
    }

    public destroy() {
        this._mainScreenDepthTexture = null;
        this._texture?.destroy();
        this._computeMipsShader?.destroy();
    }

    public update(camera: pc.Camera) {

        if (!this._enabled ||
            !this._device ||
            !this._device.supportsCompute) {
            return;
        }

        // TODO: need more test on devices
        const mainDepthTexture = (camera.renderPassDepthGrab as any)?.depthRenderTarget.depthBuffer;

        if (mainDepthTexture) {

            // TODO: check camera depth buffer viewport
            this._updateMainDepthTexture(mainDepthTexture);
            this._device.computeDispatch(this._computeMips, this._debugName);
        }
    }
}