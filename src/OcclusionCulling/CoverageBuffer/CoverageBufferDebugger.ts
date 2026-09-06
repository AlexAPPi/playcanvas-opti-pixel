import debugShaderGLSL from "../HZB/HierarchicalZBufferDebugger.glsl.js";
import debugShaderWGSL from "../HZB/HierarchicalZBufferDebugger.wgsl.js";
import pc from "../../engine.js";
import { GPUBufferTool } from "../../Extras/GPUBufferTool.js";
import { OCCLUSION_OCCLUDED } from "../IOcclusionCullingTester.js";
import { CoverageCpuBuffer } from "./CoverageCpuBuffer.js";
import { WebglCoverageBuffer } from "./Webgl/WebglCoverageBuffer.js";
import { WebglCoverageBufferTester } from "./Webgl/WebglCoverageBufferTester.js";

/**
 * Overlay for {@link WebglCoverageBuffer}: GPU downsample chain, packed CPU
 * target, and the CPU-reprojected coverage buffer used for AABB tests.
 *
 * Each chain texture has no mipmaps, so sampling always uses lod 0.
 * Uses the same decode / Y-flip as {@link HierarchicalZBufferDebugger}
 * (`drawTexture` scales Y by -height).
 */
export class CoverageBufferDebugger {

    private _app: pc.AppBase;
    private _tester: WebglCoverageBufferTester | undefined;
    private _debugAABBTexture: pc.Texture;
    private _debugTextureShaderDesc: any;
    private _frameMaterials: pc.ShaderMaterial[] = [];
    private _onFrameEnd: pc.EventHandle | null = null;
    private _reprojectTexture: pc.Texture | null = null;
    private _reprojectRgba: Uint8Array<ArrayBuffer> | null = null;
    private _reprojectBits = new Uint32Array(1);
    private _reprojectFloat = new Float32Array(this._reprojectBits.buffer);

    public set tester(v: WebglCoverageBufferTester) {
        this._tester = v;
        this._initDeps();
    }

    public constructor(app: pc.AppBase, tester: WebglCoverageBufferTester) {
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
        this._onFrameEnd = app.on("frameend", this._recycleMaterials, this);
        this.tester = tester;
    }

    public destroy() {
        this._onFrameEnd?.off();
        this._onFrameEnd = null;
        this._recycleMaterials();
        this._reprojectTexture?.destroy();
        this._reprojectTexture = null;
        this._reprojectRgba = null;
        this._debugAABBTexture?.destroy();
        this._debugAABBTexture = null!;
    }

    private _initDeps() {

        const coverage = this._tester?.coverage;
        if (!coverage) {
            return;
        }

        const defines =
            !coverage.isColor() ?   "#define READ_DEPTH" :
             coverage.isFloat16() ? "#define DEPTH_IS_FLOAT16" :
             coverage.isFloat32() ? "#define DEPTH_IS_FLOAT" :
                                    "";

        this._debugTextureShaderDesc = this._app.scene.immediate.getShaderDesc("COVERAGE_DEBUG_TEXTURE_SHADER",
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

    /**
     * Right-side strip: GPU chain, packed CPU target, then the reprojected
     * test buffer (if a tester is bound).
     *
     * @param adaptive - Crop unused POT padding on chain levels via `uvFactor`
     * @param count - Number of chain levels to show; `0` = every pass
     */
    public debug(adaptive: boolean = true, count: number = 0, maxElementHeight: number = 0.25, spacing: number = 0.02, x: number = 0.75, w: number = 0.25) {

        const coverage = this._tester?.coverage;
        if (!coverage) {
            return;
        }

        const chain = Math.max(coverage.mipLevels | 0, 0);
        const nChain = count > 0 ? Math.min(count, chain) : chain;
        const showPacked = !!coverage.cpuTexture;
        const showReprojected = !!this._tester?.cpuBuffer.valid;
        const n = nChain + (showPacked ? 1 : 0) + (showReprojected ? 1 : 0);

        if (n <= 0) {
            return;
        }

        const autoElementHeight = Math.max(0.01, Math.min(2 / n, maxElementHeight) - spacing);
        const totalHeight = n * autoElementHeight + (n - 1) * spacing;
        const baseY = totalHeight / 2 - autoElementHeight / 2;
        const step = nChain <= 1 ? 0 : (chain - 1) / (nChain - 1);

        let row = 0;
        for (let i = 0; i < nChain; i++) {
            const level = Math.floor(i * step);
            const y = baseY - row * (autoElementHeight + spacing);
            this.debugBuffer(level, x, y, w, autoElementHeight, adaptive);
            row++;
        }

        if (showPacked) {
            this.debugPacked(x, baseY - row * (autoElementHeight + spacing), w, autoElementHeight);
            row++;
        }

        if (showReprojected) {
            this.debugReprojected(x, baseY - row * (autoElementHeight + spacing), w, autoElementHeight);
        }
    }

    /**
     * One GPU chain texture. `adaptive` crops unused POT padding via `uvFactor`.
     */
    public debugBuffer(i: number, x: number, y: number, width: number, height: number, adaptive: boolean = false) {

        const coverage = this._tester?.coverage;
        const buffers = coverage?.buffers;
        if (!coverage || !buffers || buffers.length === 0) {
            return;
        }

        const index = Math.max(0, Math.min(i | 0, buffers.length - 1));
        const buffer = buffers[index];
        if (!this._isTextureDrawable(buffer)) {
            return;
        }

        this._drawDepth(buffer, adaptive ? coverage.uvFactor : [1, 1], x, y, width, height);
    }

    /**
     * Packed full-screen target (`cpuTexture`). UV 0..1 maps to the camera.
     */
    public debugPacked(x: number = 0, y: number = 0, width: number = 2, height: number = 2) {

        const buffer = this._tester?.coverage?.cpuTexture;
        if (!this._isTextureDrawable(buffer)) {
            return;
        }

        this._drawDepth(buffer, [1, 1], x, y, width, height);
    }

    /**
     * CPU coverage after reprojection into the current camera. Requires a tester.
     * Remaining disocclusion after 3×3 min dilation is far (white).
     * Call after `tester.execute`.
     */
    public debugReprojected(x: number = 0, y: number = 0, width: number = 2, height: number = 2) {

        const buffer = this._uploadReprojected(this._tester?.cpuBuffer);
        if (!buffer) {
            return;
        }

        this._drawDepth(buffer, [1, 1], x, y, width, height);
    }

    /** One GPU chain level, fullscreen. */
    public debugMipLevel(level: number, adaptive: boolean = true) {
        this.debugBuffer(level, 0, 0, 2, 2, adaptive);
    }

    /**
     * Wire AABB and its screen rectangle. Requires a tester.
     *
     * @param packed - Overlay {@link debugPacked} unless `reprojected` is set
     * @param reprojected - Overlay {@link debugReprojected} (wins over `packed`)
     */
    public debugItem(index: number, box: boolean = true, rect: boolean = true, packed: boolean = false, reprojected: boolean = false) {

        if (!this._tester) {
            return;
        }

        const info = this._tester.getDebugInfo(index);
        const rectangle = info.rectangleScreen;
        const boundingBox = info.boundingBox;
        const occlusionStatus = this._tester.getOcclusionStatus(index);

        if (reprojected) {
            this.debugReprojected(0, 0, 2, 2);
        }
        else if (packed) {
            this.debugPacked(0, 0, 2, 2);
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

    private _uploadReprojected(cpuBuffer: CoverageCpuBuffer | undefined) {

        if (!cpuBuffer?.valid) {
            return null;
        }

        const w = cpuBuffer.width;
        const h = cpuBuffer.height;
        const n = w * h;
        const src = cpuBuffer.depth;
        if (src.length < n) {
            return null;
        }

        if (!this._reprojectTexture ||
            this._reprojectTexture.width !== w ||
            this._reprojectTexture.height !== h) {
            this._reprojectTexture?.destroy();
            this._reprojectRgba = new Uint8Array(n * 4);
            this._reprojectTexture = new pc.Texture(this._app.graphicsDevice, {
                name: "COVERAGE_DEBUG_REPROJECT_TX",
                width: w,
                height: h,
                mipmaps: false,
                format: pc.PIXELFORMAT_RGBA8,
                minFilter: pc.FILTER_NEAREST,
                magFilter: pc.FILTER_NEAREST,
                addressU: pc.ADDRESS_CLAMP_TO_EDGE,
                addressV: pc.ADDRESS_CLAMP_TO_EDGE
            });
        }

        const dst = this._reprojectRgba!;
        const bits = this._reprojectBits;
        const f32 = this._reprojectFloat;
        for (let i = 0; i < n; i++) {
            f32[0] = src[i];
            const b = bits[0];
            const o = i << 2;
            dst[o]     = (b >>> 24) & 255;
            dst[o + 1] = (b >>> 16) & 255;
            dst[o + 2] = (b >>> 8) & 255;
            dst[o + 3] = b & 255;
        }

        GPUBufferTool.updateOfTexture(this._reprojectTexture, dst, n, false);
        return this._reprojectTexture;
    }

    private _isTextureDrawable(buffer: pc.Texture | null | undefined): buffer is pc.Texture {
        return !!buffer && buffer.width > 0 && buffer.height > 0;
    }

    private _drawDepth(buffer: pc.Texture, uvFactor: [number, number], x: number, y: number, width: number, height: number) {

        if (!this._debugTextureShaderDesc) {
            return;
        }

        const debugMaterial = new pc.ShaderMaterial();
        debugMaterial.cull = pc.CULLFACE_NONE;
        debugMaterial.shaderDesc = this._debugTextureShaderDesc;
        debugMaterial.setParameter("uHZBFactor", uvFactor);
        debugMaterial.setParameter("uDepthMip", buffer);
        debugMaterial.setParameter("uDepthMipLevel", 0);
        debugMaterial.update();
        this._frameMaterials.push(debugMaterial);
        this._app.drawTexture(x, y, width, height, buffer, debugMaterial);
    }

    private _recycleMaterials() {
        for (let i = 0; i < this._frameMaterials.length; i++) {
            this._frameMaterials[i].destroy();
        }
        this._frameMaterials.length = 0;
    }
}

const _minPoint = new pc.Vec3();
const _maxPoint = new pc.Vec3();
