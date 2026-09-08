export default `

    attribute float aCoveragePixel;

    flat out float out_depth;

    uniform float uCoverageReadScreenDepth;
    uniform vec2 uCoverageInvSrcSize;
    uniform vec2 uCoverageDestPixelToUv;
    uniform vec2 uCoverageDestSize;
    uniform vec2 uCoverageSrcUvMax;
    uniform vec4 uCoverageCameraParams;
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

        // Pack view-space Z (metres). Device Z is nonlinear; far compares need linear.
        vec4 p = uCoverageCameraParams;
        if (p.w == 0.0) {
            maxDepth = (p.z * p.y) / (p.y + maxDepth * (p.z - p.y));
        }
        else {
            maxDepth = p.z + maxDepth * (p.y - p.z);
        }

        out_depth = maxDepth;
        gl_Position = vec4(0.0);
        gl_PointSize = 1.0;
    }
`;
