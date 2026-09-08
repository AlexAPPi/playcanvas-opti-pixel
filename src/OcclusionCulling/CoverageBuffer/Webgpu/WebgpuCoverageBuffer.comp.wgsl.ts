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
    @group(0) @binding(3) var dstDepth: texture_storage_2d<{DST_DEPTH_FORMAT}, write>;
    #endif

    fn convertDepth(value: vec4f) -> f32 {

        if (uniforms.readScreenDepth == 1) {
            #ifdef SCENE_DEPTHMAP_FLOAT
                return value.r;
            #else
                return uint2float(value);
            #endif
        }

        #ifdef (DEPTH_IS_FLOAT || DEPTH_IS_FLOAT16)
            return value.r;
        #else
            return uint2float(value);
        #endif
    }

    fn sampleMax(uv: vec2f) -> f32 {
        let o = 0.5 * uniforms.invSrcSize;
        let d0 = convertDepth(textureSampleLevel(srcDepth, srcDepthSampler, min(uv + vec2f(-o.x, -o.y), uniforms.srcUvMax), 0.0));
        let d1 = convertDepth(textureSampleLevel(srcDepth, srcDepthSampler, min(uv + vec2f( o.x, -o.y), uniforms.srcUvMax), 0.0));
        let d2 = convertDepth(textureSampleLevel(srcDepth, srcDepthSampler, min(uv + vec2f(-o.x,  o.y), uniforms.srcUvMax), 0.0));
        let d3 = convertDepth(textureSampleLevel(srcDepth, srcDepthSampler, min(uv + vec2f( o.x,  o.y), uniforms.srcUvMax), 0.0));
        return max(max(d0, d1), max(d2, d3));
    }

    fn linearizeDepth(z: f32) -> f32 {
        let n = uniforms.cameraParams.z;
        let f = uniforms.cameraParams.y;
        if (uniforms.cameraParams.w == 0.0) {
            return (n * f) / (f + z * (n - f));
        }
        return n + z * (f - n);
    }

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

        let maxDepth = sampleMax(uv);

        #ifdef PACK_TO_BUFFER
            outDepth[gid.y * destW + gid.x] = linearizeDepth(maxDepth);
        #else

            #ifdef (DEPTH_IS_FLOAT || DEPTH_IS_FLOAT16)
                textureStore(dstDepth, gid.xy, vec4f(maxDepth, 0.0, 0.0, 1.0));
            #else
                textureStore(dstDepth, gid.xy, float2uint(maxDepth));
            #endif

        #endif
    }
`;
