export default `

    attribute float aCoveragePixel;

    flat out float out_depth;

    uniform int uCoverageMipLevel;
    uniform ivec4 uCoverageSize; // xy: packed pixels, zw: HZB texels of the screen footprint. zw >= xy, all >= 1.
    uniform vec4 uCoverageCameraParams; // x: 1/far, y: far, z: near, w: 1 if orthographic
    uniform highp sampler2D uCoverageDepth;

    #include "floatAsUintPS"

    // w is 0 for perspective and 1 for ortho. Device Z is 0 at near and 1 at far.
    float linearizeDepth(float deviceZ) {
        float nearClip = uCoverageCameraParams.z;
        float farClip = uCoverageCameraParams.y;
        float perspective = (nearClip * farClip) / (farClip + deviceZ * (nearClip - farClip));
        float ortho = nearClip + deviceZ * (farClip - nearClip);
        return mix(perspective, ortho, uCoverageCameraParams.w);
    }

    // HZB stores device Z. RGBA8 is packed with float2uint; float mips keep it in .r.
    float decodeDeviceZ(vec4 value) {
        #if defined(DEPTH_IS_FLOAT) || defined(DEPTH_IS_FLOAT16)
            return value.r;
        #else
            return uint2float(value);
        #endif
    }

    // Inclusive bin. selectCoverageMip keeps it to a few texels.
    float sampleMax(ivec2 minTexel, ivec2 maxTexel, int level) {
        float maxDeviceZ = 0.0;
        for (int y = minTexel.y; y <= maxTexel.y; y++) {
            for (int x = minTexel.x; x <= maxTexel.x; x++) {
                vec4 value = texelFetch(uCoverageDepth, ivec2(x, y), level);
                float deviceZ = decodeDeviceZ(value);
                maxDeviceZ = max(maxDeviceZ, deviceZ);
            }
        }
        return maxDeviceZ;
    }

    void main(void) {

        ivec2 dest = uCoverageSize.xy;
        ivec2 src = uCoverageSize.zw;

        int id = gl_VertexID;
        ivec2 pixel = ivec2(id % dest.x, id / dest.x);

        // WebGL HZB texel 0 is the bottom of the screen, same as CPU row 0.
        // Pixel i owns source texels [i * src / dest, (i + 1) * src / dest).
        ivec2 minTexel = pixel * src / dest;
        ivec2 maxTexel = (pixel + ivec2(1)) * src / dest - ivec2(1);

        out_depth = linearizeDepth(sampleMax(minTexel, maxTexel, uCoverageMipLevel));
        gl_Position = vec4(0.0);
        gl_PointSize = 1.0;
    }
`;
