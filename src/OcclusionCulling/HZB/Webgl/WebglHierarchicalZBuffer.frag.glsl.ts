export default `

    uniform int uReadScreenDepth;
    uniform float uReadLevel;
    uniform vec2 uInvSize;
    uniform vec2 uInputViewportMaxBound;
    uniform vec4 uDispatchThreadIdToBufferUV;
    uniform sampler2D uDepthMip;

    varying vec2 uv0;

    #include "floatAsUintPS"

    float convertDepth(vec4 value) {

        if (uReadScreenDepth == 1) {

            #ifdef SCENE_DEPTHMAP_FLOAT
                return value.r;
            #else
                return uint2float(value);
            #endif
        }

        #ifdef (DEPTH_IS_FLOAT || DEPTH_IS_FLOAT16 || READ_DEPTH)
            return value.r;
        #else
            return uint2float(value);
        #endif
    }

    float calcDepth() {

        vec2 bufferUV = gl_FragCoord.xy * uDispatchThreadIdToBufferUV.xy + uDispatchThreadIdToBufferUV.zw;

        // min(..., uInputViewportMaxBound) because we don't want to sample outside of the viewport
        // when the view size has odd dimensions on X/Y axis.
        vec2 uv0 = min(bufferUV + vec2(-0.25, -0.25) * uInvSize, uInputViewportMaxBound);
        vec2 uv1 = min(bufferUV + vec2( 0.25, -0.25) * uInvSize, uInputViewportMaxBound);
        vec2 uv2 = min(bufferUV + vec2(-0.25,  0.25) * uInvSize, uInputViewportMaxBound);
        vec2 uv3 = min(bufferUV + vec2( 0.25,  0.25) * uInvSize, uInputViewportMaxBound);

        return max(
            max(
                convertDepth(textureLod(uDepthMip, uv0, uReadLevel)),
                convertDepth(textureLod(uDepthMip, uv1, uReadLevel))
            ),
            max(
                convertDepth(textureLod(uDepthMip, uv2, uReadLevel)),
                convertDepth(textureLod(uDepthMip, uv3, uReadLevel))
            )
        );
    }

    void main() {

        float depth = calcDepth();

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