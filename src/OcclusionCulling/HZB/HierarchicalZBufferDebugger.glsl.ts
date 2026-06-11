export default `

    #include "floatAsUintPS"
    #include "gammaPS"
    varying vec2 uv0;

    uniform vec4 camera_params;
    uniform vec2 uHZBFactor;
    uniform float uDepthMipLevel;
    uniform highp sampler2D uDepthMip;

    float linearizeDepth(float z) {
        if (camera_params.w == 0.0) {
            return (camera_params.z * camera_params.y) / (camera_params.y + z * (camera_params.z - camera_params.y));
        }
        return camera_params.z + z * (camera_params.y - camera_params.z);
    }

    float extractDepthFromData(vec4 data) {
        #ifdef (DEPTH_IS_FLOAT || DEPTH_IS_FLOAT16 || READ_DEPTH)
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

        // We sample the UV coordinates relative to the Level 0 HZB mipmap canvas,
        // since the rendering along the Y-axis was inverted.
        vec2 factoredUv = uHZBFactor * uv0;
        vec2 adaptedUv = vec2(factoredUv.x, uHZBFactor.y - factoredUv.y);

        float depth = getLinearScreenDepth(adaptedUv) * camera_params.x;
        gl_FragColor = vec4(gammaCorrectOutput(vec3(depth)), 1.0);
    }
`;