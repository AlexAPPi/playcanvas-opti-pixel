export default `

    #include "getDepthCS"

    fn getRectDepth(rectMin: vec3f, rectMax: vec3f) -> f32 {

        let rawRect = vec4f(rectMin.xy, rectMax.xy) * 0.5 + 0.5;
        let clampedRect = clamp(rawRect, vec4f(0.0), vec4f(1.0));
        let rect = clampedRect.xwzy;
        let rectPixels = rect * uniforms.hzbSize.xyxy;
        let rectSize = (rectPixels.zw - rectPixels.xy) * 0.5; // 0.5 for 4x4
        var level = max(ceil(log2(max(rectSize.x, rectSize.y))), uniforms.hzbUvFactor.z);

        let levelLower = max(level - 1.0, 0.0);
        let lowerRect = rectPixels * exp2(-levelLower);
        let lowerRectSize = ceil(lowerRect.zw) - floor(lowerRect.xy);
        if (all(lowerRectSize <= vec2f(4.0))) {
            level = levelLower;
        }

        let hzbUvFactor = vec2f(uniforms.hzbUvFactor.xy);
        let scale = hzbUvFactor.xy * (rect.zw - rect.xy) / 3.0;
        let bias = hzbUvFactor.xy * rect.xy;
        var maxDepth = vec4f(0.0);

        for (var i: f32 = 0.0; i < 4.0; i = i + 1.0) {
            let depth = vec4f(
                getDepth(vec2f(i, 0.0) * scale + bias, level),
                getDepth(vec2f(i, 1.0) * scale + bias, level),
                getDepth(vec2f(i, 2.0) * scale + bias, level),
                getDepth(vec2f(i, 3.0) * scale + bias, level)
            );
            maxDepth = max(maxDepth, depth);
        }

        return max(max(maxDepth.x, maxDepth.y), max(maxDepth.z, maxDepth.w));
    }
`;