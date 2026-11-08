export default `

    #include "floatAsUintPS"
    #include "gammaPS"
    varying vec2 uv0;

    uniform float uCoverageInvFar;
    uniform float uOpacity;
    uniform highp sampler2D uDepthMip;

    void main() {
        // RGBA8 is the little-endian bytes of the float. uint2float wants the high byte in R.
        vec2 uv = vec2(uv0.x, 1.0 - uv0.y);
        vec4 depth = textureLod(uDepthMip, uv, 0.0);
        float z = uint2float(depth.abgr) * uCoverageInvFar;
        gl_FragColor = vec4(gammaCorrectOutput(vec3(z)), uOpacity);
    }
`;
