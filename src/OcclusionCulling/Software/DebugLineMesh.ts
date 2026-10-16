import pc from "../../engine.js";

const EMPTY_F32 = new Float32Array(0);
const nextPow2 = pc.math.nextPowerOfTwo;
const FORWARD_PASS_MASK = 1 << pc.SHADER_FORWARD;

const LINE_SHADER = {
    uniqueName: "OPTIPIXEL_DEBUG_LINES_SHADER",
    attributes: {
        aPosition: pc.SEMANTIC_POSITION
    },
    vertexGLSL: `
        attribute vec3 aPosition;
        uniform mat4 matrix_model;
        uniform mat4 matrix_viewProjection;
        void main(void) {
            gl_Position = matrix_viewProjection * matrix_model * vec4(aPosition, 1.0);
        }
    `,
    fragmentGLSL: `
        uniform vec4 uColor;
        void main(void) {
            gl_FragColor = uColor;
        }
    `,
    vertexWGSL: `
        attribute aPosition: vec3f;
        uniform matrix_model: mat4x4f;
        uniform matrix_viewProjection: mat4x4f;
        @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
            var output: VertexOutput;
            output.position = uniform.matrix_viewProjection * uniform.matrix_model * vec4f(input.aPosition, 1.0);
            return output;
        }
    `,
    fragmentWGSL: `
        uniform uColor: vec4f;
        @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
            var output: FragmentOutput;
            output.color = uniform.uColor;
            return output;
        }
    `
} as const;

/**
 * World-space line mesh on the immediate layer.
 * {@link DebugLineMesh.draw} shows it for one frame. Call it from update, before that layer is rendered.
 * The GPU buffer is uploaded only when the line data changes.
 */
export class DebugLineMesh {

    private _app: pc.AppBase | null = null;
    private _onFrameEnd: pc.EventHandle | null = null;
    private _layer: pc.Layer | null = null;
    private _device: pc.GraphicsDevice | null = null;
    private _lines: Float32Array<ArrayBufferLike> = EMPTY_F32;
    private _lineCount = 0;
    private _mesh: pc.Mesh | null = null;
    private _meshInstance: pc.MeshInstance | null = null;
    private _maxVerts = 0;
    private _material: pc.ShaderMaterial | null = null;
    private _materialSynced = false;
    private _color = new pc.Color();
    private _colorData = new Float32Array(4);
    private _depthTest = true;

    public get lines() { return this._lines; }
    public get lineCount() { return this._lineCount; }
    public get mesh() { return this._mesh; }

    public setLines(lines: Float32Array | undefined, lineCount: number) {

        const next = lines && lineCount > 0 ? lines : EMPTY_F32;
        const count = next === EMPTY_F32 ? 0 : lineCount;

        if (this._lines === next &&
            this._lineCount === count) {
            return;
        }

        this._lines = next;
        this._lineCount = count;

        if (count <= 0) {
            this._destroyGpuMesh();
            return;
        }

        this._upload();
    }

    public draw(app: pc.AppBase, color: pc.Color, depthTest: boolean) {

        this._bind(app);

        if (this._lineCount <= 0) {
            this._hide();
            return;
        }

        if (!this._mesh) {
            this._upload();
        }

        if (!this._mesh) {
            return;
        }

        this._ensureMaterial(color, depthTest);
        const meshInstance = this._ensureInstance();
        if (meshInstance) {
            meshInstance.visible = true;
        }
    }

    public destroy() {
        this._detach();
        this._releaseGpu();
        this._lines = EMPTY_F32;
        this._lineCount = 0;
        this._device = null;
        this._app = null;
    }

    private _bind(app: pc.AppBase) {

        if (this._app === app) {
            return;
        }

        this._detach();
        this._releaseGpu();
        this._app = app;
        this._device = app.graphicsDevice;
        this._onFrameEnd = app.on("frameend", this._hide, this);
    }

    private _detach() {
        this._onFrameEnd?.off();
        this._onFrameEnd = null;
    }

    private _releaseGpu() {
        this._destroyGpuMesh();
        this._material?.destroy();
        this._material = null;
        this._materialSynced = false;
    }

    private _hide() {
        if (this._meshInstance) {
            this._meshInstance.visible = false;
        }
    }

    private _ensureInstance(): pc.MeshInstance | null {

        if (this._meshInstance) {
            return this._meshInstance;
        }

        const mesh = this._mesh;
        const material = this._material;
        const layer = this._app?.scene.defaultDrawLayer;
        if (!mesh || !material || !layer) {
            return null;
        }

        // Positions are world-space. The orphan node stays at identity: the renderer
        // reads worldTransform and does not sync a node outside the scene graph.
        const meshInstance = new pc.MeshInstance(mesh, material, new pc.GraphNode("DebugLineMesh"));
        meshInstance.cull = false;
        meshInstance.castShadow = false;
        meshInstance.pick = false;
        meshInstance.shaderPassMask = FORWARD_PASS_MASK;
        meshInstance.visible = false;
        layer.addMeshInstances([meshInstance], true);

        this._layer = layer;
        this._meshInstance = meshInstance;
        return meshInstance;
    }

    private _upload() {

        const device = this._device;
        const vertexCount = this._lineCount * 2;
        if (!device || vertexCount <= 0) {
            return;
        }

        this._mesh ??= new pc.Mesh(device);

        if (vertexCount > this._maxVerts) {
            this._maxVerts = nextPow2(vertexCount);
            this._mesh.clear(true, false, this._maxVerts);
        }

        const floats = vertexCount * 3;
        const positions = this._lines.length === floats
            ? this._lines
            : this._lines.subarray(0, floats);
        this._mesh.setPositions(positions, 3, vertexCount);
        this._mesh.update(pc.PRIMITIVE_LINES);
    }

    private _ensureMaterial(color: pc.Color, depthTest: boolean) {

        if (!this._material) {
            this._material = new pc.ShaderMaterial(LINE_SHADER);
            this._material.cull = pc.CULLFACE_NONE;
            this._material.depthWrite = false;
            this._materialSynced = false;
        }

        if (this._materialSynced &&
            this._color.equals(color) &&
            this._depthTest === depthTest) {
            return;
        }

        this._color.copy(color);
        this._depthTest = depthTest;
        this._colorData[0] = color.r;
        this._colorData[1] = color.g;
        this._colorData[2] = color.b;
        this._colorData[3] = color.a;
        this._material.setParameter("uColor", this._colorData);
        this._material.depthTest = depthTest;
        this._material.update();
        this._materialSynced = true;
    }

    private _destroyGpuMesh() {

        const meshInstance = this._meshInstance;
        if (meshInstance) {
            this._layer?.removeMeshInstances([meshInstance], true);
            releaseMeshInstance(meshInstance);
            this._meshInstance = null;
            this._mesh = null;
        } else {
            this._mesh?.destroy();
            this._mesh = null;
        }

        this._layer = null;
        this._maxVerts = 0;
    }
}

function releaseMeshInstance(meshInstance: pc.MeshInstance) {

    const node = meshInstance.node;
    // Releasing the instance destroys the mesh when its refcount hits zero.
    meshInstance.destroy();
    node.destroy();
}
