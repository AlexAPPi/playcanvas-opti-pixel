export default `

    #include "gammaPS"
    varying vec2 uv0;

    uniform float uCoverageInvFar;
    uniform float uOpacity;
    uniform highp sampler2D uDepthMip;

    void main() {
        vec2 uv = vec2(uv0.x, 1.0 - uv0.y);
        float z = textureLod(uDepthMip, uv, 0.0).r * uCoverageInvFar;
        gl_FragColor = vec4(gammaCorrectOutput(vec3(z)), uOpacity);
    }
`;
