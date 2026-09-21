export default `

    #include "gammaPS"
    varying vec2 uv0;

    uniform vec4 camera_params;
    uniform highp sampler2D uDepthMip;

    void main() {
        vec2 uv = vec2(uv0.x, 1.0 - uv0.y);
        float z = textureLod(uDepthMip, uv, 0.0).r * camera_params.x;
        gl_FragColor = vec4(gammaCorrectOutput(vec3(z)), 1.0);
    }
`;
