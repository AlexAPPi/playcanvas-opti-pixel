export default `

    #ifndef DEPTH_IS_FLOAT
        #include "floatAsUintPS"
    #endif

    fn getDepth(uv: vec2<f32>, lod: f32) -> f32 {

        // Webgpu fix uv
        let mUV: vec2<f32>  = vec2<f32>(uv.x, 1.0 - uv.y);
        let data: vec4<f32> = textureSampleLevel(hzb, hzbSampler, mUV, lod);

        #ifdef DEPTH_IS_FLOAT
            return data.r;
        #else
            return uint2float(data);
        #endif
    }
`;