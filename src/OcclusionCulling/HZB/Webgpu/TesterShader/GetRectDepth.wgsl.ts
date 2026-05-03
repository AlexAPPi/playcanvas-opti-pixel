export default `

    #include "getDepthCS"

    fn getRectDepth(minCoord: vec2<f32>, maxCoord: vec2<f32>, screenSize: vec2<f32>, hzbSize: vec2<f32>) -> f32 {

        let extent: vec2<f32> = maxCoord - minCoord;
        let viewSize: vec2<f32> = extent * hzbSize;

        let size: f32 = max(viewSize.x, viewSize.y);
        let lod: f32 = clamp(ceil(log2(size)), {MIN_LEVEL}, {MAX_LEVEL});

        let probe0: f32 = getDepth(minCoord, lod);
        let probe1: f32 = getDepth(maxCoord, lod);
        let probe2: f32 = getDepth(vec2<f32>(minCoord.x, maxCoord.y), lod);
        let probe3: f32 = getDepth(vec2<f32>(maxCoord.x, minCoord.y), lod);

        return max(max(probe0, probe1), max(probe2, probe3));
    }
`;