export default `

    #include "floatAsUintPS"
    #include "gammaPS"
    varying uv0: vec2f;

    uniform uDepthMipLevel: f32;
    uniform camera_params: vec4f;

    var uDepthMip: texture_2d<f32>;
    var uDepthMipSampler: sampler;

    fn linearizeDepth(z: f32, cameraParams: vec4f) -> f32 {
        if (cameraParams.w == 0.0) {
            return (cameraParams.z * cameraParams.y) / (cameraParams.y + z * (cameraParams.z - cameraParams.y));
        }
        return cameraParams.z + z * (cameraParams.y - cameraParams.z);
    }

    fn extractDepthFromData(data: vec4f) -> f32 {
        #ifdef (DEPTH_IS_FLOAT || READ_DEPTH)
            return data.r;
        #else
            return uint2float(data);
        #endif
    }

    fn getLinearScreenDepth(uv: vec2<f32>, depthMipLevel: f32, cameraParams: vec4f) -> f32 {
        let depthData = textureSampleLevel(uDepthMip, uDepthMipSampler, uv, depthMipLevel);
        let depthSample = extractDepthFromData(depthData);
        return linearizeDepth(depthSample, cameraParams);
    }

    @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
        var output: FragmentOutput;
        let mirrorYUV = vec2<f32>(input.uv0.x, 1.0 - input.uv0.y);
        let depth: f32 = getLinearScreenDepth(getImageEffectUV(mirrorYUV), uniform.uDepthMipLevel, uniform.camera_params) * uniform.camera_params.x;
        output.color = vec4f(gammaCorrectOutput(vec3f(depth)), 1.0);
        return output;
    };
`;