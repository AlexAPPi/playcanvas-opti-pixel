export default `
    attribute aPosition: vec3f;
    uniform matrix_modelViewProjectionOccCull: mat4x4f;
    @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;
        output.position = uniform.matrix_modelViewProjectionOccCull * vec4f(input.aPosition, 1.0);
        return output;
    }
`;