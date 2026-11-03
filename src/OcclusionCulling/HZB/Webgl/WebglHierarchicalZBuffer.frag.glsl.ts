export default `

    uniform float uReadScreenDepth;
    uniform float uReadLevel;
    uniform vec2 uInvSize;
    uniform vec2 uInputViewportMaxBound;
    uniform vec4 uDispatchThreadIdToBufferUV;
    uniform highp sampler2D uDepthMip;

    #ifdef CAMERA_DEPTH_VIEW
    uniform vec4 uCameraParams;
    #endif

    #ifdef WORKAROUND_FLOAT
    #include "floatAsUintPS"
    #endif

    // CameraFrame stores view-space metres (or 1/viewZ). The pyramid stores device Z.
    #ifdef CAMERA_DEPTH_VIEW
    float delinearizeDepth(float linearDepth) {
        float nearClip = uCameraParams.z;
        float farClip = uCameraParams.y;
        float viewZ = clamp(linearDepth, nearClip, farClip);
        if (uCameraParams.w == 0.0) {
            return (farClip * (nearClip - viewZ)) / (viewZ * (nearClip - farClip));
        }
        return (viewZ - nearClip) / (farClip - nearClip);
    }

    float sceneDeviceZ(vec4 value) {
        #if defined(CAMERA_DEPTH_RECIPROCAL)
            float recip = value.r;
            float viewZ = recip > 0.0 ? 1.0 / recip : uCameraParams.y;
            return delinearizeDepth(viewZ);
        #elif defined(CAMERA_DEPTH_LINEAR_PACKED)
            return delinearizeDepth(uint2float(value));
        #else
            return delinearizeDepth(value.r);
        #endif
    }
    #endif

    float convertDepth(vec4 value) {

        #ifdef WORKAROUND_FLOAT
            float workaroundFloat = uint2float(value);
        #endif

        #ifdef (DEPTH_IS_FLOAT || DEPTH_IS_FLOAT16 || READ_DEPTH)
            float mipDepth = value.r;
        #else
            float mipDepth = workaroundFloat;
        #endif

        float screenDepth;
        #if defined(CAMERA_DEPTH_VIEW)
            screenDepth = sceneDeviceZ(value);
        #elif defined(SCENE_DEPTHMAP_FLOAT)
            screenDepth = value.r;
        #else
            screenDepth = workaroundFloat;
        #endif

        return uReadScreenDepth > 0.5 ? screenDepth : mipDepth;
    }

    vec4 gather4(vec2 bufferUV) {

        // min(..., uInputViewportMaxBound) because we don't want to sample outside of the viewport
        // when the view size has odd dimensions on X/Y axis.
        vec2 uv0 = min(bufferUV + vec2(-0.25, -0.25) * uInvSize, uInputViewportMaxBound);
        vec2 uv1 = min(bufferUV + vec2( 0.25, -0.25) * uInvSize, uInputViewportMaxBound);
        vec2 uv2 = min(bufferUV + vec2(-0.25,  0.25) * uInvSize, uInputViewportMaxBound);
        vec2 uv3 = min(bufferUV + vec2( 0.25,  0.25) * uInvSize, uInputViewportMaxBound);

        return vec4(
            convertDepth(textureLod(uDepthMip, uv0, uReadLevel)),
            convertDepth(textureLod(uDepthMip, uv1, uReadLevel)),
            convertDepth(textureLod(uDepthMip, uv2, uReadLevel)),
            convertDepth(textureLod(uDepthMip, uv3, uReadLevel))
        );
    }

    float maxInVec(vec4 v) {
        return max(
            max(v.x, v.y),
            max(v.z, v.w)
        );
    }

    void main() {

        vec2 bufferUV = gl_FragCoord.xy * uDispatchThreadIdToBufferUV.xy + uDispatchThreadIdToBufferUV.zw;
        vec4 deviceZ = gather4(bufferUV);
        float maxDepth = maxInVec(deviceZ);

        #ifdef WRITE_DEPTH
            gl_FragDepth = maxDepth;
        #else

            #ifdef (DEPTH_IS_FLOAT || DEPTH_IS_FLOAT16)
                gl_FragColor = vec4(maxDepth, 0.0, 0.0, 1.0);
            #else
                gl_FragColor = float2uint(maxDepth);
            #endif

        #endif
    }
`;
