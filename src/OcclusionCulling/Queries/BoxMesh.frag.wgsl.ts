export default `
    @fragment fn fragmentMain(input : FragmentInput) -> FragmentOutput {
        var output: FragmentOutput;
        output.color = vec4f(1.0, 1.0, 1.0, 1.0);
        return output;
    }
`;