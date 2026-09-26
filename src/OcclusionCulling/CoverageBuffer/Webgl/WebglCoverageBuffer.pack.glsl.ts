export default `

    attribute float aCoveragePixel;

    flat out float out_depth;

    uniform float uCoverageReadScreenDepth;
    uniform vec2 uCoverageInvSrcSize;
    uniform vec2 uCoverageDestPixelToUv;
    uniform vec2 uCoverageDestSize;
    uniform vec2 uCoverageSrcUvMax;
    uniform highp sampler2D uCoverageDepth;

    #if !defined(COVERAGE_DEPTH_VIEW) || defined(COVERAGE_DEPTH_RECIPROCAL)
    uniform vec4 uCoverageCameraParams; // x: 1/far, y: far, z: near, w: 1 if orthographic
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

    #ifndef COVERAGE_DEPTH_VIEW
    float linearizeDepth(float deviceZ) {
        float nearClip = uCoverageCameraParams.z;
        float farClip = uCoverageCameraParams.y;
        if (uCoverageCameraParams.w == 0.0) {
            return (nearClip * farClip) / (farClip + deviceZ * (nearClip - farClip));
        }
        return nearClip + deviceZ * (farClip - nearClip);
    }
    #endif

    void main(void) {

        int id = gl_VertexID;
        int destW = int(uCoverageDestSize.x + 0.5);
        int px = id - destW * (id / destW);
        int py = id / destW;
        vec2 uv = (vec2(float(px), float(py)) + 0.5) * uCoverageDestPixelToUv;
        vec2 o = 0.5 * uCoverageInvSrcSize;

        float d0 = convertDepth(textureLod(uCoverageDepth, min(uv + vec2(-o.x, -o.y), uCoverageSrcUvMax), 0.0));
        float d1 = convertDepth(textureLod(uCoverageDepth, min(uv + vec2( o.x, -o.y), uCoverageSrcUvMax), 0.0));
        float d2 = convertDepth(textureLod(uCoverageDepth, min(uv + vec2(-o.x,  o.y), uCoverageSrcUvMax), 0.0));
        float d3 = convertDepth(textureLod(uCoverageDepth, min(uv + vec2( o.x,  o.y), uCoverageSrcUvMax), 0.0));

        float maxDepth = max(max(d0, d1), max(d2, d3));

        #ifndef COVERAGE_DEPTH_VIEW
            maxDepth = linearizeDepth(maxDepth);
        #endif

        out_depth = maxDepth;
        gl_Position = vec4(0.0);
        gl_PointSize = 1.0;
    }
`;
