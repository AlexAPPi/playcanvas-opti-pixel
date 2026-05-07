export default `

    #include "getDepthCS"

    fn getRectDepth(minCoord: vec2<f32>, maxCoord: vec2<f32>) -> f32 {

        let clampedMinCoord: vec2<f32> = clamp(minCoord, vec2<f32>(0.0), vec2<f32>(1.0));
        let clampedMaxCoord: vec2<f32> = clamp(maxCoord, vec2<f32>(0.0), vec2<f32>(1.0));

        let extent: vec2<f32> = clampedMaxCoord - clampedMinCoord;
        let viewSize: vec2<f32> = extent * uniforms.hzbSize;

        let size: f32 = max(viewSize.x, viewSize.y) / 2.0;
        let lod: f32 = clamp(ceil(log2(size)), {MIN_LEVEL}, {MAX_LEVEL});

        let probe0: f32 = getDepth(clampedMinCoord, lod);
        let probe1: f32 = getDepth(clampedMaxCoord, lod);
        let probe2: f32 = getDepth(vec2<f32>(clampedMinCoord.x, clampedMaxCoord.y), lod);
        let probe3: f32 = getDepth(vec2<f32>(clampedMaxCoord.x, clampedMinCoord.y), lod);

        return max(max(probe0, probe1), max(probe2, probe3));
    }
`;