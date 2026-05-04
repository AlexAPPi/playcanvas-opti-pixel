// Shaders
import debugShaderGLSL from "./HierarchicalZBufferDebugger.glsl.js";
import debugShaderWGSL from "./HierarchicalZBufferDebugger.wgsl.js";
import pc from "../../engine.js";
import { isGPU2CPUReadbackOcclusionCullingTester, OCCLUSION_OCCLUDED, OCCLUSION_UNKNOWN } from "../IOcclusionCullingTester.js";
import { WebgpuHierarchicalZBuffer } from "./Webgpu/WebgpuHierarchicalZBuffer.js";
import { WebglHierarchicalZBuffer } from "./Webgl/WebglHierarchicalZBuffer.js";
import { IHierarchicalZBufferTester } from "./IHierarchicalZBufferTester.js";

export class HierarchicalZBufferDebugger {

    private _app: pc.AppBase;
    private _tester: IHierarchicalZBufferTester | undefined;
    private _hzb: WebglHierarchicalZBuffer | WebgpuHierarchicalZBuffer | undefined;
    private _debugAABBTexture: pc.Texture;
    private _debugTextureShaderDesc: any;

    public get hzb() { return (this._tester?.hzb ?? this._hzb)!; }
    public set hzbOrTester(v: WebglHierarchicalZBuffer | WebgpuHierarchicalZBuffer | IHierarchicalZBufferTester) {
        const initByHZB = (v instanceof WebglHierarchicalZBuffer || v instanceof WebgpuHierarchicalZBuffer);
        this._hzb = initByHZB ? v : undefined;
        this._tester = initByHZB ? undefined : v;
        this._initDeps();
    }

    constructor(app: pc.AppBase, hzbOrTester: WebglHierarchicalZBuffer | WebgpuHierarchicalZBuffer | IHierarchicalZBufferTester) {
        this._app = app;
        this._debugAABBTexture = new pc.Texture(this._app.graphicsDevice, {
            width: 1,
            height: 1,
            mipmaps: false,
            format: pc.PIXELFORMAT_RGBA8,
            minFilter: pc.FILTER_NEAREST,
            magFilter: pc.FILTER_NEAREST,
            addressU: pc.ADDRESS_CLAMP_TO_EDGE,
            addressV: pc.ADDRESS_CLAMP_TO_EDGE,
            numLevels: 1,
            levels: [new Uint8Array([255, 255, 0, 255])]
        });
        this.hzbOrTester = hzbOrTester;
        this._initDeps();
    }

    public destroy() {
        this._debugAABBTexture?.destroy();
        this._debugAABBTexture = null!;
    }

    private _initDeps() {

        const defines =
            !this.hzb.isColor() ?   '#define READ_DEPTH' :
             this.hzb.isFloat32() ? '#define DEPTH_IS_FLOAT' :
                                    '';

        this._debugTextureShaderDesc = this._app.scene.immediate.getShaderDesc('HZB_DEBUG_TEXTURE_SHADER',
            `
                ${defines}
                ${debugShaderGLSL}
            `,
            `
                ${defines}
                ${debugShaderWGSL}
            `
        );
    }

    public debug() {
        const m = this.hzb.mipLevels - 1;
        const h = Math.floor(m / 2);
        this.debugBuffer(0, 0.75, 0.5, 0.25, 0.25);
        this.debugBuffer(h, 0.75, 0.0, 0.25, 0.25);
        this.debugBuffer(m, 0.75, -0.5, 0.25, 0.25);
    }

    public debugBuffer(i: number, x: number, y: number, width: number, height: number) {

        if (!this.hzb.texture && !this.hzb.buffers) {
            return;
        }

        const buffer = (this.hzb.buffers?.[i] ?? this.hzb.texture)!;
        const debugMaterial = new pc.ShaderMaterial();
        debugMaterial.cull = pc.CULLFACE_NONE;
        debugMaterial.shaderDesc = this._debugTextureShaderDesc;
        debugMaterial.setParameter("uDepthMip", buffer);
        debugMaterial.setParameter("uDepthMipLevel", i);
        debugMaterial.update();
        this._app.drawTexture(x, y, width, height, buffer, debugMaterial);
    }

    public debugMipLevel(level: number) {
        this.debugBuffer(level, 0, 0, 2, 2);
    }

    public debugItem(index: number, box: boolean = true, rect: boolean = true, mipLevel: boolean = true) {

        if (!this._tester) {
            return;
        }

        const info = this._tester.getDebugInfo(index);
        const rectangle = info.rectangle;
        const boundingBox = info.boundingBox;

        let occlusionStatus = OCCLUSION_UNKNOWN;

        if (isGPU2CPUReadbackOcclusionCullingTester(this._tester)) {
            occlusionStatus = this._tester.getOcclusionStatus(index);
        }

        if (mipLevel) {
            this.debugMipLevel(info.lod);
        }

        if (info.inFrustum) {

            _minPoint.copy(boundingBox.center).sub(boundingBox.halfExtents);
            _maxPoint.copy(boundingBox.center).add(boundingBox.halfExtents);

            if (box) {
                this._app.drawWireAlignedBox(_minPoint, _maxPoint, occlusionStatus === OCCLUSION_OCCLUDED ? pc.Color.RED : pc.Color.GREEN, false);
            }

            if (rect) {
                this._app.drawTexture(rectangle.x, rectangle.y, rectangle.width, rectangle.height, this._debugAABBTexture, undefined!);
            }
        }
    }
}

const _minPoint = new pc.Vec3();
const _maxPoint = new pc.Vec3();