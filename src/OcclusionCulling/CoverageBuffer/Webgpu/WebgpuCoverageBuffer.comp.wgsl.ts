export default `

    #include "floatAsUintPS"

    const GROUP_SIZE: u32 = 8u;

    struct Uniforms {
        uCoverageMipLevel: i32,
        uCoverageSize: vec4<i32>, // xy: packed pixels, zw: HZB texels of the screen footprint. zw >= xy, all >= 1.
        uCoverageCameraParams: vec4<f32> // x: 1/far, y: far, z: near, w: 1 if orthographic
    }

    @group(0) @binding(0) var<uniform> uniforms: Uniforms;

    #ifdef DEPTH_IS_FLOAT16
    @group(0) @binding(1) var uCoverageDepth: texture_2d<f16>;
    #else
    @group(0) @binding(1) var uCoverageDepth: texture_2d<f32>;
    #endif

    @group(0) @binding(2) var<storage, read_write> out_depth: array<f32>;

    // w is 0 for perspective and 1 for ortho. Device Z is 0 at near and 1 at far.
    fn linearizeDepth(deviceZ: f32) -> f32 {
        let nearClip = uniforms.uCoverageCameraParams.z;
        let farClip = uniforms.uCoverageCameraParams.y;
        let perspective = (nearClip * farClip) / (farClip + deviceZ * (nearClip - farClip));
        let ortho = nearClip + deviceZ * (farClip - nearClip);
        return mix(perspective, ortho, uniforms.uCoverageCameraParams.w);
    }

    // HZB stores device Z. RGBA8 is packed with float2uint; float mips keep it in .r.
    fn decodeDeviceZ(value: vec4<f32>) -> f32 {
        #if defined(DEPTH_IS_FLOAT) || defined(DEPTH_IS_FLOAT16)
            return value.r;
        #else
            return uint2float(value);
        #endif
    }

    // Inclusive bin. selectCoverageMip keeps it to a few texels.
    fn sampleMax(minTexel: vec2i, maxTexel: vec2i, level: i32) -> f32 {
        var maxDeviceZ = 0.0;
        for (var y = minTexel.y; y <= maxTexel.y; y++) {
            for (var x = minTexel.x; x <= maxTexel.x; x++) {
                // f16 loads vec4<f16>. Widen so decodeDeviceZ takes vec4<f32>.
                let value = vec4<f32>(textureLoad(uCoverageDepth, vec2i(x, y), level));
                let deviceZ = decodeDeviceZ(value);
                maxDeviceZ = max(maxDeviceZ, deviceZ);
            }
        }
        return maxDeviceZ;
    }

    @compute @workgroup_size(GROUP_SIZE, GROUP_SIZE, 1)
    fn main(@builtin(global_invocation_id) gid: vec3u) {

        let dest = uniforms.uCoverageSize.xy;
        let src = uniforms.uCoverageSize.zw;
        let pixel = vec2i(i32(gid.x), i32(gid.y));

        // Dispatch is rounded up to the workgroup.
        if (pixel.x >= dest.x || pixel.y >= dest.y) {
            return;
        }

        // WebGPU HZB texel 0 is the top of the screen. CPU row 0 is the bottom.
        // Pixel i owns source texels [i * src / dest, (i + 1) * src / dest).
        let minTexel = pixel * src / dest;
        let maxTexel = (pixel + vec2i(1)) * src / dest - vec2i(1);
        let y0 = src.y - 1 - maxTexel.y;
        let y1 = src.y - 1 - minTexel.y;

        let id = gid.y * u32(dest.x) + gid.x;
        out_depth[id] = linearizeDepth(sampleMax(vec2i(minTexel.x, y0), vec2i(maxTexel.x, y1), uniforms.uCoverageMipLevel));
    }
`;
