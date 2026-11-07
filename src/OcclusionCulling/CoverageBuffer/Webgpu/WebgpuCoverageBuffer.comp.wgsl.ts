export default `

    #include "floatAsUintPS"

    const GROUP_SIZE: u32 = 8u;

    struct Uniforms {
        uCoverageMipLevel: i32,
        uCoverageSize: vec4<i32>, // xy: packed pixels, zw: HZB texel count, the fetch clamp
        uCoverageCameraParams: vec4<f32>, // x: 1/far, y: far, z: near, w: 1 if orthographic
        uCoverageSpan: vec2<f32> // screen footprint in mip texels
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
        if (deviceZ >= 1.0) {
            return farClip;
        }
        if (uniforms.uCoverageCameraParams.w > 0.5) {
            return nearClip + deviceZ * (farClip - nearClip);
        }
        return (nearClip * farClip) / (farClip * (1.0 - deviceZ) + nearClip * deviceZ);
    }

    // HZB stores device Z. RGBA8 is packed with float2uint; float mips keep it in .r.
    fn decodeDeviceZ(value: vec4<f32>) -> f32 {
        #if defined(DEPTH_IS_FLOAT) || defined(DEPTH_IS_FLOAT16)
            return value.r;
        #else
            return uint2float(value);
        #endif
    }

    // Inclusive bin. The chosen mip keeps it to a few texels.
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

    // A cell wider than this covers more than the texel under its centre.
    const WIDE_CELL: f32 = 1.5;
    // edge1 is exclusive. Step back so a boundary does not include the next texel.
    const EDGE_GAP: f32 = 0.001;

    // Inclusive texel range of one axis. Returns (min, max).
    // A narrow cell reads the texel under its centre. A wide cell reads every texel it covers.
    fn binAxis(edge0: f32, edge1: f32) -> vec2i {
        let width = edge1 - edge0;
        let center = i32(floor((edge0 + edge1) * 0.5));
        if (width > WIDE_CELL) {
            return vec2i(i32(floor(edge0)), i32(floor(edge1 - EDGE_GAP)));
        }
        return vec2i(center, center);
    }

    @compute @workgroup_size(GROUP_SIZE, GROUP_SIZE, 1)
    fn main(@builtin(global_invocation_id) gid: vec3u) {

        let packed = uniforms.uCoverageSize.xy;
        let limit = max(uniforms.uCoverageSize.zw - vec2i(1), vec2i(0));
        let pixel = vec2i(i32(gid.x), i32(gid.y));

        // Dispatch is rounded up to the workgroup.
        if (pixel.x >= packed.x || pixel.y >= packed.y) {
            return;
        }

        // Pixel i covers screen UV [i / packed, (i + 1) / packed], in mip texels
        // from the bottom-left. Texture row 0 is the top of the screen, so Y
        // bins the flipped edges.
        let span = uniforms.uCoverageSpan;
        let texel0 = vec2f(pixel) * span / vec2f(packed);
        let texel1 = vec2f(pixel + vec2i(1)) * span / vec2f(packed);

        let xBin = binAxis(texel0.x, texel1.x);
        let yBin = binAxis(span.y - texel1.y, span.y - texel0.y);
        let minTexel = clamp(vec2i(xBin.x, yBin.x), vec2i(0), limit);
        let maxTexel = clamp(vec2i(xBin.y, yBin.y), minTexel, limit);

        let id = gid.y * u32(packed.x) + gid.x;
        let maxDeviceZ = sampleMax(minTexel, maxTexel, uniforms.uCoverageMipLevel);
        let linearizedDepth = linearizeDepth(maxDeviceZ);

        out_depth[id] = linearizedDepth;
    }
`;
