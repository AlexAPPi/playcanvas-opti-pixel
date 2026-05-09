export default `

    #include "getDepthVS"

    float getRectDepth(vec3 rectMin, vec3 rectMax) {

        vec4 rect       = clamp(vec4(rectMin.xy, rectMax.xy) * 0.5 + 0.5, vec4(0.0), vec4(1.0)).xwzy;
        vec4 rectPixels = rect * uHZBSize.xyxy;
        vec2 rectSize   = (rectPixels.zw - rectPixels.xy) * 0.5; // 0.5 for 4x4
        float level     = max(ceil(log2(max(rectSize.x, rectSize.y))), uHZBUvFactor.z);

        // Check if we can drop one level lower
        float levelLower = max(level - 1.0, 0.0);
        vec4 lowerRect = rectPixels * exp2(-levelLower);
        vec2 lowerRectSize = ceil(lowerRect.zw) - floor(lowerRect.xy);
        if (all(lessThanEqual(lowerRectSize, vec2(4.0)))) {
            level = levelLower;
        }

        vec2 scale = uHZBUvFactor.xy * (rect.zw - rect.xy) / 3.0;
	    vec2 bias  = uHZBUvFactor.xy * rect.xy;
        vec4 maxDepth = vec4(0.0);

        for (int i = 0; i < 4; i++) {
            vec4 depth;
            depth.x = getDepth(vec2(i, 0) * scale + bias, level);
            depth.y = getDepth(vec2(i, 1) * scale + bias, level);
            depth.z = getDepth(vec2(i, 2) * scale + bias, level);
            depth.w = getDepth(vec2(i, 3) * scale + bias, level);
            maxDepth = max(maxDepth, depth);
        }

        return max(max(maxDepth.x, maxDepth.y), max(maxDepth.z, maxDepth.w));
    }
`;