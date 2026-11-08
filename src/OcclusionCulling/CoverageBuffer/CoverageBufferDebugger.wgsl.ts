export default `

    #include "floatAsUintPS"
    #include "gammaPS"
    varying uv0: vec2f;

    uniform uCoverageInvFar: f32;
    uniform uOpacity: f32;

    var uDepthMip: texture_2d<f32>;
    var uDepthMipSampler: sampler;

    @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
        // Packed / reprojected maps are GL order (row 0 = bottom).
        // WebGPU textures are top-left, so invert Y here.
        // RGBA8 is the little-endian bytes of the float. uint2float wants the high byte in R.
        let uv = input.uv0;
        let flipped = vec2f(uv.x, 1.0 - uv.y);
        let depth = textureSampleLevel(uDepthMip, uDepthMipSampler, flipped, 0.0);
        let z = uint2float(depth.abgr) * uniform.uCoverageInvFar;
        var output: FragmentOutput;
        output.color = vec4f(gammaCorrectOutput(vec3f(z)), uniform.uOpacity);
        return output;
    };
`;
