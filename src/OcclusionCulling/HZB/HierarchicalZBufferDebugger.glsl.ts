export default `

    #include "floatAsUintPS"
    #include "gammaPS"
    varying vec2 uv0;

    uniform vec4 camera_params;
    uniform float uDepthMipLevel;
    uniform highp sampler2D uDepthMip;

    float linearizeDepth(float z) {
        if (camera_params.w == 0.0) {
            return (camera_params.z * camera_params.y) / (camera_params.y + z * (camera_params.z - camera_params.y));
        }
        return camera_params.z + z * (camera_params.y - camera_params.z);
    }

    float extractDepthFromData(vec4 data) {
        #ifdef (DEPTH_IS_FLOAT || READ_DEPTH)
            return data.r;
        #else
            return uint2float(data);
        #endif
    }

    float getLinearScreenDepth(vec2 uv) {
        vec4 depthData = textureLod(uDepthMip, uv, uDepthMipLevel);
        float depth = extractDepthFromData(depthData);
        return linearizeDepth(depth);
    }

    void main() {
        vec2 mirrorYUV = vec2(uv0.x, 1.0 - uv0.y);
        float depth = getLinearScreenDepth(getImageEffectUV(mirrorYUV)) * camera_params.x;
        gl_FragColor = vec4(gammaCorrectOutput(vec3(depth)), 1.0);
    }
`;