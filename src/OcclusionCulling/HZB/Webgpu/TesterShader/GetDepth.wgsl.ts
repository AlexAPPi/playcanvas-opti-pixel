export default `

    #include "floatAsUintPS"

    fn getDepth(uv: vec2<f32>, lod: f32) -> f32 {

        // We sample the UV coordinates relative to the Level 0 HZB mipmap canvas,
        // since the rendering along the Y-axis was inverted.
        let factoredUv: vec2f = uniforms.hzbUvFactor.xy * uv;
        let adaptedUv: vec2f = vec2<f32>(factoredUv.x, uniforms.hzbUvFactor.y - factoredUv.y);
        let data: vec4f = textureSampleLevel(hzb, hzbSampler, adaptedUv, lod);

        #ifdef (DEPTH_IS_FLOAT || DEPTH_IS_FLOAT16)
            return data.r;
        #else
            return uint2float(data);
        #endif
    }
`;