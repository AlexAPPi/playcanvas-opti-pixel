import debugShaderGLSL from "./CoverageBufferDebugger.glsl.js";
import debugShaderWGSL from "./CoverageBufferDebugger.wgsl.js";
import pc from "../../engine.js";
import { createDebugMarkerTexture, DebugScreenDrawer } from "../DebugScreenQuad.js";
import type { DebugScreenShader } from "../DebugScreenQuad.js";
import { OCCLUSION_OCCLUDED } from "../IOcclusionCullingTester.js";
import { ICoverageBuffer } from "./ICoverageBuffer.js";
import { CoverageBufferTesterWorker } from "./CoverageBufferTesterWorker.js";
import { CoverageCpuBufferViewer } from "./CoverageCpuBufferViewer.js";

export class CoverageBufferDebugger {

    private _app: pc.AppBase;
    private _wireRenderer: pc.WireRenderer;
    private _screen: DebugScreenDrawer;
    private _tester: CoverageBufferTesterWorker | undefined;
    private _debugAABBTexture: pc.Texture;
    private _packedUpload = createDebugFloatUpload();
    private _reprojectUpload = createDebugFloatUpload();

    public set tester(v: CoverageBufferTesterWorker) {
        this._tester = v;
    }

    public constructor(app: pc.AppBase, tester: CoverageBufferTesterWorker) {
        this._app = app;
        this._wireRenderer = new pc.WireRenderer(app);
        this._wireRenderer.depthTest = false;
        this._screen = new DebugScreenDrawer(app);
        this._debugAABBTexture = createDebugMarkerTexture(app.graphicsDevice);
        this.tester = tester;
    }

    public destroy() {
        this._screen.destroy();
        destroyDebugFloatUpload(this._packedUpload);
        destroyDebugFloatUpload(this._reprojectUpload);
        this._debugAABBTexture?.destroy();
        this._debugAABBTexture = null!;
    }

    public drawDepth(x: number = 0, y: number = 0, width: number = 2, height: number = 2) {

        const coverage = this._tester?.coverage;
        const buffer = this._uploadPacked(coverage);
        if (!buffer) {
            return;
        }

        this._drawDepth(buffer, coverage?.cpuCameraParams[1] || 1, x, y, width, height);
    }

    public drawReprojectedDepth(x: number = 0, y: number = 0, width: number = 2, height: number = 2) {

        const viewer = this._tester?.cpuViewer;
        const buffer = this._uploadReprojected(viewer);
        if (!buffer) {
            return;
        }

        this._drawDepth(buffer, viewer?.farClip || 1, x, y, width, height);
    }

    public debugItem(index: number, box: boolean = true, rect: boolean = true) {

        if (!this._tester) {
            return;
        }

        const info = this._tester.getDebugInfo(index);
        const rectangle = info.rectangleScreen;
        const boundingBox = info.boundingBox;
        const occlusionStatus = this._tester.getOcclusionStatus(index);

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

    private _uploadReprojected(viewer: CoverageCpuBufferViewer | undefined) {

        if (!viewer?.valid) {
            return null;
        }

        return this._uploadFloatDepth(
            viewer.depth,
            viewer.width,
            viewer.height,
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
        if (src.length < n) {
            return null;
        }

        if (!cache.texture ||
            cache.texture.width !== w ||
            cache.texture.height !== h ||
            cache.texture.format !== pc.PIXELFORMAT_R32F) {
            cache.texture?.destroy();
            cache.texture = new pc.Texture(this._app.graphicsDevice, {
                name,
                width: w,
                height: h,
                mipmaps: false,
                flipY: false,
                format: pc.PIXELFORMAT_R32F,
                minFilter: pc.FILTER_NEAREST,
                magFilter: pc.FILTER_NEAREST,
                addressU: pc.ADDRESS_CLAMP_TO_EDGE,
                addressV: pc.ADDRESS_CLAMP_TO_EDGE
            });
        }

        const locked = cache.texture.lock();
        new Float32Array(locked.buffer, locked.byteOffset, n).set(src.subarray(0, n));
        cache.texture.unlock();

        return cache.texture;
    }

    private _drawDepth(buffer: pc.Texture, far: number, x: number, y: number, width: number, height: number) {

        // The shader scales stored depth by 1/far.
        _coverageCameraParams[0] = far > 0 ? 1 / far : 1;
        this._screen.draw(x, y, width, height, COVERAGE_DEPTH_SHADER, {
            uDepthMip: buffer,
            camera_params: _coverageCameraParams
        });
    }
}

const COVERAGE_DEPTH_SHADER: DebugScreenShader = {
    name: "OPTIPIXEL_COVERAGE_DEBUG_R32F_SHADER",
    glsl: debugShaderGLSL,
    wgsl: debugShaderWGSL
};

const _minPoint = new pc.Vec3();
const _maxPoint = new pc.Vec3();
const _coverageCameraParams = new Float32Array([0, 1, 0, 1]);

interface IDebugFloatUpload {
    texture: pc.Texture | null;
}

function createDebugFloatUpload(): IDebugFloatUpload {
    return { texture: null };
}

function destroyDebugFloatUpload(cache: IDebugFloatUpload) {
    cache.texture?.destroy();
    cache.texture = null;
}
