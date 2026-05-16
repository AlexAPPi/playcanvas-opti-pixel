export default `

    uniform int uReadScreenDepth;
    uniform float uReadLevel;
    uniform vec2 uInvSize;
    uniform vec2 uInputViewportMaxBound;
    uniform vec4 uDispatchThreadIdToBufferUV;
    uniform sampler2D uDepthMip;

    varying vec2 uv0;

    #ifdef FLOAT_WORKAROUND
    #include "floatAsUintPS"
    #endif

    float convertDepth(vec4 value) {

        #ifdef FLOAT_WORKAROUND
            float workaroundValue = uint2float(value);
        #else
            float workaroundValue = value.r;
        #endif

        return mix(

            #ifdef (DEPTH_IS_FLOAT || DEPTH_IS_FLOAT16 || READ_DEPTH)
                value.r,
            #else
                workaroundValue,
            #endif

            #ifdef SCENE_DEPTHMAP_FLOAT
                value.r,
            #else
                workaroundValue,
            #endif

            uReadScreenDepth == 1
        );
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
        float depth = maxInVec(deviceZ);

        #ifdef WRITE_DEPTH
            gl_FragDepth = depth;
        #else

            #ifdef (DEPTH_IS_FLOAT || DEPTH_IS_FLOAT16)
                gl_FragColor = vec4(depth, 0.0, 0.0, 1.0);
            #else
                gl_FragColor = float2uint(depth);
            #endif

        #endif
    }
`;