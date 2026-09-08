import debugShaderGLSL from "../HZB/HierarchicalZBufferDebugger.glsl.js";
import debugShaderWGSL from "../HZB/HierarchicalZBufferDebugger.wgsl.js";
import pc from "../../engine.js";
import { GPUBufferTool } from "../../Extras/GPUBufferTool.js";
import { OCCLUSION_OCCLUDED } from "../IOcclusionCullingTester.js";
import { CoverageBufferTester } from "./CoverageBufferTester.js";
import { CoverageCpuBuffer } from "./CoverageCpuBuffer.js";
import { ICoverageBuffer } from "./ICoverageBuffer.js";

/**
 * Overlay for coverage GPU 256∶128 downsample chain, CPU readback target,
 * and the reprojected test buffer used for AABB tests.
 *
 * Each chain texture has no mipmaps, so sampling always uses lod 0.
 * Uses the same decode / Y-flip as {@link HierarchicalZBufferDebugger}
 * (`drawTexture` scales Y by -height).
 */
export class CoverageBufferDebugger {

    private _app: pc.AppBase;
    private _tester: CoverageBufferTester | undefined;
    private _debugAABBTexture: pc.Texture;
    private _debugTextureShaderDesc: any;
    private _frameMaterials: pc.ShaderMaterial[] = [];
    private _onFrameEnd: pc.EventHandle | null = null;
    private _packedUpload = createDebugFloatUpload();
    private _reprojectUpload = createDebugFloatUpload();

    public set tester(v: CoverageBufferTester) {
        this._tester = v;
        this._initDeps();
    }

    public constructor(app: pc.AppBase, tester: CoverageBufferTester) {
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
        destroyDebugFloatUpload(this._packedUpload);
        destroyDebugFloatUpload(this._reprojectUpload);
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
     * Right-side strip: GPU chain, packed CPU download, then the reprojected test buffer.
     */
    public debug(count: number = 0, maxElementHeight: number = 0.25, spacing: number = 0.02, x: number = 0.75, w: number = 0.25) {

        const coverage = this._tester?.coverage;
        if (!coverage) {
            return;
        }

        const chain = Math.max(coverage.mipLevels | 0, 0);
        const nChain = count > 0 ? Math.min(count, chain) : chain;
        const showPacked = !!coverage.cpuReady;
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
            this.debugBuffer(level, x, y, w, autoElementHeight);
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
     * One GPU chain texture. Coverage has no POT padding.
     */
    public debugBuffer(i: number, x: number, y: number, width: number, height: number) {

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

        this._drawDepth(buffer, coverage.uvFactor, x, y, width, height);
    }

    /**
     * Packed CPU download (view-space Z after GPU→CPU readback, not yet reprojected).
     * UV 0..1 maps to the camera. Call after `tester.execute`.
     */
    public debugPacked(x: number = 0, y: number = 0, width: number = 2, height: number = 2) {

        const buffer = this._uploadPacked(this._tester?.coverage);
        if (!buffer) {
            return;
        }

        this._drawDepth(buffer, [1, 1], x, y, width, height, true);
    }

    /**
     * CPU coverage after reprojection into the current camera. Requires a tester.
     * Remaining scatter holes after 3×3 far fill are white (view Z = far).
     * Call after `tester.execute`.
     */
    public debugReprojected(x: number = 0, y: number = 0, width: number = 2, height: number = 2) {

        const buffer = this._uploadReprojected(this._tester?.cpuBuffer);
        if (!buffer) {
            return;
        }

        this._drawDepth(buffer, [1, 1], x, y, width, height, true);
    }

    public debugMipLevel(level: number) {
        this.debugBuffer(level, 0, 0, 2, 2);
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

    private _uploadPacked(coverage: ICoverageBuffer | undefined) {

        if (!coverage?.cpuReady) {
            return null;
        }

        return this._uploadFloatDepth(
            coverage.cpuDepth,
            coverage.cpuWidth,
            coverage.cpuHeight,
            this._packedUpload,
            "COVERAGE_DEBUG_PACKED_TX"
        );
    }

    private _uploadReprojected(cpuBuffer: CoverageCpuBuffer | undefined) {

        if (!cpuBuffer?.valid) {
            return null;
        }

        return this._uploadFloatDepth(
            cpuBuffer.depth,
            cpuBuffer.width,
            cpuBuffer.height,
            this._reprojectUpload,
            "COVERAGE_DEBUG_REPROJECT_TX"
        );
    }

    private _uploadFloatDepth(
        src: Float32Array,
        w: number,
        h: number,
        cache: IDebugFloatUpload,
        name: string
    ) {

        const n = w * h;
        const nBytes = n << 2;

        if (src.length < n) {
            return null;
        }

        if (!cache.texture ||
            cache.texture.width !== w ||
            cache.texture.height !== h) {
            cache.texture?.destroy();
            cache.rgba = new Uint8Array(n * 4) as Uint8Array<ArrayBuffer>;
            cache.texture = new pc.Texture(this._app.graphicsDevice, {
                name,
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

        if (!cache.srcBytes || cache.src !== src || cache.srcBytes.length !== nBytes) {
            cache.src = src;
            cache.srcBytes = new Uint8Array(src.buffer, src.byteOffset, nBytes);
        }

        const srcBytes = cache.srcBytes;
        const dst = cache.rgba!;
        // Packed CPU is GL/NDC order (row 0 = bottom). WebGPU texture row 0 is top.
        const flipY = this._app.graphicsDevice.isWebGPU;

        for (let y = 0; y < h; y++) {
            const srcY = flipY ? (h - 1 - y) : y;
            const srcRow = srcY * w * 4;
            const dstRow = y * w * 4;
            for (let i = 0; i < w * 4; i += 4) {
                dst[dstRow + i]     = srcBytes[srcRow + i + 3];
                dst[dstRow + i + 1] = srcBytes[srcRow + i + 2];
                dst[dstRow + i + 2] = srcBytes[srcRow + i + 1];
                dst[dstRow + i + 3] = srcBytes[srcRow + i];
            }
        }

        GPUBufferTool.updateOfTexture(cache.texture, dst, n, false);
        return cache.texture;
    }

    private _isTextureDrawable(buffer: pc.Texture | null | undefined): buffer is pc.Texture {
        return !!buffer && buffer.width > 0 && buffer.height > 0;
    }

    private _drawDepth(buffer: pc.Texture, uvFactor: [number, number], x: number, y: number, width: number, height: number, linearViewZ: boolean = false) {

        if (!this._debugTextureShaderDesc) {
            return;
        }

        const debugMaterial = new pc.ShaderMaterial();
        debugMaterial.cull = pc.CULLFACE_NONE;
        debugMaterial.shaderDesc = this._debugTextureShaderDesc;
        debugMaterial.setParameter("uHZBFactor", uvFactor);
        debugMaterial.setParameter("uDepthMip", buffer);
        debugMaterial.setParameter("uDepthMipLevel", 0);
        if (linearViewZ) {
            const far = this._tester?.cpuBuffer.farClip || 1;
            _debugCamParams[0] = far > 0 ? 1 / far : 1;
            _debugCamParams[1] = 1;
            _debugCamParams[2] = 0;
            _debugCamParams[3] = 1;
            debugMaterial.setParameter("camera_params", _debugCamParams);
        }
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
const _debugCamParams = new Float32Array(4);

interface IDebugFloatUpload {
    texture: pc.Texture | null;
    rgba: Uint8Array<ArrayBuffer> | null;
    src: Float32Array | null;
    srcBytes: Uint8Array | null;
}

function createDebugFloatUpload(): IDebugFloatUpload {
    return { texture: null, rgba: null, src: null, srcBytes: null };
}

function destroyDebugFloatUpload(cache: IDebugFloatUpload) {
    cache.texture?.destroy();
    cache.texture = null;
    cache.rgba = null;
    cache.src = null;
    cache.srcBytes = null;
}
