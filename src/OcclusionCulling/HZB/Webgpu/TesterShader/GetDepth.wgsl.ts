export default `

    #include "floatAsUintPS"

    fn getDepth(uv: vec2<f32>, lod: f32) -> f32 {

        let uvMirrorY: vec2<f32> = vec2<f32>(uv.x, 1.0 - uv.y);
        let data: vec4<f32> = textureSampleLevel(hzb, hzbSampler, uvMirrorY, lod);

        #ifdef (DEPTH_IS_FLOAT || DEPTH_IS_FLOAT16)
            return data.r;
        #else
            return uint2float(data);
        #endif
    }
`;