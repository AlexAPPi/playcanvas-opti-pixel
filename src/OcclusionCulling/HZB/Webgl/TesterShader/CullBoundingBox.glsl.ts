export default `

    #include "getRectDepthVS"

    #ifdef DEPTH_IS_FLOAT16

    uint f32ToF16Bits(float v) {
        return packHalf2x16(vec2(v, 0.0)) & 0xFFFFu;
    }

    float f16BitsToF32(uint h) {
        return unpackHalf2x16(h).x;
    }

    float nextUpF16(float v) {
        uint h = f32ToF16Bits(v);
        uint sign = (h >> 15u) & 1u;
        uint inc = sign == 0u ? 1u : 0xFFFFFFFFu;
        uint h_next = h + inc;
        h_next = (h == 0x8000u) ? 0u : h_next;
        h_next = ((h == 0x7C00u) || (h == 0xFC00u)) ? h : h_next;
        return f16BitsToF32(h_next);
    }

    float nextDownF16(float v) {
        return -nextUpF16(-v);
    }

    #endif

    int cullBoundingBox(vec3 boxCenter, vec3 boxExtents, out vec3 rectMin, out vec3 rectMax) {

        rectMin = vec3( 1.0,  1.0,  1.0);
        rectMax = vec3(-1.0, -1.0, -1.0);

        vec3 boundsMin = boxCenter.xyz - boxExtents.xyz;
	    vec3 boundsMax = boxCenter.xyz + boxExtents.xyz;
	    vec3 bounds[2] = vec3[](boundsMin, boundsMax);

        for (int i = 0; i < 8; i++) {

            vec3 pointSrc = vec3(
                bounds[(i >> 0) & 1].x,
                bounds[(i >> 1) & 1].y,
                bounds[(i >> 2) & 1].z
            );

            vec4 pointClip   = uMatrixViewProjection * vec4(pointSrc, 1.0);
            vec3 pointScreen = pointClip.xyz / pointClip.w;

            rectMin = min(rectMin, pointScreen);
            rectMax = max(rectMax, pointScreen);
        }

        float rectZ = rectMin.z;
        float deviceZ = getRectDepth(rectMin, rectMax);

        #ifdef DEPTH_IS_FLOAT16

            #ifdef GL_FRAGMENT_PRECISION_HIGH

                // We quantize the value in the opposite direction,
                // since the precision of float32 is enough to bypass
                // the quantization of float16.
                rectZ = nextDownF16(rectZ);

            #endif

        #endif

        return rectZ > deviceZ ? 1 : 0;
    }
`;