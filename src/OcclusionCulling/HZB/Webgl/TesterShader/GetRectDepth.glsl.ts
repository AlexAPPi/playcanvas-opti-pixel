export default `

    #include "getDepthVS"

    float getRectDepth(vec2 minCoord, vec2 maxCoord) {

        float posStart;
        float posEnd;
        float step;

        vec2 clampedMinCoord = clamp(minCoord, vec2(0.0), vec2(1.0));
        vec2 clampedMaxCoord = clamp(maxCoord, vec2(0.0), vec2(1.0));

        vec2 extent = clampedMaxCoord - clampedMinCoord;
        vec2 viewSize = extent * uHZBSize;

        float size = max(viewSize.x, viewSize.y) / 2.0;
        float lod  = clamp(ceil(log2(size)), MIN_LEVEL, MAX_LEVEL);

        float probe0 = getDepth(clampedMinCoord, lod);
        float probe1 = getDepth(clampedMaxCoord, lod);
        float probe2 = getDepth(vec2(clampedMinCoord.x, clampedMaxCoord.y), lod);
        float probe3 = getDepth(vec2(clampedMaxCoord.x, clampedMinCoord.y), lod);

        return max(max(probe0, probe1), max(probe2, probe3));
    }
`;