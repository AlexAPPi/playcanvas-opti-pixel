import { isGPU2CPUReadbackOcclusionCulling, OCCLUSION_OCCLUDED, OCCLUSION_UNKNOWN, type IOcclusionCullingTester } from "../IOcclusionCullingTester";
import { WebgpuHierarchicalZBuffer } from "./Webgpu/WebgpuHierarchicalZBuffer";
import { WebglHierarchicalZBuffer } from "./Webgl/WebglHierarchicalZBuffer";
import { IHierarchicalZBuffer } from "./IHierarchicalZBuffer";
import pc from "../../engine";

export interface IDebugInfo {
    inFrustum: boolean,
    lod: number,
    viewSize: pc.Vec2,
    boundingBox: {
        center: pc.Vec3,
        halfExtends: pc.Vec3,
    },
    rectangle: {
        x: number,
        y: number,
        width: number,
        height: number,
    }
}

export interface IHierarchicalZBufferTester extends IOcclusionCullingTester {

    readonly dataTexture: pc.Texture;

    hzb: IHierarchicalZBuffer;

    frameUpdate(): void;

    getDebugInfo(index: number): IDebugInfo;
}

export class HierarchicalZBufferDebugger {

    private _app: pc.AppBase;
    private _hzbTester: IHierarchicalZBufferTester | undefined;
    private _hzb: WebglHierarchicalZBuffer | WebgpuHierarchicalZBuffer | undefined;
    private _debugAABBTexture: pc.Texture;
    private _debugTextureShaderDesc: any;

    public get hzb() { return (this._hzbTester?.hzb ?? this._hzb)!; }
    public set hzbOrTester(v: WebglHierarchicalZBuffer | WebgpuHierarchicalZBuffer | IHierarchicalZBufferTester) {
        const initByHZB = (v instanceof WebglHierarchicalZBuffer || v instanceof WebgpuHierarchicalZBuffer);
        this._hzb = initByHZB ? v : undefined;
        this._hzbTester = initByHZB ? undefined : v;
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

        this._debugTextureShaderDesc = this._app.scene.immediate.getShaderDesc('HZB_DEBUG_TEXTURE_SHADER',
            `
                ${!this.hzb.isColor() ?   '#define READ_DEPTH' :
                   this.hzb.isFloat32() ? '#define DEPTH_IS_FLOAT' : ''}

                #include "floatAsUintPS"
                #include "gammaPS"
                varying vec2 uv0;

                uniform vec4 camera_params;
                uniform float uDepthMipLevel;
                uniform highp sampler2D uDepthMip;

                float linearizeDepth(float z) {
                    if (camera_params.w == 0.0) {
                        return (camera_params.z * camera_params.y) / (camera_params.y + z * (camera_params.z - camera_params.y));
                    }
                    return camera_params.z + z * (camera_params.y - camera_params.z);
                }

                float extractDepthFromData(vec4 data) {
                    #ifdef (DEPTH_IS_FLOAT || READ_DEPTH)
                        return data.r;
                    #else
                        return uint2float(data);
                    #endif
                }

                float getLinearScreenDepth(vec2 uv) {
                    vec4 depthData = textureLod(uDepthMip, uv, uDepthMipLevel);
                    float depth = extractDepthFromData(depthData);
                    return linearizeDepth(depth);
                }

                void main() {
                    vec2 mirrorYUV = vec2(uv0.x, 1.0 - uv0.y);
                    float depth = getLinearScreenDepth(getImageEffectUV(mirrorYUV)) * camera_params.x;
                    gl_FragColor = vec4(gammaCorrectOutput(vec3(depth)), 1.0);
                }
            `,
            `
                ${!this.hzb.isColor() ?   '#define READ_DEPTH' :
                   this.hzb.isFloat32() ? '#define DEPTH_IS_FLOAT' : ''}

                #include "floatAsUintPS"
                #include "gammaPS"
                varying uv0: vec2f;

                uniform uDepthMipLevel: f32;
                uniform camera_params: vec4f;

                var uDepthMip: texture_2d<f32>;
                var uDepthMipSampler: sampler;

                fn linearizeDepth(z: f32, cameraParams: vec4f) -> f32 {
                    if (cameraParams.w == 0.0) {
                        return (cameraParams.z * cameraParams.y) / (cameraParams.y + z * (cameraParams.z - cameraParams.y));
                    }
                    return cameraParams.z + z * (cameraParams.y - cameraParams.z);
                }

                fn extractDepthFromData(data: vec4f) -> f32 {
                    #ifdef (DEPTH_IS_FLOAT || READ_DEPTH)
                        return data.r;
                    #else
                        return uint2float(data);
                    #endif
                }

                fn getLinearScreenDepth(uv: vec2<f32>, depthMipLevel: f32, cameraParams: vec4f) -> f32 {
                    let depthData = textureSampleLevel(uDepthMip, uDepthMipSampler, uv, depthMipLevel);
                    let depthSample = extractDepthFromData(depthData);
                    return linearizeDepth(depthSample, cameraParams);
                }

                @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
                    var output: FragmentOutput;
                    let mirrorYUV = vec2<f32>(input.uv0.x, 1.0 - input.uv0.y);
                    let depth: f32 = getLinearScreenDepth(getImageEffectUV(mirrorYUV), uniform.uDepthMipLevel, uniform.camera_params) * uniform.camera_params.x;
                    output.color = vec4f(gammaCorrectOutput(vec3f(depth)), 1.0);
                    return output;
                };
            `
        );
    }

    public debug() {

        const m = this.hzb.mipLevels - 1;
        const h = Math.floor(m / 2);

        this.debugBuffer(0, 0.75, 0.5, 0.25, 0.25);
        this.debugBuffer(h, 0.75, 0.0, 0.25, 0.25);
        this.debugBuffer(m, 0.75, -0.5, 0.25, 0.25);

        //this._app.drawTexture(-0.25, -0.5, 0.25, 0.25, this._hzbTester.resultTexture, undefined!);
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

        if (!this._hzbTester) {
            return;
        }

        const info = this._hzbTester.getDebugInfo(index);
        const rectangle = info.rectangle;
        const boundingBox = info.boundingBox;

        let occlusionStatus = OCCLUSION_UNKNOWN;

        if (isGPU2CPUReadbackOcclusionCulling(this._hzbTester)) {
            occlusionStatus = this._hzbTester.getOcclusionStatus(index);
        }

        if (mipLevel) {
            this.debugMipLevel(info.lod);
        }

        if (info.inFrustum) {

            _minPoint.copy(boundingBox.center).sub(boundingBox.halfExtends);
            _maxPoint.copy(boundingBox.center).add(boundingBox.halfExtends);

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