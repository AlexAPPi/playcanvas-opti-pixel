export default `

    // Depth downsample:
    // 4 taps at +-0.5 source texels, then max (device Z).
    // Conservative: a coarse texel is only closer if every tap was closer.

    uniform float uCoverageReadScreenDepth;
    uniform vec2 uCoverageInvSrcSize;
    uniform vec2 uCoverageDestPixelToUv;
    uniform vec2 uCoverageSrcUvMax;
    uniform highp sampler2D uCoverageDepth;

    #ifdef COVERAGE_DEPTH_RECIPROCAL
    uniform vec4 uCoverageCameraParams;
    #endif

    #include "floatAsUintPS"

    float convertDepth(vec4 value) {

        float packed = uint2float(value);
        float screenDepth;

        #ifdef COVERAGE_DEPTH_RECIPROCAL
            float recip = value.r;
            screenDepth = recip > 0.0 ? 1.0 / recip : uCoverageCameraParams.y;
        #elif defined(COVERAGE_DEPTH_LINEAR_PACKED)
            screenDepth = packed;
        #elif defined(COVERAGE_DEPTH_LINEAR)
            screenDepth = value.r;
        #elif defined(SCENE_DEPTHMAP_FLOAT)
            screenDepth = value.r;
        #else
            screenDepth = packed;
        #endif

        return uCoverageReadScreenDepth > 0.5 ? screenDepth : packed;
    }

    void main() {

        vec2 uv = gl_FragCoord.xy * uCoverageDestPixelToUv;
        vec2 o = 0.5 * uCoverageInvSrcSize;

        float d0 = convertDepth(textureLod(uCoverageDepth, min(uv + vec2(-o.x, -o.y), uCoverageSrcUvMax), 0.0));
        float d1 = convertDepth(textureLod(uCoverageDepth, min(uv + vec2( o.x, -o.y), uCoverageSrcUvMax), 0.0));
        float d2 = convertDepth(textureLod(uCoverageDepth, min(uv + vec2(-o.x,  o.y), uCoverageSrcUvMax), 0.0));
        float d3 = convertDepth(textureLod(uCoverageDepth, min(uv + vec2( o.x,  o.y), uCoverageSrcUvMax), 0.0));

        gl_FragColor = float2uint(max(max(d0, d1), max(d2, d3)));
    }
`;
