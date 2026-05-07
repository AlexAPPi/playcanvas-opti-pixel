export default `

    precision highp float;

    uniform int uReadScreenDepth;
    uniform int uIncludeSrcExtraColumn;
    uniform int uIncludeSrcExtraRow;
    uniform int uReadLevel;
    uniform highp sampler2D uDepthMip;

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

        #ifdef DEPTH_IS_FLOAT || READ_DEPTH
            return value.r;
        #else
            return uint2float(value);
        #endif
    }

    #define getDepth(xy, offset, bound) (convertDepth(texelFetch(uDepthMip, min(xy + offset, bound), uReadLevel)));

    float getMinDepth() {

        ivec2 thisLevelTexelCoord = ivec2(gl_FragCoord.xy);
        ivec2 previousLevelBaseTexelCoord = 2 * thisLevelTexelCoord;
        ivec2 bound = textureSize(uDepthMip, uReadLevel) - 1;

        const ivec2 p00 = ivec2(0, 0);
        const ivec2 p10 = ivec2(1, 0);
        const ivec2 p11 = ivec2(1, 1);
        const ivec2 p01 = ivec2(0, 1);

        float d00 = getDepth(previousLevelBaseTexelCoord, p00, bound);
        float d10 = getDepth(previousLevelBaseTexelCoord, p10, bound);
        float d11 = getDepth(previousLevelBaseTexelCoord, p11, bound);
        float d01 = getDepth(previousLevelBaseTexelCoord, p01, bound);

        return min(min(d00, d10), min(d11, d01));
    }

    void main() {

        float depth = getMinDepth();

        #ifdef WRITE_DEPTH
            gl_FragDepth = depth;
        #else

            #ifdef DEPTH_IS_FLOAT
                gl_FragColor = vec4(depth, 0.0, 0.0, 1.0);
            #else
                gl_FragColor = float2uint(depth);
            #endif

        #endif
    }
`;