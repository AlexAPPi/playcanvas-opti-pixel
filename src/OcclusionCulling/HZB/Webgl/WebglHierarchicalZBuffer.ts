import { IHierarchicalZBuffer } from "../IHierarchicalZBuffer";
import vertexCodeVS from "./WebglHierarchicalZBuffer.vert.glsl";
import fragmentCodePS from "./WebglHierarchicalZBuffer.frag.glsl";
import pc from "../../../engine";

export class WebglHierarchicalZBuffer implements IHierarchicalZBuffer {

    private _enabled: boolean;
    private _device: pc.WebglGraphicsDevice;
    private _copyShader: pc.Shader;
    private _shader: pc.Shader;
    private _renderTargets: pc.RenderTarget[];
    private _quadRenderPasses: pc.RenderPassShaderQuad[];

    private _texture1: pc.Texture;
    private _texture2: pc.Texture;
    private _buffers: pc.Texture[];
    private _mipsBuffers: pc.Texture[];

    private _screenWidth: number;
    private _screenHeight: number;
    private _globalMipWidth: number;
    private _globalMipHeight: number;
    private _globalMipLevels: number;

    private _maxSize: number;
    private _width: number;
    private _heigth: number;
    private _mipLevels: number;
    private _minMipLevel: number;

    private _readScreenDepthScope: pc.ScopeId;
    private _includeSrcExtraColumnScope: pc.ScopeId;
    private _includeSrcExtraRowScope: pc.ScopeId;
    private _readLevelScope: pc.ScopeId;
    private _depthMipScope: pc.ScopeId;

    public get enabled() { return this._enabled; }
    public set enabled(value) { this._enabled = value; }
    public get screenWidth() { return this._screenWidth; }
    public get screenHeight() { return this._screenHeight; }
    public get width() { return this._width; }
    public get height() { return this._heigth; }
    public get device() { return this._device; }
    public get texture() { return this._texture1; }
    public get texture2() { return this._texture2; }
    public get buffers() { return this._mipsBuffers; }
    public get mipLevels() { return this._mipLevels; }
    public get nearLevel() { return this._minMipLevel; }
    public get maxSize() { return this._maxSize; }
    public set maxSize(value: number) {
        this._maxSize = value;
        this.resize();
    }

    constructor(device: pc.WebglGraphicsDevice, maxSize: number = 128) {
        this._enabled = true;
        this._device = device;
        this._maxSize = maxSize;
        this._readScreenDepthScope = this._device.scope.resolve("uReadScreenDepth");
        this._includeSrcExtraColumnScope = this._device.scope.resolve("uIncludeSrcExtraColumn");
        this._includeSrcExtraRowScope = this._device.scope.resolve("uIncludeSrcExtraRow");
        this._readLevelScope = this._device.scope.resolve("uReadLevel");
        this._depthMipScope = this._device.scope.resolve("uDepthMip");
        this.resize();
    }

    public isFloat32() {
        return false;
    }

    public isColor() {
        return true;
    }

    private _initShader() {

        const defines = new Map();

        if (!this.isColor()) {
            defines.set("READ_DEPTH", "");
            defines.set("WRITE_DEPTH", "");
        }
        else if (this.isFloat32()) {
            defines.set("DEPTH_IS_FLOAT", "");
        }

        if (this.device.textureFloatRenderable) {
            defines.set("SCENE_DEPTHMAP_FLOAT", "");
        }

        this._shader = pc.ShaderUtils.createShader(this._device, {
            uniqueName: "HZB_SHADER",
            useTransformFeedback: false,
            vertexGLSL: vertexCodeVS,
            fragmentGLSL: fragmentCodePS,
            fragmentDefines: defines,
            attributes: {
                aPosition: pc.SEMANTIC_POSITION
            },
        });
    }

    public resize() {
        this.destroy();
        this._screenWidth = this.device.width | 0;
        this._screenHeight = this.device.height | 0;
        this._globalMipWidth = this._screenWidth >> 1;
        this._globalMipHeight = this._screenHeight >> 1;
        this._globalMipLevels = this.calculateMipLevels(this._globalMipWidth, this._globalMipHeight);

        this._minMipLevel = this.getNearestMipLevel(this._globalMipWidth, this._globalMipHeight, this._maxSize);
        this._width = this._globalMipWidth >> this._minMipLevel;
        this._heigth = this._globalMipHeight >> this._minMipLevel;
        this._mipLevels = this._globalMipLevels - this._minMipLevel;

        this._initShader();
        this._initRenders();
    }

    private _initRenders() {

        // We alternate the textures so that even mip levels are written into the second texture
        // and odd mip levels into the first one. This way, we do not need to copy data between textures,
        // and in the shader we can simply use the max function across the two layers,
        // so that one texture is empty while the other is populated, and vice versa.

        this._buffers = new Array(this._globalMipLevels);
        this._renderTargets = new Array(this._globalMipLevels);
        this._quadRenderPasses = new Array(this._globalMipLevels);

        this._mipsBuffers = new Array(this._mipLevels);

        const depthByColor = this.isColor();
        const format = depthByColor ?
            (this.isFloat32() ? pc.PIXELFORMAT_R32F : pc.PIXELFORMAT_RGBA8) :
            pc.PIXELFORMAT_DEPTH;

        this._texture1 = new pc.Texture(this._device, {
            name: "HZB_MIP_TX_1",
            width: this._width,
            height: this._heigth,
            format: format,
            mipmaps: true,
            numLevels: this._mipLevels,
            minFilter: pc.FILTER_NEAREST_MIPMAP_NEAREST,
            magFilter: pc.FILTER_NEAREST,
            addressU: pc.ADDRESS_CLAMP_TO_EDGE,
            addressV: pc.ADDRESS_CLAMP_TO_EDGE,
            addressW: pc.ADDRESS_CLAMP_TO_EDGE,
            storage: false,
        });

        this._texture2 = new pc.Texture(this._device, {
            name: "HZB_MIP_TX_2",
            width: this._width,
            height: this._heigth,
            format: format,
            mipmaps: true,
            numLevels: this._mipLevels,
            minFilter: pc.FILTER_NEAREST_MIPMAP_NEAREST,
            magFilter: pc.FILTER_NEAREST,
            addressU: pc.ADDRESS_CLAMP_TO_EDGE,
            addressV: pc.ADDRESS_CLAMP_TO_EDGE,
            addressW: pc.ADDRESS_CLAMP_TO_EDGE,
            storage: false,
        });

        let tmpMip = 0;

        for (let mip = 0; mip < this._globalMipLevels; mip++) {

            const rpsShader = this._shader;
            const rps = new pc.RenderPassShaderQuad(this._device);

            if (depthByColor) {
                rps.blendState = pc.BlendState.NOBLEND;
                rps.depthState = pc.DepthState.NODEPTH;
            }
            else {
                rps.blendState = pc.BlendState.NOWRITE;
                rps.depthState = pc.DepthState.WRITEDEPTH;
            }

            let rt: pc.RenderTarget;
            let buffer: pc.Texture;

            if (mip >= this._minMipLevel) {

                buffer = tmpMip % 2 === 0 ? this._texture1 : this._texture2;

                const mipsMipLevel = mip - this._minMipLevel;
                const optsMipRt: ConstructorParameters<typeof pc.RenderTarget>[0] = {
                    name: "HZB_MIPS_RT_LEVEL_" + mipsMipLevel,
                    depth: false,
                    autoResolve: false,
                    mipLevel: mipsMipLevel,
                    colorBuffer: buffer,
                    stencil: false,
                    samples: 1,
                }

                if (!depthByColor) {
                    optsMipRt.depth = true;
                    optsMipRt.colorBuffer = null!;
                    optsMipRt.depthBuffer = buffer;
                }

                rt = new pc.RenderTarget(optsMipRt);
                this._mipsBuffers[tmpMip] = buffer;

                tmpMip++;
            }
            else {

                const mipLevel = 0;
                const mipWidth = Math.max(1, this._globalMipWidth >> mip);
                const mipHeight = Math.max(1, this._globalMipHeight >> mip);

                buffer = new pc.Texture(this._device, {
                    name: "HZB_TX_" + mip,
                    width: mipWidth,
                    height: mipHeight,
                    format: format,
                    mipmaps: false,
                    minFilter: pc.FILTER_NEAREST,
                    magFilter: pc.FILTER_NEAREST,
                    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
                    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
                    storage: false,
                });

                const optsRt: ConstructorParameters<typeof pc.RenderTarget>[0] = {
                    name: "HZB_RT_LEVEL_" + mip,
                    depth: false,
                    autoResolve: false,
                    mipLevel: mipLevel,
                    colorBuffer: buffer,
                    stencil: false,
                    samples: 1,
                }

                if (!depthByColor) {
                    optsRt.depth = true;
                    optsRt.colorBuffer = null!;
                    optsRt.depthBuffer = buffer;
                }

                rt = new pc.RenderTarget(optsRt);
            }

            rps.shader = rpsShader;
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

    public destroy() {
        this._quadRenderPasses?.forEach(x => x?.destroy());
        this._renderTargets?.forEach(x => x?.destroy());
        this._buffers?.forEach(x => x?.destroy());
        this._mipsBuffers?.forEach(x => x?.destroy());
        this._copyShader?.destroy();
        this._shader?.destroy();
        this._texture1?.destroy();
        this._texture2?.destroy();
    }

    public calculateMipLevels(width: number, height: number): number {
        const maxSize = Math.max(width, height);
        return 1 + Math.floor(Math.log2(maxSize));
    }

    public getNearestMipLevel(width: number, height: number, target: number = 256) {

        const maxSize = Math.max(width, height);
        const mipLevels = this.calculateMipLevels(width, height);

        for (let i = 0; i < mipLevels; i++) {

            if (maxSize >> i <= target) {

                return i;
            }
        }

        return 0;
    }

    public update(camera: pc.Camera) {

        const device = this._device;

        // TODO: During testing on Android, the construction of
        // a mipmap texture showed poor performance;
        // we use a chain of levels.

        // TODO: need more test on devices
        const mainDepthTexture = (camera.renderPassDepthGrab as any)?.depthRenderTarget.depthBuffer;

        if (!mainDepthTexture) {
            return;
        }

        // TODO: check camera depth buffer viewport
        const { vx, vy, vw, vh, sx, sy, sw, sh } = device;
        const renderTarget = device.getRenderTarget();
        const mipLevels = this._minMipLevel + this._mipLevels;

        for (let mip = 0; mip < mipLevels; mip++) {

            const srcMip = mip - 1;
            const dstMip = mip;
            const srcWidth = Math.max(1, this._screenWidth >> mip);
            const srcHeight = Math.max(1, this._screenHeight >> mip);
            const srcBuffer = mip === 0 ? mainDepthTexture : this._buffers[srcMip];
            const readScreenDepth = mip === 0 ? 1 : 0;
            const includeSrcExtraColumn = srcWidth & 1;
            const includeSrcExtraRow = srcHeight & 1;
            const srcLevel = Math.max(srcMip - this._minMipLevel, 0);

            this._readScreenDepthScope.setValue(readScreenDepth);
            this._includeSrcExtraColumnScope.setValue(includeSrcExtraColumn);
            this._includeSrcExtraRowScope.setValue(includeSrcExtraRow);
            this._readLevelScope.setValue(srcLevel);
            this._depthMipScope.setValue(srcBuffer);
            this._quadRenderPasses[dstMip].render();
        }

        device.setRenderTarget(renderTarget);
        device.setViewport(vx, vy, vw, vh);
        device.setScissor(sx, sy, sw, sh);
    }
}