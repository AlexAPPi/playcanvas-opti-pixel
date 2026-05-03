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

    #define getDepth(xy, offset) (convertDepth(texelFetchOffset(uDepthMip, xy, uReadLevel, offset)));

    float getMaxDepth() {

        const ivec2 p00 = ivec2(0, 0);
        const ivec2 p10 = ivec2(1, 0);
        const ivec2 p11 = ivec2(1, 1);
        const ivec2 p01 = ivec2(0, 1);
        const ivec2 p20 = ivec2(2, 0);
        const ivec2 p21 = ivec2(2, 1);
        const ivec2 p22 = ivec2(2, 2);
        const ivec2 p02 = ivec2(0, 2);
        const ivec2 p12 = ivec2(1, 2);

        ivec2 thisLevelTexelCoord = ivec2(gl_FragCoord.xy);
        ivec2 previousLevelBaseTexelCoord = 2 * thisLevelTexelCoord;

        float d00 = getDepth(previousLevelBaseTexelCoord, p00);
        float d10 = getDepth(previousLevelBaseTexelCoord, p10);
        float d11 = getDepth(previousLevelBaseTexelCoord, p11);
        float d01 = getDepth(previousLevelBaseTexelCoord, p01);

        float maxDepth = max(max(d00, d10), max(d11, d01));

        if (uIncludeSrcExtraColumn == 1) {
            float ec0 = getDepth(previousLevelBaseTexelCoord, p20);
            float ec1 = getDepth(previousLevelBaseTexelCoord, p21);
            maxDepth = max(maxDepth, max(ec0, ec1));

            // In the case where the width and height are both odd, need to include the
            // 'corner' value as well.
            if (uIncludeSrcExtraRow == 1) {
                float er0 = getDepth(previousLevelBaseTexelCoord, p22);
                maxDepth = max(maxDepth, er0);
            }
        }

        if (uIncludeSrcExtraRow == 1) {
            float er0 = getDepth(previousLevelBaseTexelCoord, p02);
            float er1 = getDepth(previousLevelBaseTexelCoord, p12);
            maxDepth = max(maxDepth, max(er0, er1));
        }

        return maxDepth;
    }

    void main() {

        float maxDepth = getMaxDepth();

        #ifdef WRITE_DEPTH
            gl_FragDepth = maxDepth;
        #else

            #ifdef DEPTH_IS_FLOAT
                gl_FragColor = vec4(maxDepth, 0.0, 0.0, 1.0);
            #else
                gl_FragColor = float2uint(maxDepth);
            #endif

        #endif
    }
`;