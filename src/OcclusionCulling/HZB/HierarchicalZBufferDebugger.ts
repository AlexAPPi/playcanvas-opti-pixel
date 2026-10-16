import debugShaderGLSL from "./HierarchicalZBufferDebugger.glsl.js";
import debugShaderWGSL from "./HierarchicalZBufferDebugger.wgsl.js";
import pc from "../../engine.js";
import { createDebugMarkerTexture, DebugScreenDrawer } from "../DebugScreenQuad.js";
import type { DebugScreenShader } from "../DebugScreenQuad.js";
import { isGPU2CPUReadbackOcclusionCullingTester, OCCLUSION_OCCLUDED, OCCLUSION_UNKNOWN } from "../IOcclusionCullingTester.js";
import { WebgpuHierarchicalZBuffer } from "./Webgpu/WebgpuHierarchicalZBuffer.js";
import { WebglHierarchicalZBuffer } from "./Webgl/WebglHierarchicalZBuffer.js";
import { IHierarchicalZBufferTester } from "./IHierarchicalZBufferTester.js";

export class HierarchicalZBufferDebugger {

    private _wireRenderer: pc.WireRenderer;
    private _tester: IHierarchicalZBufferTester | undefined;
    private _hzb: WebglHierarchicalZBuffer | WebgpuHierarchicalZBuffer | undefined;
    private _screen: DebugScreenDrawer;
    private _debugAABBTexture: pc.Texture;
    private _depthShaders = new Map<HzbDepthVariant, DebugScreenShader>();

    public get hzb() { return (this._tester?.hzb ?? this._hzb)!; }
    public set hzbOrTester(v: WebglHierarchicalZBuffer | WebgpuHierarchicalZBuffer | IHierarchicalZBufferTester) {
        const initByHZB = (v instanceof WebglHierarchicalZBuffer || v instanceof WebgpuHierarchicalZBuffer);
        this._hzb = initByHZB ? v : undefined;
        this._tester = initByHZB ? undefined : v;
    }

    constructor(app: pc.AppBase, hzbOrTester: WebglHierarchicalZBuffer | WebgpuHierarchicalZBuffer | IHierarchicalZBufferTester) {
        this._wireRenderer = new pc.WireRenderer(app);
        this._wireRenderer.depthTest = false;
        this._screen = new DebugScreenDrawer(app);
        this._debugAABBTexture = createDebugMarkerTexture(app.graphicsDevice);
        this.hzbOrTester = hzbOrTester;
    }

    public destroy() {
        this._screen.destroy();
        this._debugAABBTexture?.destroy();
        this._debugAABBTexture = null!;
    }

    public debug(count: number = 5, maxElementHeight: number = 0.25, spacing: number = 0.02, x: number = 0.75, w: number = 0.25) {

        if (count <= 0) {
            return;
        }

        const lastMip = this.hzb.mipLevels - 1;
        const step = count > 1 ? lastMip / (count - 1) : 0;
        const elementHeight = Math.min(2 / count, maxElementHeight) - spacing;
        const totalHeight = count * elementHeight + (count - 1) * spacing;
        const baseY = totalHeight / 2 - elementHeight / 2;

        for (let i = 0; i < count; i++) {
            const level = Math.floor(i * step);
            const y = baseY - i * (elementHeight + spacing);
            this.debugBuffer(level, x, y, w, elementHeight);
        }
    }

    public debugBuffer(i: number, x: number, y: number, width: number, height: number, adaptive: boolean = false) {

        if (!this.hzb.texture && !this.hzb.buffers) {
            return;
        }

        const buffer = (this.hzb.buffers?.[i] ?? this.hzb.texture)!;
        this._screen.draw(x, y, width, height, this._depthShader(), {
            uHZBFactor: adaptive ? this.hzb.uvFactor : HZB_FULL_UV,
            uDepthMip: buffer,
            uDepthMipLevel: i
        });
    }

    public debugMipLevel(level: number, adaptive: boolean = true) {
        this.debugBuffer(level, 0, 0, 2, 2, adaptive);
    }

    public debugItem(index: number, box: boolean = true, rect: boolean = true, mipLevel: boolean = true, adaptiveMipLevel: boolean = true) {

        if (!this._tester) {
            return;
        }

        const info = this._tester.getDebugInfo(index);
        const rectangle = info.rectangleScreen;
        const boundingBox = info.boundingBox;

        let occlusionStatus = OCCLUSION_UNKNOWN;

        if (isGPU2CPUReadbackOcclusionCullingTester(this._tester)) {
            occlusionStatus = this._tester.getOcclusionStatus(index);
        }

        if (mipLevel) {
            this.debugMipLevel(info.lod, adaptiveMipLevel);
        }

        if (info.inFrustum) {

            _minPoint.copy(boundingBox.center).sub(boundingBox.halfExtents);
            _maxPoint.copy(boundingBox.center).add(boundingBox.halfExtents);

            if (box) {
                this._wireRenderer.color.copy(occlusionStatus === OCCLUSION_OCCLUDED ? pc.Color.RED : pc.Color.GREEN);
                this._wireRenderer.boxMinMax(_minPoint, _maxPoint);
            }

            if (rect) {
                this._screen.drawTexture(rectangle.x, rectangle.y, rectangle.width, rectangle.height, this._debugAABBTexture);
            }
        }
    }

    private _depthShader(): DebugScreenShader {

        const variant = this._depthVariant();
        const cached = this._depthShaders.get(variant);
        if (cached) {
            return cached;
        }

        const desc = HZB_VARIANT[variant];
        const header = desc.define ? `${desc.define}\n` : "";
        const shader: DebugScreenShader = {
            name: desc.name,
            glsl: header + debugShaderGLSL,
            wgsl: header + debugShaderWGSL
        };
        this._depthShaders.set(variant, shader);
        return shader;
    }

    private _depthVariant(): HzbDepthVariant {

        const hzb = this.hzb;
        if (!hzb.isColor()) {
            return "depth";
        }

        if (hzb.isFloat16()) {
            return "float16";
        }

        if (hzb.isFloat32()) {
            return "float32";
        }

        return "uint";
    }
}

const HZB_VARIANT = {
    depth: { name: "OPTIPIXEL_HZB_DEBUG_DEPTH", define: "#define READ_DEPTH" },
    float16: { name: "OPTIPIXEL_HZB_DEBUG_FLOAT16", define: "#define DEPTH_IS_FLOAT16" },
    float32: { name: "OPTIPIXEL_HZB_DEBUG_FLOAT32", define: "#define DEPTH_IS_FLOAT" },
    uint: { name: "OPTIPIXEL_HZB_DEBUG_UINT", define: "" }
} as const;

type HzbDepthVariant = keyof typeof HZB_VARIANT;

const HZB_FULL_UV: [number, number] = [1, 1];

const _minPoint = new pc.Vec3();
const _maxPoint = new pc.Vec3();