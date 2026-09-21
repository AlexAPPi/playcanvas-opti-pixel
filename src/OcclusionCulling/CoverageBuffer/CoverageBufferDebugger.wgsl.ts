export default `

    #include "gammaPS"
    varying uv0: vec2f;

    uniform camera_params: vec4f;

    var uDepthMip: texture_2d<f32>;
    var uDepthMipSampler: sampler;

    @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
        var output: FragmentOutput;
        // Packed / reprojected maps are GL order (row 0 = bottom).
        // WebGPU textures are top-left, so invert Y here — not on CPU.
        let uv = input.uv0;
        let flipped = vec2f(uv.x, 1.0 - uv.y);
        let z = textureSampleLevel(uDepthMip, uDepthMipSampler, flipped, 0.0).r * uniform.camera_params.x;
        output.color = vec4f(gammaCorrectOutput(vec3f(z)), 1.0);
        return output;
    };
`;
