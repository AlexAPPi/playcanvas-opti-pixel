export default `

    #include "getDepthVS"

    float getRectDepth(vec3 rectMin, vec3 rectMax) {

        float posStart;
        float posEnd;
        float step;

        // Convert from NDC space [-1, 1] to texture space [0, 1]
        vec2 clampedRectMin = clamp(rectMin.xy * 0.5 + 0.5, vec2(0.0), vec2(1.0));
        vec2 clampedRectMax = clamp(rectMax.xy * 0.5 + 0.5, vec2(0.0), vec2(1.0));

        vec2 rectExtent = clampedRectMax - clampedRectMin;
        vec2 rectPixels = rectExtent * uHZBSize;

        float rectSize = max(rectPixels.x, rectPixels.y) / 2.0;
        float level    = clamp(ceil(log2(rectSize)), MIN_LEVEL, MAX_LEVEL);

        vec2 scale = rectExtent / 3.0;
	    vec2 bias  = clampedRectMax;
        vec4 minDepth = vec4(1.0);

        for (int i = 0; i < 4; i++ ) {
            vec4 depth;
            depth.x = getDepth(vec2(i, 0) * scale + bias, level);
            depth.y = getDepth(vec2(i, 1) * scale + bias, level);
            depth.z = getDepth(vec2(i, 2) * scale + bias, level);
            depth.w = getDepth(vec2(i, 3) * scale + bias, level);
            minDepth = min(minDepth, depth);
        }

        return min(min(minDepth.x, minDepth.y), min(minDepth.z, minDepth.w));
    }
`;