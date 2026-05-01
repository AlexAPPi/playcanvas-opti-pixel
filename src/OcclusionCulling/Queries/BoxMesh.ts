import pc from "../../engine";

const indices = new Uint16Array([
    0, 2, 1,
    0, 3, 2,
    4, 5, 6,
    4, 6, 7,
    0, 1, 5,
    0, 5, 4,
    3, 7, 6,
    3, 6, 2,
    0, 4, 7,
    0, 7, 3,
    1, 2, 6,
    1, 6, 5
]);

const min = new pc.Vec3(-0.5, -0.5, -0.5);
const max = new pc.Vec3(0.5, 0.5, 0.5);
const vertices = new Float32Array([
    min.x, min.y, min.z,
    max.x, min.y, min.z,
    max.x, max.y, min.z,
    min.x, max.y, min.z,
    min.x, min.y, max.z,
    max.x, min.y, max.z,
    max.x, max.y, max.z,
    min.x, max.y, max.z,
]);

export class BoxMesh<TGraphicsDevice extends pc.GraphicsDevice> {

    private _mesh: pc.Mesh;
    private _shader: pc.Shader;
    private _device: TGraphicsDevice;
    private _pvmMatrixScopeId: pc.ScopeId;
    private _modelMatrix = new pc.Mat4();
    private _viewProjection = new pc.Mat4();
    private _modelViewProjection = new pc.Mat4();

    public get mesh() { return this._mesh; }
    public get shader() { return this._shader; }
    public get device() { return this._device; }

    constructor(device: TGraphicsDevice) {
        this._device = device;
        this._pvmMatrixScopeId = this._device.scope.resolve('matrix_modelViewProjectionOccCull');
        this._initBox();
        this._initShader();
    }

    public destroy() {
        this._shader?.destroy();
        this._mesh?.destroy();
    }

    private _initBox() {

        this._mesh?.destroy();

        const vertexFormat = new pc.VertexFormat(this._device, [
            { semantic: pc.SEMANTIC_POSITION, components: 3, type: pc.TYPE_FLOAT32 }
        ]);

        const vertexBuffer = new pc.VertexBuffer(this._device, vertexFormat, vertices.length / 3, { data: vertices.buffer });
        const indexBuffer = new pc.IndexBuffer(this._device, pc.INDEXFORMAT_UINT16, indices.length, pc.BUFFER_STATIC, indices.buffer);

        const mesh = new pc.Mesh(this._device);
        mesh.vertexBuffer = vertexBuffer;
        mesh.indexBuffer[0] = indexBuffer;
        mesh.primitive[0].type = pc.PRIMITIVE_TRIANGLES;
        mesh.primitive[0].base = 0;
        mesh.primitive[0].count = indices.length;
        mesh.primitive[0].indexed = true;

        this._mesh = mesh;
    }

    private _initShader() {

        this._shader?.destroy();
        this._shader = pc.ShaderUtils.createShader(this._device, {
            uniqueName: "OcclusionCullingBoxShader",
            attributes: {
                aPosition: pc.SEMANTIC_POSITION
            },

            // GLSL
            vertexGLSL: `
                attribute vec3 aPosition;
                uniform mat4 matrix_modelViewProjectionOccCull;
                void main(void) {
                    gl_Position = matrix_modelViewProjectionOccCull * vec4(aPosition, 1.0);
                }
            `,
            fragmentGLSL: `
                void main(void) {
                    gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
                }
            `,

            // WGSL
            vertexWGSL: `
                attribute aPosition: vec3f;
                uniform matrix_modelViewProjectionOccCull: mat4x4f;
                @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
                    var output: VertexOutput;
                    output.position = uniform.matrix_modelViewProjectionOccCull * vec4f(input.aPosition, 1.0);
                    return output;
                }
            `,
            fragmentWGSL: `
                @fragment fn fragmentMain(input : FragmentInput) -> FragmentOutput {
                    var output: FragmentOutput;
                    output.color = vec4f(1.0, 1.0, 1.0, 1.0);
                    return output;
                }
            `
        });
    }

    public getMatrixFromBoundingBox(box: pc.BoundingBox) {

        const m = this._modelMatrix.data;

        m[0]  = box.halfExtents.x * 2;
        m[5]  = box.halfExtents.y * 2;
        m[10] = box.halfExtents.z * 2;
        m[12] = box.center.x;
        m[13] = box.center.y;
        m[14] = box.center.z;

        return this._modelMatrix;
    }

    public setPVMatrix(camera: pc.Camera) {

        const viewMatrix = camera.viewMatrix;
        const projectionMatrix = camera.projectionMatrix;

        this._viewProjection.mul2(projectionMatrix, viewMatrix);
    }

    public setMMatrix(box: pc.BoundingBox) {

        const modelMatrix = this.getMatrixFromBoundingBox(box);

        this._modelViewProjection.mul2(this._viewProjection, modelMatrix);
        this._pvmMatrixScopeId.setValue(this._modelViewProjection.data);
    }
}