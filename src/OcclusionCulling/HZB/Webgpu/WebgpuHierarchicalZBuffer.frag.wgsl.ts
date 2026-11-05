export default `
    #include "floatAsUintPS"

    uniform uInvSize: vec2<f32>;
    uniform uInputViewportMaxBound: vec2<f32>;
    uniform uDispatchThreadIdToBufferUV: vec4<f32>;
    #ifdef SCENE_DEPTHMAP_LINEAR
    uniform uCameraParams: vec4f;
    #endif

    var srcDepth: texture_2d<uff>;
    var srcDepthSampler: sampler;

    fn maxInVec(vec: vec4<f32>) -> f32 {
        return max(max(vec.x, vec.y), max(vec.z, vec.w));
    }

    // Same reconstruction as PlayCanvas screenDepthPS. Device Z is 0 at near and 1 at far.
    #ifdef SCENE_DEPTHMAP_LINEAR
    fn delinearizeDepth(linearDepth: f32) -> f32 {
        let nearClip = uniform.uCameraParams.z;
        let farClip = uniform.uCameraParams.y;
        if (uniform.uCameraParams.w == 0.0) {
            return (farClip * (nearClip - linearDepth)) / (linearDepth * (nearClip - farClip));
        }
        return (linearDepth - nearClip) / (farClip - nearClip);
    }

    fn decodeLinearDepthToDeviceZ(value: vec4f) -> f32 {
        #if defined(SCENE_DEPTHMAP_PACKED)
            return delinearizeDepth(uint2float(value));
        #elif defined(SCENE_DEPTHMAP_RECIPROCAL)
            let recip = value.r;
            let viewZ = select(uniform.uCameraParams.y, 1.0 / recip, recip > 0.0);
            return delinearizeDepth(viewZ);
        #else
            return delinearizeDepth(value.r);
        #endif
    }
    #endif

    fn decodeDeviceZ(value: vec4f) -> f32 {

        #if defined(READ_SCREEN_DEPTH)

            #if defined(SCENE_DEPTHMAP_LINEAR)
                return decodeLinearDepthToDeviceZ(value);
            #else
                return value.r;
            #endif

        #elif defined(DEPTH_IS_FLOAT) || defined(DEPTH_IS_FLOAT16) || defined(READ_DEPTH)
            return value.r;
        #else
            return uint2float(value);
        #endif
    }

    fn gather4(bufferUV: vec2f) -> vec4f {

        // Float reduce already stores device Z in component 0. Every other source goes through decodeDeviceZ.
        #if !defined(READ_SCREEN_DEPTH) && (defined(DEPTH_IS_FLOAT) || defined(DEPTH_IS_FLOAT16))

        let uv = min(bufferUV + vec2(-0.25, -0.25) * uniform.uInvSize, uniform.uInputViewportMaxBound - uniform.uInvSize);
        return textureGather(0, srcDepth, srcDepthSampler, uv);

        #else

        // min(..., uInputViewportMaxBound) because we don't want to sample outside of the viewport
        // when the view size has odd dimensions on X/Y axis.
        let uv0 = min(bufferUV + vec2f(-0.25, -0.25) * uniform.uInvSize, uniform.uInputViewportMaxBound);
        let uv1 = min(bufferUV + vec2f( 0.25, -0.25) * uniform.uInvSize, uniform.uInputViewportMaxBound);
        let uv2 = min(bufferUV + vec2f(-0.25,  0.25) * uniform.uInvSize, uniform.uInputViewportMaxBound);
        let uv3 = min(bufferUV + vec2f( 0.25,  0.25) * uniform.uInvSize, uniform.uInputViewportMaxBound);

        return vec4f(
            decodeDeviceZ(textureSampleLevel(srcDepth, srcDepthSampler, uv0, 0.0)),
            decodeDeviceZ(textureSampleLevel(srcDepth, srcDepthSampler, uv1, 0.0)),
            decodeDeviceZ(textureSampleLevel(srcDepth, srcDepthSampler, uv2, 0.0)),
            decodeDeviceZ(textureSampleLevel(srcDepth, srcDepthSampler, uv3, 0.0))
        );

        #endif
    }

    @fragment fn fragmentMain(input : FragmentInput) -> FragmentOutput {
        var output: FragmentOutput;
        let bufferUV = input.position.xy * uniform.uDispatchThreadIdToBufferUV.xy + uniform.uDispatchThreadIdToBufferUV.zw;
        let depth = maxInVec(gather4(bufferUV));

        #if defined(DEPTH_IS_FLOAT) || defined(DEPTH_IS_FLOAT16)
            output.color = vec4<f32>(vec3<f32>(depth), 1.0);
        #else
            output.color = float2uint(depth);
        #endif
        return output;
    }
`;
