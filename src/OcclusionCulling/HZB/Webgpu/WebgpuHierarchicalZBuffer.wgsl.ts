export default 
`
    #include "floatAsUintPS"

    struct Uniforms {
        readScreenDepth: i32,
        invSize: vec2f,
        inputViewportMaxBound: vec2f,
        dispatchThreadIdToBufferUV: vec4f
    }

    @group(0) @binding(0) var<uniform> uniforms: Uniforms;
    @group(0) @binding(1) var srcDepth: texture_2d<{SRC_DEPTH_FORMAT}>;
    @group(0) @binding(2) var srcDepthSampler: sampler;
    @group(0) @binding(3) var dstDepth: texture_storage_2d<{DST_DEPTH_FORMAT}, write>;

    fn convertDepth(value: vec4f) -> f32 {

        // TODO: screen depth always f32 ?
        if (uniforms.readScreenDepth == 1) {
            return value.r;
        }

        #ifdef (DEPTH_IS_FLOAT || DEPTH_IS_FLOAT16)
            return value.r;
        #else
            return uint2float(value);
        #endif
    }

    fn gather4(bufferUV: vec2f) -> vec4f {

        // TODO: textureGather availability on the platform ?
        #ifdef (DEPTH_IS_FLOAT || DEPTH_IS_FLOAT16)

            let uv = min(bufferUV + vec2(-0.25, -0.25) * uniforms.invSize, uniforms.inputViewportMaxBound - uniforms.invSize);
            return textureGather(0, srcDepth, srcDepthSampler, uv);

        #else

            // min(..., uInputViewportMaxBound) because we don't want to sample outside of the viewport
            // when the view size has odd dimensions on X/Y axis.
            let uv0 = min(bufferUV + vec2f(-0.25, -0.25) * uniforms.invSize, uniforms.inputViewportMaxBound);
            let uv1 = min(bufferUV + vec2f( 0.25, -0.25) * uniforms.invSize, uniforms.inputViewportMaxBound);
            let uv2 = min(bufferUV + vec2f(-0.25,  0.25) * uniforms.invSize, uniforms.inputViewportMaxBound);
            let uv3 = min(bufferUV + vec2f( 0.25,  0.25) * uniforms.invSize, uniforms.inputViewportMaxBound);

            var out: vec4f;
            out.x = convertDepth(textureSamplerLevel(srcDepth, srcDepthSampler, uv0, 0));
            out.y = convertDepth(textureSamplerLevel(srcDepth, srcDepthSampler, uv1, 0));
            out.z = convertDepth(textureSamplerLevel(srcDepth, srcDepthSampler, uv2, 0));
            out.w = convertDepth(textureSamplerLevel(srcDepth, srcDepthSampler, uv3, 0));
            return out;

        #endif
    }

    fn calcDepth(coord: vec2u) -> f32 {

        let bufferUV = vec2f(vec2f(coord) + 0.5) * uniforms.dispatchThreadIdToBufferUV.xy + uniforms.dispatchThreadIdToBufferUV.zw;
        let deviceZ = gather4(bufferUV);

        // TODO: we can use min if the reverse z is implemented in engine
        return max(max(deviceZ.x, deviceZ.y), max(deviceZ.z, deviceZ.w));
    }

    @compute @workgroup_size({WORKGROUP_SIZE_X}, {WORKGROUP_SIZE_Y}, 1)
    fn main(@builtin(global_invocation_id) gid: vec3u) {

        let coords = gid.xy;
        let size = textureDimensions(dstDepth);

        if (all(coords < size)) {

            let depth: f32 = calcDepth(coords);

            #ifdef (DEPTH_IS_FLOAT || DEPTH_IS_FLOAT16)
                let result: vec4f = vec4f(depth, 0.0, 0.0, 1.0);
            #else
                let result: vec4f = float2uint(depth);
            #endif

            textureStore(dstDepth, coords, result);
        }
    }
`;