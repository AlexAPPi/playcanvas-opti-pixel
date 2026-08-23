import pc from "../../engine.js";

const EMPTY_F32 = new Float32Array(0);
const _identity = new pc.Mat4();
const nextPow2 = pc.math.nextPowerOfTwo;

const LINE_SHADER = {
    uniqueName: "optiPixel.softwareOcclusion.debugLines",
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
 * Immediate `PRIMITIVE_LINES` mesh.
 * GPU upload runs only when the line buffer changes.
 */
export class DebugLineMesh {

    private _device: pc.GraphicsDevice | null = null;
    private _lines: Float32Array<ArrayBufferLike> = EMPTY_F32;
    private _lineCount = 0;
    private _mesh: pc.Mesh | null = null;
    private _maxVerts = 0;
    private _material: pc.ShaderMaterial | null = null;
    private _color = new pc.Color(-1, -1, -1);
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
        this._device = app.graphicsDevice;
        if (this._lineCount <= 0) {
            return;
        }
        if (!this._mesh) {
            this._upload();
        }
        if (!this._mesh) {
            return;
        }
        this._ensureMaterial(color, depthTest);
        app.drawMesh(this._mesh, this._material!, _identity);
    }

    public destroy() {
        this._material?.destroy();
        this._material = null;
        this._destroyGpuMesh();
        this._lines = EMPTY_F32;
        this._lineCount = 0;
        this._device = null;
        this._color.set(-1, -1, -1);
    }

    private _upload() {
        if (!this._device) {
            return;
        }
        const vertexCount = this._lineCount * 2;
        if (vertexCount <= 0) {
            this._destroyGpuMesh();
            return;
        }
        if (!this._mesh) {
            this._mesh = new pc.Mesh(this._device);
        }
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
        }
        if (this._color.equals(color) && this._depthTest === depthTest) {
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
    }

    private _destroyGpuMesh() {
        this._mesh?.destroy();
        this._mesh = null;
        this._maxVerts = 0;
    }
}
