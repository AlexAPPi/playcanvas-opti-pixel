export default `

    #include "getDepthVS"

    float getRectDepth(vec2 minCoord, vec2 maxCoord, vec2 screenSize, vec2 hzbSize) {

        float posStart;
        float posEnd;
        float step;

        vec2 extent = maxCoord - minCoord;
        vec2 viewSize = extent * hzbSize;

        float size = max(viewSize.x, viewSize.y);
        float lod  = clamp(ceil(log2(size)), MIN_LEVEL, MAX_LEVEL);

        float probe0 = getDepth(minCoord, lod);
        float probe1 = getDepth(maxCoord, lod);
        float probe2 = getDepth(vec2(minCoord.x, maxCoord.y), lod);
        float probe3 = getDepth(vec2(maxCoord.x, minCoord.y), lod);

        return max(max(probe0, probe1), max(probe2, probe3));
    }
`;