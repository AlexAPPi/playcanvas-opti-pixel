import pc from "../engine.js";

/**
 * Clip-space quad for occlusion debug views.
 * `(x, y)` is the center in [-1, 1]. A width and height of 2 fill the screen.
 * `matrix_model` is the clip transform, so the camera projection is not applied.
 */
const vertexGLSL = /* glsl */ `
    attribute vec2 vertex_position;
    uniform mat4 matrix_model;
    varying vec2 uv0;
    void main(void) {
        gl_Position = matrix_model * vec4(vertex_position, 0.0, 1.0);
        uv0 = vertex_position.xy + 0.5;
    }
`;

const vertexWGSL = /* wgsl */ `
    attribute vertex_position: vec2f;
    uniform matrix_model: mat4x4f;
    varying uv0: vec2f;
    @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;
        output.position = uniform.matrix_model * vec4f(input.vertex_position, 0.0, 1.0);
        output.uv0 = input.vertex_position.xy + vec2f(0.5);
        return output;
    }
`;

const colorGLSL = /* glsl */ `
    #include "gammaPS"
    varying vec2 uv0;
    uniform sampler2D colorMap;
    void main(void) {
        gl_FragColor = vec4(gammaCorrectOutput(texture2D(colorMap, uv0).rgb), 1.0);
    }
`;

const colorWGSL = /* wgsl */ `
    #include "gammaPS"
    varying uv0: vec2f;
    var colorMap: texture_2d<f32>;
    var colorMapSampler: sampler;
    @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
        var output: FragmentOutput;
        let sampled = textureSample(colorMap, colorMapSampler, input.uv0);
        output.color = vec4f(gammaCorrectOutput(sampled.rgb), 1.0);
        return output;
    }
`;

const QUAD_POSITIONS = [
    -0.5, -0.5, 0,
    0.5, -0.5, 0,
    -0.5, 0.5, 0,
    0.5, 0.5, 0
];

const QUAD_ATTRIBUTES = {
    vertex_position: pc.SEMANTIC_POSITION
};

const FORWARD_PASS_MASK = 1 << pc.SHADER_FORWARD;

export interface DebugScreenShader {
    /** Unique shader name. The first source compiled for this name is reused. */
    name: string;
    glsl: string;
    wgsl: string;
}

export type DebugScreenParam = number | pc.Texture | ArrayLike<number>;

export interface DebugScreenParams {
    [name: string]: DebugScreenParam;
}

const COLOR_SHADER: DebugScreenShader = {
    name: "OPTIPIXEL_DEBUG_SCREEN_COLOR_SHADER",
    glsl: colorGLSL,
    wgsl: colorWGSL
};

interface IScreenQuad {
    meshInstance: pc.MeshInstance;
    vectors: Map<string, Float32Array>;
    names: string[];
}

/**
 * One-frame debug quads on the default draw layer.
 * Submit during update, before that layer is rendered. Quads are hidden at `frameend`.
 */
export class DebugScreenDrawer {

    private _app: pc.AppBase | null;
    private _onFrameEnd: pc.EventHandle | null = null;
    private _layer: pc.Layer | null = null;
    private _mesh: pc.Mesh | null = null;
    private _materials = new Map<string, pc.ShaderMaterial>();
    private _quads: IScreenQuad[] = [];
    private _used = 0;

    public constructor(app: pc.AppBase) {
        this._app = app;
        this._onFrameEnd = app.on("frameend", this._hideAll, this);
    }

    public destroy() {

        if (!this._app) {
            return;
        }

        this._onFrameEnd?.off();
        this._onFrameEnd = null;
        this._hideAll();

        if (this._layer && this._quads.length > 0) {
            this._layer.removeMeshInstances(this._quads.map((quad) => quad.meshInstance), true);
        }
        for (let i = 0; i < this._quads.length; i++) {
            // The last instance releases the shared mesh.
            releaseMeshInstance(this._quads[i].meshInstance);
        }
        this._quads.length = 0;
        this._mesh = null;

        for (const material of this._materials.values()) {
            material.destroy();
        }
        this._materials.clear();
        this._layer = null;
        this._app = null;
    }

    /** Solid RGBA preview. Linear texels are gamma-corrected. */
    public drawTexture(x: number, y: number, width: number, height: number, texture: pc.Texture) {
        this.draw(x, y, width, height, COLOR_SHADER, { colorMap: texture });
    }

    public draw(
        x: number,
        y: number,
        width: number,
        height: number,
        shader: DebugScreenShader,
        parameters?: DebugScreenParams
    ) {

        const app = this._app;
        if (!app || !isFiniteRect(x, y, width, height)) {
            return;
        }

        const layer = this._layer ?? app.scene.defaultDrawLayer;
        if (!layer) {
            return;
        }
        this._layer = layer;

        const material = this._material(shader);
        const quad = this._quad(app, layer, material);
        const meshInstance = quad.meshInstance;
        const node = meshInstance.node;

        meshInstance.material = material;
        node.setPosition(x, y, 0);
        node.setLocalScale(width, -height, 1);

        // Orphan node: the renderer reads worldTransform and does not sync it.
        node.getWorldTransform();
        meshInstance.visible = true;
        this._applyParameters(quad, parameters);
    }

    private _quad(app: pc.AppBase, layer: pc.Layer, material: pc.ShaderMaterial): IScreenQuad {

        const current = this._quads[this._used++];
        if (current) {
            return current;
        }

        this._mesh ??= this._createMesh(app.graphicsDevice);

        const meshInstance = new pc.MeshInstance(this._mesh, material, new pc.GraphNode("DebugScreenQuad"));
        meshInstance.cull = false;
        meshInstance.castShadow = false;
        meshInstance.pick = false;
        meshInstance.shaderPassMask = FORWARD_PASS_MASK;
        meshInstance.visible = false;
        layer.addMeshInstances([meshInstance], true);

        const quad = { meshInstance, vectors: new Map<string, Float32Array>(), names: [] };
        this._quads.push(quad);
        return quad;
    }

    private _createMesh(device: pc.GraphicsDevice): pc.Mesh {

        const mesh = new pc.Mesh(device);
        mesh.setPositions(QUAD_POSITIONS);
        mesh.update(pc.PRIMITIVE_TRISTRIP);
        return mesh;
    }

    private _material(shader: DebugScreenShader): pc.ShaderMaterial {

        let material = this._materials.get(shader.name);
        if (material) {
            return material;
        }

        material = new pc.ShaderMaterial({
            uniqueName: shader.name,
            attributes: QUAD_ATTRIBUTES,
            vertexGLSL,
            vertexWGSL,
            fragmentGLSL: shader.glsl,
            fragmentWGSL: shader.wgsl
        });
        material.cull = pc.CULLFACE_NONE;
        material.depthTest = false;
        material.depthWrite = false;
        material.update();
        this._materials.set(shader.name, material);
        return material;
    }

    private _applyParameters(quad: IScreenQuad, parameters: DebugScreenParams | undefined) {

        const meshInstance = quad.meshInstance;
        if (!parameters) {
            for (let i = 0; i < quad.names.length; i++) {
                meshInstance.deleteParameter(quad.names[i]);
            }
            quad.names = [];
            return;
        }

        const next = Object.keys(parameters);
        for (let i = 0; i < quad.names.length; i++) {
            const name = quad.names[i];
            if (next.indexOf(name) === -1) {
                meshInstance.deleteParameter(name);
            }
        }
        for (let i = 0; i < next.length; i++) {
            const name = next[i];
            this._setParameter(quad, name, parameters[name]);
        }
        quad.names = next;
    }

    private _setParameter(quad: IScreenQuad, name: string, value: DebugScreenParam) {

        const meshInstance = quad.meshInstance;
        if (typeof value === "number") {
            meshInstance.setParameter(name, value);
            return;
        }
        if (value instanceof pc.Texture) {
            meshInstance.setParameter(name, value);
            return;
        }
        meshInstance.setParameter(name, copyUniform(quad, name, value));
    }

    private _hideAll() {

        for (let i = 0; i < this._used; i++) {
            const quad = this._quads[i];
            quad.meshInstance.visible = false;
            this._applyParameters(quad, undefined);
        }
        this._used = 0;
    }
}

export function createDebugMarkerTexture(device: pc.GraphicsDevice): pc.Texture {

    return new pc.Texture(device, {
        name: "DebugMarker",
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
}

function releaseMeshInstance(meshInstance: pc.MeshInstance) {
    const node = meshInstance.node;
    meshInstance.destroy();
    node.destroy();
}

function isFiniteRect(x: number, y: number, width: number, height: number): boolean {
    return Number.isFinite(x) && Number.isFinite(y) &&
        Number.isFinite(width) && Number.isFinite(height) &&
        width !== 0 && height !== 0;
}

function copyUniform(quad: IScreenQuad, name: string, src: ArrayLike<number>): Float32Array {

    let buf = quad.vectors.get(name);
    if (!buf || buf.length !== src.length) {
        buf = new Float32Array(src.length);
        quad.vectors.set(name, buf);
    }
    buf.set(src);
    return buf;
}
