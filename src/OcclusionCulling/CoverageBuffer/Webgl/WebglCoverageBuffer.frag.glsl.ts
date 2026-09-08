export default `

    // Depth downsample:
    // 4 taps at +-0.5 source texels, then max (device Z).
    // Conservative: a coarse texel is only closer if every tap was closer.

    uniform float uCoverageReadScreenDepth;
    uniform vec2 uCoverageInvSrcSize;
    uniform vec2 uCoverageDestPixelToUv;
    uniform vec2 uCoverageSrcUvMax;
    uniform highp sampler2D uCoverageDepth;

    #ifdef WORKAROUND_FLOAT
    #include "floatAsUintPS"
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

        #ifdef SCENE_DEPTHMAP_FLOAT
            float screenDepth = value.r;
        #else
            float screenDepth = workaroundFloat;
        #endif

        return uCoverageReadScreenDepth > 0.5 ? screenDepth : mipDepth;
    }

    void main() {

        vec2 uv = gl_FragCoord.xy * uCoverageDestPixelToUv;
        vec2 o = 0.5 * uCoverageInvSrcSize;

        float d0 = convertDepth(textureLod(uCoverageDepth, min(uv + vec2(-o.x, -o.y), uCoverageSrcUvMax), 0.0));
        float d1 = convertDepth(textureLod(uCoverageDepth, min(uv + vec2( o.x, -o.y), uCoverageSrcUvMax), 0.0));
        float d2 = convertDepth(textureLod(uCoverageDepth, min(uv + vec2(-o.x,  o.y), uCoverageSrcUvMax), 0.0));
        float d3 = convertDepth(textureLod(uCoverageDepth, min(uv + vec2( o.x,  o.y), uCoverageSrcUvMax), 0.0));

        float maxDepth = max(max(d0, d1), max(d2, d3));

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
