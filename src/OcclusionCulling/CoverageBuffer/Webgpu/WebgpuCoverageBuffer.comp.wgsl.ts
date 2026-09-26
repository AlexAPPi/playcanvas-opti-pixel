export default `
    #include "floatAsUintPS"

    const GROUP_SIZE: u32 = 8u;

    struct Uniforms {
        readScreenDepth: i32,
        _pad0: i32,
        invSrcSize: vec2<f32>,
        destPixelToUv: vec2<f32>,
        srcUvMax: vec2<f32>,
        destSize: vec2<f32>,
        padDest: vec2<f32>,
        cameraParams: vec4<f32>
    }

    @group(0) @binding(0) var<uniform> uniforms: Uniforms;
    @group(0) @binding(1) var srcDepth: texture_2d<f32>;
    @group(0) @binding(2) var srcDepthSampler: sampler;

    #ifdef PACK_TO_BUFFER
    @group(0) @binding(3) var<storage, read_write> outDepth: array<f32>;
    #else
    @group(0) @binding(3) var dstDepth: texture_storage_2d<rgba8unorm, write>;
    #endif

    fn convertDepth(value: vec4f) -> f32 {

        if (uniforms.readScreenDepth == 1) {

            #ifdef COVERAGE_DEPTH_RECIPROCAL
                let recip = value.r;
                return select(uniforms.cameraParams.y, 1.0 / recip, recip > 0.0);
            #elif defined(COVERAGE_DEPTH_LINEAR_PACKED)
                return uint2float(value);
            #elif defined(COVERAGE_DEPTH_LINEAR)
                return value.r;
            #elif defined(SCENE_DEPTHMAP_FLOAT)
                return value.r;
            #else
                return uint2float(value);
            #endif
        }

        return uint2float(value);
    }

    fn sampleMax(uv: vec2f) -> f32 {
        let o = 0.5 * uniforms.invSrcSize;
        let d0 = convertDepth(textureSampleLevel(srcDepth, srcDepthSampler, min(uv + vec2f(-o.x, -o.y), uniforms.srcUvMax), 0.0));
        let d1 = convertDepth(textureSampleLevel(srcDepth, srcDepthSampler, min(uv + vec2f( o.x, -o.y), uniforms.srcUvMax), 0.0));
        let d2 = convertDepth(textureSampleLevel(srcDepth, srcDepthSampler, min(uv + vec2f(-o.x,  o.y), uniforms.srcUvMax), 0.0));
        let d3 = convertDepth(textureSampleLevel(srcDepth, srcDepthSampler, min(uv + vec2f( o.x,  o.y), uniforms.srcUvMax), 0.0));
        return max(max(d0, d1), max(d2, d3));
    }

    #ifndef COVERAGE_DEPTH_VIEW
    fn linearizeDepth(z: f32) -> f32 {
        let n = uniforms.cameraParams.z;
        let f = uniforms.cameraParams.y;
        if (uniforms.cameraParams.w == 0.0) {
            return (n * f) / (f + z * (n - f));
        }
        return n + z * (f - n);
    }
    #endif

    @compute @workgroup_size(GROUP_SIZE, GROUP_SIZE, 1)
    fn main(@builtin(global_invocation_id) gid: vec3u) {

        let destW = u32(uniforms.destSize.x + 0.5);
        let destH = u32(uniforms.destSize.y + 0.5);

        if (gid.x >= destW || gid.y >= destH) {
            return;
        }

        var uv = (vec2f(gid.xy) + 0.5) * uniforms.destPixelToUv;

        #ifdef PACK_TO_BUFFER
            // CPU / NDC tests use GL convention (row 0 = NDC y = -1 = bottom).
            // WebGPU textures are stored top-left, so invert Y like WebGPU HZB getDepth.
            uv = vec2f(uv.x, 1.0 - uv.y);
        #endif

        var maxDepth = sampleMax(uv);

        #ifdef PACK_TO_BUFFER

            #ifndef COVERAGE_DEPTH_VIEW
                maxDepth = linearizeDepth(maxDepth);
            #endif

            outDepth[gid.y * destW + gid.x] = maxDepth;

        #else

            textureStore(dstDepth, gid.xy, float2uint(maxDepth));

        #endif
    }
`;
