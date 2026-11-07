export default `

    // Bound so the pack draw has a vertex buffer. The texel index is gl_VertexID.
    attribute float aCoveragePixel;

    flat out float out_depth;

    uniform int uCoverageMipLevel;
    uniform ivec4 uCoverageSize; // xy: packed pixels, zw: HZB texel count, the fetch clamp
    uniform vec2 uCoverageSpan; // screen footprint in mip texels
    uniform vec4 uCoverageCameraParams; // x: 1/far, y: far, z: near, w: 1 if orthographic
    uniform highp sampler2D uCoverageDepth;

    #include "floatAsUintPS"

    // w is 0 for perspective and 1 for ortho. Device Z is 0 at near and 1 at far.
    float linearizeDepth(float deviceZ) {

        float nearClip = uCoverageCameraParams.z;
        float farClip = uCoverageCameraParams.y;

        // Cleared depth (sky) is exactly 1.
        // The CPU compares against the same float32 far.
        if (deviceZ >= 1.0) {
            return farClip;
        }

        if (uCoverageCameraParams.w > 0.5) {
            return nearClip + deviceZ * (farClip - nearClip);
        }

        // 1 - deviceZ is exact near 1, so far depths do not cancel.
        return (nearClip * farClip) / (farClip * (1.0 - deviceZ) + nearClip * deviceZ);
    }

    // HZB stores device Z. RGBA8 is packed with float2uint; float mips keep it in .r.
    float decodeDeviceZ(vec4 value) {
        #if defined(DEPTH_IS_FLOAT) || defined(DEPTH_IS_FLOAT16)
            return value.r;
        #else
            return uint2float(value);
        #endif
    }

    // Inclusive bin. The chosen mip keeps it to a few texels.
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

    // A cell wider than this covers more than the texel under its centre.
    const float WIDE_CELL = 1.5;
    // edge1 is exclusive. Step back so a boundary does not include the next texel.
    const float EDGE_GAP = 0.001;

    // Inclusive texel range of one axis. Returns (min, max).
    // A narrow cell reads the texel under its centre. A wide cell reads every texel it covers.
    ivec2 binAxis(float edge0, float edge1) {
        float width = edge1 - edge0;
        int center = int(floor((edge0 + edge1) * 0.5));
        if (width > WIDE_CELL) {
            return ivec2(int(floor(edge0)), int(floor(edge1 - EDGE_GAP)));
        }
        return ivec2(center);
    }

    void main(void) {

        ivec2 packed = uCoverageSize.xy;
        ivec2 limit = max(uCoverageSize.zw - ivec2(1), ivec2(0));

        int id = gl_VertexID;
        ivec2 pixel = ivec2(id % packed.x, id / packed.x);

        // Bottom-left origin, same as the HZB texture and CPU row 0.
        // Pixel i covers screen UV [i / packed, (i + 1) / packed].
        vec2 span = uCoverageSpan;
        vec2 texel0 = vec2(pixel) * span / vec2(packed);
        vec2 texel1 = vec2(pixel + ivec2(1)) * span / vec2(packed);

        ivec2 xBin = binAxis(texel0.x, texel1.x);
        ivec2 yBin = binAxis(texel0.y, texel1.y);
        ivec2 minTexel = clamp(ivec2(xBin.x, yBin.x), ivec2(0), limit);
        ivec2 maxTexel = clamp(ivec2(xBin.y, yBin.y), minTexel, limit);

        float maxDeviceZ = sampleMax(minTexel, maxTexel, uCoverageMipLevel);
        float linearizedDepth = linearizeDepth(maxDeviceZ);

        out_depth = linearizedDepth;
        gl_Position = vec4(0.0);
        gl_PointSize = 1.0;
    }
`;
