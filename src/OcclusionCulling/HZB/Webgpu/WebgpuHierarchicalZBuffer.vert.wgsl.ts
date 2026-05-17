export default `
    attribute aPosition: vec2f;
    @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;
        output.position = vec4f(input.aPosition, 0.0, 1.0);
        return output;
    }
`;