export default 
`
    #include "floatAsUintPS"

    struct Uniforms {
        readScreenDepth: i32,
        includeSrcExtraColumn: i32,
        includeSrcExtraRow: i32
    }

    @group(0) @binding(0) var<uniform> uniforms: Uniforms;
    @group(0) @binding(1) var screenDepth: texture_depth_2d;
    @group(0) @binding(2) var srcDepth: texture_2d<f32>;
    @group(0) @binding(3) var dstDepth: texture_storage_2d<{DEPTH_STORAGE_FORMAT}, write>;

    fn getDepth(coords: vec2i) -> f32 {

        if (uniforms.readScreenDepth == 1) {
            return textureLoad(screenDepth, coords, 0);
        }

        #ifdef DEPTH_IS_FLOAT
            return textureLoad(srcDepth, coords, 0).r;
        #else
            return uint2float(textureLoad(srcDepth, coords, 0));
        #endif
    }

    @compute @workgroup_size({WORKGROUP_SIZE_X}, {WORKGROUP_SIZE_Y}, 1)
    fn main(@builtin(global_invocation_id) gid: vec3u) {

        let coords = gid.xy;
        let size = vec2u(textureDimensions(dstDepth));

        if (all(coords < size)) {

            let base = vec2i(coords) * 2;

            let d0 = getDepth(base);
            let d1 = getDepth(base + vec2i(1, 0));
            let d2 = getDepth(base + vec2i(0, 1));
            let d3 = getDepth(base + vec2i(1, 1));

            var maxDepth = max(max(d0, d1), max(d2, d3));

            if (uniforms.includeSrcExtraColumn == 1) {

                let e0 = getDepth(base + vec2i(2, 0));
                let e1 = getDepth(base + vec2i(2, 1));
                maxDepth = max(maxDepth, max(e0, e1));

                // In the case where the width and height are both odd, need to include the
                // 'corner' value as well.
                if (uniforms.includeSrcExtraRow == 1) {
                    let cornerTexelValue = getDepth(base + vec2i(2, 2));
                    maxDepth = max(maxDepth, cornerTexelValue);
                }
            }

            if (uniforms.includeSrcExtraRow == 1) {
                let r0 = getDepth(base + vec2i(0, 2));
                let r1 = getDepth(base + vec2i(1, 2));
                maxDepth = max(maxDepth, max(r0, r1));
            }

            #if DEPTH_IS_FLOAT
                let result = vec4f(maxDepth, 0.0, 0.0, 1.0);
            #else
                let result: vec4f = float2uint(maxDepth);
            #endif

            textureStore(dstDepth, coords, result);
        }
    }
`;