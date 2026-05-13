export default `

    #include "floatAsUintPS"

    fn getDepth(uv: vec2<f32>, lod: f32) -> f32 {

        // We sample the UV coordinates relative to the Level 0 HZB mipmap canvas,
        // since the rendering along the Y-axis was inverted.
        let adaptedUv: vec2<f32> = vec2<f32>(uv.x, uniforms.hzbUvFactor.y - uv.y);
        let data: vec4<f32> = textureSampleLevel(hzb, hzbSampler, adaptedUv, lod);

        #ifdef (DEPTH_IS_FLOAT || DEPTH_IS_FLOAT16)
            return data.r;
        #else
            return uint2float(data);
        #endif
    }
`;