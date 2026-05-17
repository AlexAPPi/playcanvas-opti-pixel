export default `
    #include "floatAsUintPS"

    uniform uReadScreenDepth: i32;
    uniform uReadLevel: f32;
    uniform uInvSize: vec2<f32>;
    uniform uInputViewportMaxBound: vec2<f32>;
    uniform uDispatchThreadIdToBufferUV: vec4<f32>;

    var srcDepth: texture_2d<{SRC_DEPTH_FORMAT}>;
    var srcDepthSampler: sampler;

    fn minInVec(vec: vec4<f32>) -> f32 {
        return min(
            min(vec.x, vec.y),
            min(vec.z, vec.w)
        );
    }

    fn maxInVec(vec: vec4<f32>) -> f32 {
        return max(
            max(vec.x, vec.y),
            max(vec.z, vec.w)
        );
    }

    fn convertDepth(value: vec4f) -> f32 {

        // TODO: screen depth always f32 ?
        if (uniform.uReadScreenDepth == 1) {
            return value.r;
        }

        #ifdef (DEPTH_IS_FLOAT || DEPTH_IS_FLOAT16)
            return value.r;
        #else
            return uint2float(value);
        #endif
    }

    fn gather4(bufferUV: vec2f) -> vec4f {

        // TODO: screen depth always f32 ?
        // TODO: textureGather availability on the platform ?
        #ifdef (DEPTH_IS_FLOAT || DEPTH_IS_FLOAT16)

        let uv = min(bufferUV + vec2(-0.25, -0.25) * uniform.uInvSize, uniform.uInputViewportMaxBound - uniform.uInvSize);
        return textureGather(0, srcDepth, srcDepthSampler, uv);

        #else

        // min(..., uInputViewportMaxBound) because we don't want to sample outside of the viewport
        // when the view size has odd dimensions on X/Y axis.
        let uv0 = min(bufferUV + vec2f(-0.25, -0.25) * uniform.uInvSize, uniform.uInputViewportMaxBound);
        let uv1 = min(bufferUV + vec2f( 0.25, -0.25) * uniform.uInvSize, uniform.uInputViewportMaxBound);
        let uv2 = min(bufferUV + vec2f(-0.25,  0.25) * uniform.uInvSize, uniform.uInputViewportMaxBound);
        let uv3 = min(bufferUV + vec2f( 0.25,  0.25) * uniform.uInvSize, uniform.uInputViewportMaxBound);

        var out: vec4f;
        out.x = convertDepth(textureSampleLevel(srcDepth, srcDepthSampler, uv0, 0));
        out.y = convertDepth(textureSampleLevel(srcDepth, srcDepthSampler, uv1, 0));
        out.z = convertDepth(textureSampleLevel(srcDepth, srcDepthSampler, uv2, 0));
        out.w = convertDepth(textureSampleLevel(srcDepth, srcDepthSampler, uv3, 0));
        return out;

        #endif
    }

    @fragment fn fragmentMain(input : FragmentInput) -> FragmentOutput {
        var output: FragmentOutput;
        let bufferUV = input.position.xy * uniform.uDispatchThreadIdToBufferUV.xy + uniform.uDispatchThreadIdToBufferUV.zw;
        let deviceZ = gather4(bufferUV);
        let depth = maxInVec(deviceZ);

        #ifdef (DEPTH_IS_FLOAT || DEPTH_IS_FLOAT16)
            let outColor = vec4<f32>(vec3<f32>(depth), 1.0);
        #else
            let outColor = float2uint(depth);
        #endif

        output.color = outColor;
        return output;
    }
`;