export default `

    uniform vec2 uInvSize;
    uniform vec2 uInputViewportMaxBound;
    uniform vec4 uDispatchThreadIdToBufferUV;
    uniform highp sampler2D uDepthMip;
    uniform float uReadLevel;

    #ifdef SCENE_DEPTHMAP_LINEAR
    uniform vec4 uCameraParams;
    #endif

    #include "floatAsUintPS"

    // Same reconstruction as PlayCanvas screenDepthPS / Camera.fillShaderParams.
    // camera params: (1/far, far, near, isOrtho). Device Z is 0 at the near plane and 1 at the far plane.
    #ifdef SCENE_DEPTHMAP_LINEAR
    float delinearizeDepth(float linearDepth) {
        float nearClip = uCameraParams.z;
        float farClip = uCameraParams.y;
        if (uCameraParams.w == 0.0) {
            return (farClip * (nearClip - linearDepth)) / (linearDepth * (nearClip - farClip));
        }
        return (linearDepth - nearClip) / (farClip - nearClip);
    }

    float decodeLinearDepthToDeviceZ(vec4 value) {
        #if defined(SCENE_DEPTHMAP_PACKED)
            return delinearizeDepth(uint2float(value));
        #elif defined(SCENE_DEPTHMAP_RECIPROCAL)
            float recip = value.r;
            float viewZ = recip > 0.0 ? 1.0 / recip : uCameraParams.y;
            return delinearizeDepth(viewZ);
        #else
            return delinearizeDepth(value.r);
        #endif
    }
    #endif

    float decodeDeviceZ(vec4 value) {

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

    vec4 gather4(vec2 bufferUV) {

        // min(..., uInputViewportMaxBound) because we don't want to sample outside of the viewport
        // when the view size has odd dimensions on X/Y axis.
        vec2 uv0 = min(bufferUV + vec2(-0.25, -0.25) * uInvSize, uInputViewportMaxBound);
        vec2 uv1 = min(bufferUV + vec2( 0.25, -0.25) * uInvSize, uInputViewportMaxBound);
        vec2 uv2 = min(bufferUV + vec2(-0.25,  0.25) * uInvSize, uInputViewportMaxBound);
        vec2 uv3 = min(bufferUV + vec2( 0.25,  0.25) * uInvSize, uInputViewportMaxBound);

        return vec4(
            decodeDeviceZ(textureLod(uDepthMip, uv0, uReadLevel)),
            decodeDeviceZ(textureLod(uDepthMip, uv1, uReadLevel)),
            decodeDeviceZ(textureLod(uDepthMip, uv2, uReadLevel)),
            decodeDeviceZ(textureLod(uDepthMip, uv3, uReadLevel))
        );
    }

    float maxInVec(vec4 v) {
        return max(max(v.x, v.y), max(v.z, v.w));
    }

    void main() {

        vec2 bufferUV = gl_FragCoord.xy * uDispatchThreadIdToBufferUV.xy + uDispatchThreadIdToBufferUV.zw;
        vec4 deviceDepths = gather4(bufferUV);
        float maxDeviceZ = maxInVec(deviceDepths);

        #ifdef WRITE_DEPTH
            gl_FragDepth = maxDeviceZ;
        #elif defined(DEPTH_IS_FLOAT) || defined(DEPTH_IS_FLOAT16)
            gl_FragColor = vec4(maxDeviceZ, 0.0, 0.0, 1.0);
        #else
            gl_FragColor = float2uint(maxDeviceZ);
        #endif
    }
`;
