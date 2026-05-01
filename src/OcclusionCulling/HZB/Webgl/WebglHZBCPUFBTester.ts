import { GPUAABBStore } from "../../../Extras/GPUAABBStore";
import { WebglHierarchicalZBuffer } from "./WebglHierarchicalZBuffer";
import { IHierarchicalZBufferTester } from "../HierarchicalZBufferDebugger";
import { HZBTStateQueue } from "./HZBTStateQueue";
import type { IGPU2CPUReadbackOcclusionCullingTester, TOcclusionResult } from "../../IOcclusionCullingTester";
import pc from "../../../engine";

export class WebglHZBCPUFBTester extends GPUAABBStore implements IHierarchicalZBufferTester, IGPU2CPUReadbackOcclusionCullingTester {

    readonly supportGCPUReadback = true;

    private _hzb: WebglHierarchicalZBuffer;
    private _shader: pc.Shader;
    private _hzbListScope: pc.ScopeId[];
    private _hzbScope1: pc.ScopeId;
    private _hzbScope2: pc.ScopeId;
    private _hzbSizeScope: pc.ScopeId;
    private _screenSizeScope: pc.ScopeId;
    private _dataTextureScope: pc.ScopeId;
    private _matrixViewProjectionScope: pc.ScopeId;
    private _queue: HZBTStateQueue;

    public get hzb() { return this._hzb; }
    public set hzb(v: WebglHierarchicalZBuffer) {
        this._hzb = v;
        this._updateScopes();
        this._updateShader();
    }

    constructor(hzb: WebglHierarchicalZBuffer, capacity: number = 512) {
        super(hzb.device, capacity);
        this._hzb = hzb;
        this._queue = new HZBTStateQueue(hzb.device, this._indexManager);
        this._updateScopes();
        this._updateShader();
    }

    private _clearScopes() {
    }

    private _updateScopes() {

        this._clearScopes();
        this._hzbSizeScope = this.device.scope.resolve("uHZBSize");
        this._screenSizeScope = this.device.scope.resolve("uScreenSize");
        this._dataTextureScope = this.device.scope.resolve("uDataTexture");
        this._matrixViewProjectionScope = this.device.scope.resolve("uMatrixViewProjection");

        if (this._hzb.texture) {
            this._hzbScope1 = this.device.scope.resolve("uHZB1");
            this._hzbScope2 = this.device.scope.resolve("uHZB2");
        }
        else if (this._hzb.buffers) {
            this._hzbListScope = new Array(this._hzb.mipLevels);
            for (let i = 0; i < this._hzb.mipLevels; i++) {
                this._hzbListScope[i] = this.device.scope.resolve("uHZB" + i);
            }
        }
    }

    private _updateShader() {

        const defines = new Map();
        const minLevel = 0;
        const mipLevels = this.hzb.mipLevels;

        if (!this.hzb.isColor()) {
            defines.set("READ_DEPTH", "");
        }
        else if (this.hzb.isFloat32()) {
            defines.set("DEPTH_IS_FLOAT", "");
        }

        defines.set("MIN_LEVEL", (minLevel).toFixed(1));
        defines.set("MAX_LEVEL", (mipLevels - 1).toFixed(1));

        const getDepthPS = getDepthPSCode(mipLevels, !!this._hzb.texture);
        const vertexIncludes = new Map();

        vertexIncludes.set("getDepthPS", getDepthPS);

        this._shader?.destroy();
        this._shader = pc.ShaderUtils.createShader(this.device, {
            uniqueName: "HZB_OCCLUSION_SHADER",
            useTransformFeedback: true,
            vertexGLSL: vertexCodeVS,
            fragmentGLSL: 'void main(void) { gl_FragColor = vec4(1.0); }',
            vertexDefines: defines,
            vertexIncludes: vertexIncludes,
            attributes: {
                aBoundingBoxIndex: pc.SEMANTIC_POSITION,
            }
        });

        if (this.device.isWebGL2) {

            const gl = (this._device as pc.WebglGraphicsDevice).gl;
            const glProgram = this._shader.impl.glProgram;

            gl.transformFeedbackVaryings(glProgram, ["out_flags"], gl.INTERLEAVED_ATTRIBS);
            gl.linkProgram(glProgram);
        }
    }

    public destroy() {
        super.destroy();
        this._clearScopes();
        this._queue.destroy();
    }

    public resize(count: number): void {
        super.resize(count);
        this._queue.resize();
    }

    public frameUpdate() {
        this._queue.test();
    }

    public enqueue(index: number, extra?: number | number[] | undefined) {
        this._queue.enqueue(index, extra);
    }

    private _internalTest(camera: pc.Camera) {

        const state = this._queue.next();
        const viewMatrix = camera.viewMatrix;
        const projectionMatrix = camera.projectionMatrix;

        _modelViewProjection.mul2(projectionMatrix, viewMatrix);

        if (state && state.count > 0) {

            const count = state.count;
            const device = this.device as pc.WebglGraphicsDevice;
            const oldRt = device.getRenderTarget();

            state.indexQueue.update();

            device.setRenderTarget(null);
            device.updateBegin();
            device.setVertexBuffer(state.indexQueue.vertexBuffer);
            device.setRaster(false);
            device.setTransformFeedbackBuffer(state.outputBuffer);
            device.setShader(this._shader);

            _screenSizeArr[0] = this.hzb.screenWidth;
            _screenSizeArr[1] = this.hzb.screenHeight;

            _hzbSizeArr[0] = this.hzb.width;
            _hzbSizeArr[1] = this.hzb.height;

            this._dataTextureScope.setValue(this.dataTexture);
            this._screenSizeScope.setValue(_screenSizeArr);
            this._hzbSizeScope.setValue(_hzbSizeArr);

            // TODO: mobile android hzb slowed
            if (this._hzb.texture) {
                this._hzbScope1.setValue(this._hzb.texture);
                this._hzbScope2.setValue(this._hzb.texture2);
            }
            else if (this._hzb.buffers) {
                for (let i = 0; i < this._hzb.mipLevels; i++) {
                    this._hzbListScope[i].setValue(this._hzb.buffers[i]);
                }
            }

            this._matrixViewProjectionScope.setValue(_modelViewProjection.data);

            // @ts-ignore
            device.draw({
                type: pc.PRIMITIVE_POINTS,
                base: 0,
                baseVertex: 0,
                count,
                indexed: false
            });

            device.setTransformFeedbackBuffer(null!);
            device.setRaster(true);
            device.updateEnd();
            device.setRenderTarget(oldRt);
        }

        return state;
    }

    public async execute(camera: pc.Camera) {

        if (this.hzb.enabled) {

            this.update();

            const state = this._internalTest(camera);

            if (state) {
                await state.read();
            }
        }
    }

    public getOcclusionStatus(index: number): TOcclusionResult {
        return this._queue.getOcclusionStatus(index);
    }

    public getDebugInfo(index: number) {
        return getDebugInfo(index, _modelViewProjection, this);
    }
}

const _hzbSizeArr = new Float32Array(2);
const _screenSizeArr = new Float32Array(2);
const _modelViewProjection = new pc.Mat4();

const _boundingBox = [new pc.Vec4(), new pc.Vec4(), new pc.Vec4(), new pc.Vec4(), new pc.Vec4(), new pc.Vec4(), new pc.Vec4(), new pc.Vec4()];
const _boxCenterWorld = new pc.Vec3();
const _boxHalfExtends = new pc.Vec3();
const _hzbSize = new pc.Vec2();
const _minCoord = new pc.Vec2();
const _maxCoord = new pc.Vec2();

const getDebugInfo = (
    index: number,
    matrix: pc.Mat4,
    tester: WebglHZBCPUFBTester
) => {
    const data = tester.dataTexture._levels[0] as Float32Array;
    const dataIndex = index * 16;
    const bbCenter = _boxCenterWorld.set(data[dataIndex + 0], data[dataIndex + 1], data[dataIndex + 2]);
    const bbHalfExtends = _boxHalfExtends.set(data[dataIndex + 4], data[dataIndex + 5], data[dataIndex + 6]);

    _boundingBox[0].set(bbCenter.x +  bbHalfExtends.x, bbCenter.y +  bbHalfExtends.y, bbCenter.z +  bbHalfExtends.z, 1.0);
    _boundingBox[1].set(bbCenter.x + -bbHalfExtends.x, bbCenter.y +  bbHalfExtends.y, bbCenter.z +  bbHalfExtends.z, 1.0);
    _boundingBox[2].set(bbCenter.x +  bbHalfExtends.x, bbCenter.y + -bbHalfExtends.y, bbCenter.z +  bbHalfExtends.z, 1.0);
    _boundingBox[3].set(bbCenter.x + -bbHalfExtends.x, bbCenter.y + -bbHalfExtends.y, bbCenter.z +  bbHalfExtends.z, 1.0);
    _boundingBox[4].set(bbCenter.x +  bbHalfExtends.x, bbCenter.y +  bbHalfExtends.y, bbCenter.z + -bbHalfExtends.z, 1.0);
    _boundingBox[5].set(bbCenter.x + -bbHalfExtends.x, bbCenter.y +  bbHalfExtends.y, bbCenter.z + -bbHalfExtends.z, 1.0);
    _boundingBox[6].set(bbCenter.x +  bbHalfExtends.x, bbCenter.y + -bbHalfExtends.y, bbCenter.z + -bbHalfExtends.z, 1.0);
    _boundingBox[7].set(bbCenter.x + -bbHalfExtends.x, bbCenter.y + -bbHalfExtends.y, bbCenter.z + -bbHalfExtends.z, 1.0);

    let minCoordX = 1e6;
    let minCoordY = 1e6;
    let maxCoordX = -1e6;
    let maxCoordY = -1e6;
    let instanceMinDepth = 1e6;

    let outXPos = 0;
    let outXNeg = 0;
    let outYPos = 0;
    let outYNeg = 0;
    let outZPos = 0;
    let outZNeg = 0;

    for (let i = 0; i < 8; i++) {

        matrix.transformVec4(_boundingBox[i], _boundingBox[i]);

        const current = _boundingBox[i];

        if (current.x >  current.w) outXPos++;
        if (current.x < -current.w) outXNeg++;
        if (current.y >  current.w) outYPos++;
        if (current.y < -current.w) outYNeg++;
        if (current.z >  current.w) outZPos++;
        if (current.z < -current.w) outZNeg++;

        current.x /= current.w;
        current.y /= current.w;
        current.z /= current.w;

        minCoordX = Math.min(minCoordX, current.x);
        minCoordY = Math.min(minCoordY, current.y);
        maxCoordX = Math.max(maxCoordX, current.x);
        maxCoordY = Math.max(maxCoordY, current.y);

        instanceMinDepth = Math.min(instanceMinDepth, current.z);
    }

    const inFrustum = !(outXPos === 8 || outXNeg === 8 || outYPos === 8 || outYNeg === 8 || outZPos === 8 || outZNeg === 8);
    const minCoord = _minCoord.set(minCoordX, minCoordY).mulScalar(0.5).addScalar(0.5);
    const maxCoord = _maxCoord.set(maxCoordX, maxCoordY).mulScalar(0.5).addScalar(0.5);

    minCoord.x = pc.math.clamp(minCoord.x, 0.0, 1.0);
    minCoord.y = pc.math.clamp(minCoord.y, 0.0, 1.0);

    maxCoord.x = pc.math.clamp(maxCoord.x, 0.0, 1.0);
    maxCoord.y = pc.math.clamp(maxCoord.y, 0.0, 1.0);

    const hzbSize = _hzbSize.set(
        tester.hzb.width,
        tester.hzb.height
    );
    const extent = maxCoord.clone().sub(minCoord);
    const viewSize = extent.clone().mul(hzbSize);
    const size = Math.max(viewSize.x, viewSize.y);
    const lod = pc.math.clamp(Math.ceil(Math.log2(size)), 0, tester.hzb.mipLevels);

    return {
        inFrustum,
        lod,
        viewSize,
        boxCenterWorld: bbCenter,
        boundingBox: {
            center: bbCenter,
            halfExtends: bbHalfExtends,
        },
        rectangle: {
            x: (minCoord.x + extent.x / 2) * 2 - 1,
            y: (minCoord.y + extent.y / 2) * 2 - 1,
            width: extent.x * 2,
            height: extent.y * 2,
        }
    }
}

export function getDepthPSCode(mipLevels: number, single: boolean) {

    // Android render to mip maps slowed
    if (single) {

        return `

            #include "floatAsUintPS"

            float convertDepth(vec4 data) {

                #ifdef (DEPTH_IS_FLOAT || READ_DEPTH)
                    return data.r;
                #else
                    return uint2float(data);
                #endif
            }

            uniform highp sampler2D uHZB1;
            uniform highp sampler2D uHZB2;

            float getDepth(vec2 uv, float lod) {
                return convertDepth(max(
                    textureLod(uHZB1, uv, lod),
                    textureLod(uHZB2, uv, lod)
                ));
            }
        `;
    }

    let uniforms = '';
    for (let i = 0; i < mipLevels; i++) {
        uniforms += `uniform highp sampler2D uHZB${i};\r\n`;
    }

    let mixeds = '';
    for (let i = 0; i < mipLevels; i++) {
        mixeds += `tmp = mix(tmp, texture(uHZB${i}, uv), step(${i.toFixed(1)}, lod));`;
    }

    return `

        #include "floatAsUintPS"

        float convertDepth(vec4 data) {

            #ifdef (DEPTH_IS_FLOAT || READ_DEPTH)
                return data.r;
            #else
                return uint2float(data);
            #endif
        }

        ${uniforms}

        float getDepth(vec2 uv, float lod) {

            // default 1.1
            #ifdef (DEPTH_IS_FLOAT || READ_DEPTH)
                vec4 tmp = vec4(1.1, 0.0, 0.0, 0.0);
            #else
                vec4 tmp = vec4(0.8039, 0.8000, 0.5490, 0.2471);
            #endif

            ${mixeds}

            return convertDepth(tmp);
        }
    `;
}

export const getDepthFn =
`
    // template
    float getDepth(vec2 uv, float lod) {
        return ...
    }
`;

export const pixelFractionalCheckFn =
`
    int pixelFractionalCheck(vec2 minCoord, vec2 maxCoord, vec2 screenSize, vec2 hzbSize, float instanceDepth, out float hzbDepth) {

        float posStart;
        float posEnd;
        float step;

        vec2 extent = maxCoord - minCoord;
        vec2 viewSize = extent * hzbSize;

        float size = max(viewSize.x, viewSize.y);
        float lod  = clamp(ceil(log2(size)), MIN_LEVEL, MAX_LEVEL);

        float probe0 = getDepth(minCoord, lod);
        float probe1 = getDepth(maxCoord, lod);
        float probe2 = getDepth(vec2(minCoord.x, maxCoord.y), lod);
        float probe3 = getDepth(vec2(maxCoord.x, minCoord.y), lod);

        hzbDepth = max(max(probe0, probe1), max(probe2, probe3));

        return instanceDepth > hzbDepth ? 1 : 0;
    }
`;

export const cullBoundingBoxFn =
`
    int cullBoundingBox(vec3 boxCenterWorld, vec3 boxHalfExtends, mat4 viewProjection, vec2 screenSize, vec2 hzbSize, out float instanceDepth, out float hzbDepth) {

        instanceDepth = 1e6;
        hzbDepth = -1e6;

        highp vec4 boundingBox[8];

        boundingBox[0] = viewProjection * vec4(boxCenterWorld + vec3( boxHalfExtends.x, boxHalfExtends.y, boxHalfExtends.z), 1.0);
        boundingBox[1] = viewProjection * vec4(boxCenterWorld + vec3(-boxHalfExtends.x, boxHalfExtends.y, boxHalfExtends.z), 1.0);
        boundingBox[2] = viewProjection * vec4(boxCenterWorld + vec3( boxHalfExtends.x,-boxHalfExtends.y, boxHalfExtends.z), 1.0);
        boundingBox[3] = viewProjection * vec4(boxCenterWorld + vec3(-boxHalfExtends.x,-boxHalfExtends.y, boxHalfExtends.z), 1.0);
        boundingBox[4] = viewProjection * vec4(boxCenterWorld + vec3( boxHalfExtends.x, boxHalfExtends.y,-boxHalfExtends.z), 1.0);
        boundingBox[5] = viewProjection * vec4(boxCenterWorld + vec3(-boxHalfExtends.x, boxHalfExtends.y,-boxHalfExtends.z), 1.0);
        boundingBox[6] = viewProjection * vec4(boxCenterWorld + vec3( boxHalfExtends.x,-boxHalfExtends.y,-boxHalfExtends.z), 1.0);
        boundingBox[7] = viewProjection * vec4(boxCenterWorld + vec3(-boxHalfExtends.x,-boxHalfExtends.y,-boxHalfExtends.z), 1.0);

        #if DEBUG
        int outXPos = 0;
        int outXNeg = 0;
        int outYPos = 0;
        int outYNeg = 0;
        int outZPos = 0;
        int outZNeg = 0;
        #endif

        vec2 minCoord = vec2(1e6);
        vec2 maxCoord = vec2(-1e6);

        for (int i = 0; i < 8; i++) {

            vec4 current = boundingBox[i];

            #if DEBUG
            if (current.x >  current.w) outXPos++;
            if (current.x < -current.w) outXNeg++;
            if (current.y >  current.w) outYPos++;
            if (current.y < -current.w) outYNeg++;
            if (current.z >  current.w) outZPos++;
            if (current.z < -current.w) outZNeg++;
            #endif

            current.xyz /= current.w;

            minCoord = min(minCoord, current.xy);
            maxCoord = max(maxCoord, current.xy);
            instanceDepth = min(instanceDepth, current.z);
        }

        #if DEBUG
        if (outXPos == 8 || outXNeg == 8 || outYPos == 8 || outYNeg == 8 || outZPos == 8 || outZNeg == 8) {
            return 2;
        }
        #endif

        minCoord = clamp(minCoord * 0.5 + 0.5, 0.0, 1.0);
        maxCoord = clamp(maxCoord * 0.5 + 0.5, 0.0, 1.0);

        return pixelFractionalCheck(minCoord, maxCoord, screenSize, hzbSize, instanceDepth, hzbDepth);
    }
`;

export const getBoundingBoxPropsFn = 
`
    uniform sampler2D uDataTexture;

    void getBoundingBoxProps(const in uint index, out vec3 center, out vec3 halfExtents) {

        int size = textureSize(uDataTexture, 0).x;
        int j = int(index * 4u);
        int x = j % size;
        int y = j / size;

        center      = texelFetch(uDataTexture, ivec2(x    , y), 0).xyz;
        halfExtents = texelFetch(uDataTexture, ivec2(x + 1, y), 0).xyz;
    }
`;

export const vertexCodeVS =
`
    precision highp float;

    attribute uint aBoundingBoxIndex;

    flat out uint out_flags;

    uniform mat4 uMatrixViewProjection;
    uniform vec2 uScreenSize;
    uniform vec2 uHZBSize;

    #include "getDepthPS"

    ${pixelFractionalCheckFn}
    ${cullBoundingBoxFn}
    ${getBoundingBoxPropsFn}

    void main(void) {

        float instanceDepth;
        float hzbDepth;

        vec3 boundingBoxCenter;
        vec3 boundingBoxHalfExtents;

        getBoundingBoxProps(aBoundingBoxIndex, boundingBoxCenter, boundingBoxHalfExtents);

        int cullStatus = cullBoundingBox(boundingBoxCenter, boundingBoxHalfExtents, uMatrixViewProjection, uScreenSize, uHZBSize, instanceDepth, hzbDepth);

        out_flags = uint(cullStatus);
    }
`;