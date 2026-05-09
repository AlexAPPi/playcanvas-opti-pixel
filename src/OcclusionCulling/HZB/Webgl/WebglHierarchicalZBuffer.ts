import { IHierarchicalZBuffer } from "../IHierarchicalZBuffer.js";
import vertexCodeVS from "./WebglHierarchicalZBuffer.vert.glsl.js";
import fragmentCodePS from "./WebglHierarchicalZBuffer.frag.glsl.js";
import pc from "../../../engine.js";

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

    /**
     * Maximum pixel size of the hzb texture.
     * - High-detail mip levels (mip 0,1) render outside mipmaps
     * - Android: solves driver bandwidth issues with shader mipmap rendering
     * - WebGL2: ping-pong textures bypass mipmap generation limits
     * - Shader: max(texture1, texture2) ensures reliable depth data
     */
    private _maxSize: number;
    private _width: number;
    private _heigth: number;
    private _mipLevels: number;
    private _minMipLevel: number;

    private _dispatchThreadIdToBufferUVScope: pc.ScopeId;
    private _inputViewportMaxBoundScope: pc.ScopeId;
    private _invSizeScope: pc.ScopeId;
    private _readScreenDepthScope: pc.ScopeId;
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
        this.resize(this.screenWidth, this.screenHeight, this._maxSize);
    }

    /**
     * Create Webgl hierarchical z buffer
     * 
     * @param device - The device
     * @param maxSize - The parameter sets the maximum pixel size of the hzb with mipmaps.
     */
    constructor(device: pc.WebglGraphicsDevice, maxSize: number = 256) {
        this._enabled = true;
        this._device = device;
        this._maxSize = maxSize;
        this._dispatchThreadIdToBufferUVScope = this._device.scope.resolve("uDispatchThreadIdToBufferUV");
        this._inputViewportMaxBoundScope = this._device.scope.resolve("uInputViewportMaxBound");
        this._readScreenDepthScope = this._device.scope.resolve("uReadScreenDepth");
        this._readLevelScope = this._device.scope.resolve("uReadLevel");
        this._invSizeScope = this._device.scope.resolve("uInvSize");
        this._depthMipScope = this._device.scope.resolve("uDepthMip");
        this.resize(this.device.width, this.device.height, maxSize);
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

    private _initShader() {

        const defines = new Map();

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

    public resize(width: number = this.screenWidth, height: number = this.screenHeight, maxSize: number = this.maxSize) {
        this.destroy();
        this._maxSize = maxSize;
        this._screenWidth = width | 0;
        this._screenHeight = height | 0;

        const numMipsX = Math.max(Math.ceil(Math.log2(this._screenWidth)) - 1, 1);
        const numMipsY = Math.max(Math.ceil(Math.log2(this._screenHeight)) - 1, 1);
        const numMips  = Math.max(numMipsX, numMipsY);

        this._globalMipWidth  = 1 << numMipsX;
        this._globalMipHeight = 1 << numMipsY;
        this._globalMipLevels = numMips;

        this._minMipLevel = this.getNearestMipLevel(this._globalMipWidth, this._globalMipHeight, this._maxSize);
        this._width       = this._globalMipWidth  >> this._minMipLevel;
        this._heigth      = this._globalMipHeight >> this._minMipLevel;
        this._mipLevels   = this._globalMipLevels - this._minMipLevel;

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
        const format = (
            !this.isColor()  ? pc.PIXELFORMAT_DEPTH :
            this.isFloat16() ? pc.PIXELFORMAT_R16F :
            this.isFloat32() ? pc.PIXELFORMAT_R32F :
                               pc.PIXELFORMAT_RGBA8
        );

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

                const mipLevel  = 0;
                const mipWidth  = Math.max(1, this._globalMipWidth >> mip);
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

    public getNearestMipLevel(width: number, height: number, target: number = 256) {

        const numMipsX = Math.max(Math.ceil(Math.log2(width)) - 1, 1);
        const numMipsY = Math.max(Math.ceil(Math.log2(height)) - 1, 1);
        const numMips  = Math.max(numMipsX, numMipsY);
        const maxSize  = Math.max(width, height);

        for (let i = 0; i < numMips; i++) {

            if (maxSize >> i <= target) {

                return i;
            }
        }

        return 0;
    }

    public update(camera: pc.Camera) {

        if (!this._enabled) {
            return;
        }

        const device = this._device;

        // TODO: During testing on Android, the construction of
        // a mipmap texture showed poor performance;
        // we use a chain of levels.

        // TODO: need more test on devices
        const mainDepthTexture = (camera.renderPassDepthGrab as any)?.depthRenderTarget.depthBuffer as pc.Texture;

        if (!mainDepthTexture) {
            return;
        }

        if (mainDepthTexture.width !== this.screenWidth ||
            mainDepthTexture.height !== this.screenHeight) {
            this.resize(mainDepthTexture.width, mainDepthTexture.height);
        }

        const { vx, vy, vw, vh, sx, sy, sw, sh } = device;
        const oldRenderTarget = device.getRenderTarget();
        const numMipLevels = this._minMipLevel + this._mipLevels;

        let srcLevel  = 0;
        let srcBuffer = mainDepthTexture;
        let srcWidth  = mainDepthTexture.width;
        let srcHeight = mainDepthTexture.height;
        let readScreenDepth = true;

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
            this._depthMipScope.setValue(srcBuffer);

            // Render to the current mip level
            this._quadRenderPasses[mip].render();

            readScreenDepth = false;
            srcLevel  = Math.max(0, mip - this._minMipLevel);
            srcWidth  = Math.max(1, this._globalMipWidth >> mip);
            srcHeight = Math.max(1, this._globalMipHeight >> mip);
            srcBuffer = this._buffers[mip];

            mip++;

            if (mip === 1) {
                _viewportMaxBoundArr[0] = 1;
                _viewportMaxBoundArr[1] = 1;
            }
        }
        while (mip < numMipLevels);

        device.setRenderTarget(oldRenderTarget);
        device.setViewport(vx, vy, vw, vh);
        device.setScissor(sx, sy, sw, sh);
    }
}

const _invSizeArr = new Float32Array(2);
const _viewportMaxBoundArr = new Float32Array(2);
const _dispatchThreadIdToBufferUVArr = new Float32Array(4);