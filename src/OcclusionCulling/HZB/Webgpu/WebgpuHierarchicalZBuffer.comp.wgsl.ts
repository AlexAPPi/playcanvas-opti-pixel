export default `
    #include "floatAsUintPS"

    const MAX_MIP_BATCH_SIZE: u32 = 4u;
    const MAX_MIP_BATCH_SIZE_MINUS_ONE: u32 = MAX_MIP_BATCH_SIZE - 1u;
    const GROUP_TILE_SIZE: u32 = 8u;
    const DIM_MIP_LEVEL_COUNT: u32 = {DIM_MIP_LEVEL_COUNT}u;

    struct Uniforms {
        readScreenDepth: i32,
        invSize: vec2<f32>,
        inputViewportMaxBound: vec2<f32>,
        dispatchThreadIdToBufferUV: vec4<f32>
    }

    @group(0) @binding(0) var<uniform> uniforms: Uniforms;
    @group(0) @binding(1) var srcDepth: texture_2d<{SRC_DEPTH_FORMAT}>;
    @group(0) @binding(2) var srcDepthSampler: sampler;

    #if DIM_MIP_LEVEL_COUNT >= 1
    @group(0) @binding(3) var dstDepth0: texture_storage_2d<{DST_DEPTH_FORMAT}, write>;
    #endif

    #if DIM_MIP_LEVEL_COUNT >= 2
    @group(0) @binding(4) var dstDepth1: texture_storage_2d<{DST_DEPTH_FORMAT}, write>;
    #endif

    #if DIM_MIP_LEVEL_COUNT >= 3
    @group(0) @binding(5) var dstDepth2: texture_storage_2d<{DST_DEPTH_FORMAT}, write>;
    #endif

    #if DIM_MIP_LEVEL_COUNT >= 4
    @group(0) @binding(6) var dstDepth3: texture_storage_2d<{DST_DEPTH_FORMAT}, write>;
    #endif

    fn minInVec(vec: vec4<f32>) -> f32 {
        return min(
            min(vec.x, vec.y),
            min(vec.z, vec.w)
        );
    }

    fn maxInVec(vec: vec4<f32>) -> f32 {
        return max(
            max(vec.x, vec.y),
            max(vec.z, vec.w)
        );
    }

    fn convertDepth(value: vec4f) -> f32 {

        // TODO: screen depth always f32 ?
        if (uniforms.readScreenDepth == 1) {
            return value.r;
        }

        #ifdef (DEPTH_IS_FLOAT || DEPTH_IS_FLOAT16)
            return value.r;
        #else
            return uint2float(value);
        #endif
    }

    fn gather4(bufferUV: vec2f) -> vec4f {

        // TODO: screen depth always f32 ?
        // TODO: textureGather availability on the platform ?
        #ifdef (DEPTH_IS_FLOAT || DEPTH_IS_FLOAT16)

        let uv = min(bufferUV + vec2(-0.25, -0.25) * uniforms.invSize, uniforms.inputViewportMaxBound - uniforms.invSize);
        return textureGather(0, srcDepth, srcDepthSampler, uv);

        #else

        // min(..., uInputViewportMaxBound) because we don't want to sample outside of the viewport
        // when the view size has odd dimensions on X/Y axis.
        let uv0 = min(bufferUV + vec2f(-0.25, -0.25) * uniforms.invSize, uniforms.inputViewportMaxBound);
        let uv1 = min(bufferUV + vec2f( 0.25, -0.25) * uniforms.invSize, uniforms.inputViewportMaxBound);
        let uv2 = min(bufferUV + vec2f(-0.25,  0.25) * uniforms.invSize, uniforms.inputViewportMaxBound);
        let uv3 = min(bufferUV + vec2f( 0.25,  0.25) * uniforms.invSize, uniforms.inputViewportMaxBound);

        let textureSize = vec2f(textureDimensions(srcDepth, 0) - 1u);
        let texel0 = vec2i(uv0 * textureSize);
        let texel1 = vec2i(uv1 * textureSize);
        let texel2 = vec2i(uv2 * textureSize);
        let texel3 = vec2i(uv3 * textureSize);

        var out: vec4f;
        out.x = convertDepth(textureLoad(srcDepth, texel0, 0));
        out.y = convertDepth(textureLoad(srcDepth, texel1, 0));
        out.z = convertDepth(textureLoad(srcDepth, texel2, 0));
        out.w = convertDepth(textureLoad(srcDepth, texel3, 0));
        return out;

        #endif
    }

    fn output0Level(outputPixelPos: vec2<u32>, furthestDeviceZ: f32, closestDeviceZ: f32) {

        #ifdef (DEPTH_IS_FLOAT || DEPTH_IS_FLOAT16)
            let resultFurthestDeviceZ = vec4<f32>(furthestDeviceZ, 0.0, 0.0, 1.0);
        #else
            let resultFurthestDeviceZ = float2uint(furthestDeviceZ);
        #endif

        #ifdef DIM_FURTHEST
            textureStore(dstDepth0, outputPixelPos, resultFurthestDeviceZ);
        #endif

        #ifdef DIM_FURTHEST
            // TODO
        #endif
    }

    #if DIM_MIP_LEVEL_COUNT > 1

    var<workgroup> sharedClosestDeviceZ: array<f32, GROUP_TILE_SIZE * GROUP_TILE_SIZE>;
    var<workgroup> sharedFurthestDeviceZ: array<f32, GROUP_TILE_SIZE * GROUP_TILE_SIZE>;

    fn signedRightShift(x: u32, bitshift: i32) -> u32 {
        if (bitshift > 0) {
            return x << u32(bitshift);
        }
        if (bitshift < 0) {
            return x >> u32(-bitshift);
        }
        return x;
    }

    // Returns the pixel pos [[0; N[[^2 in a two dimensional tile size of N=2^TileSizeLog2, to
    // store at a given SharedArrayId in [[0; N^2[[, so that a following recursive 2x2 pixel
    // block reduction stays entirely LDS memory banks coherent.
    fn initialTilePixelPositionForReduction2x2(tileSizeLog2: u32, sharedArrayId: u32) -> vec2<u32> {

        var x: u32 = 0u;
        var y: u32 = 0u;

        for (var i: u32 = 0u; i < tileSizeLog2; i++) {
            let destBitId = tileSizeLog2 - 1u - i;
            let destBitMask = 1u << destBitId;

            let shiftX = i32(destBitId) - i32(i * 2u + 0u);
            let shiftY = i32(destBitId) - i32(i * 2u + 1u);

            x |= destBitMask & signedRightShift(sharedArrayId, shiftX);
            y |= destBitMask & signedRightShift(sharedArrayId, shiftY);
        }

        return vec2<u32>(x, y);
    }

    fn outputMipLevel(mipLevel: u32, outputPixelPos: vec2<u32>, furthestDeviceZ: f32, closestDeviceZ: f32) {

        #ifdef (DEPTH_IS_FLOAT || DEPTH_IS_FLOAT16)
            let resultFurthestDeviceZ: vec4f = vec4f(furthestDeviceZ, 0.0, 0.0, 1.0);
        #else
            let resultFurthestDeviceZ: vec4f = float2uint(furthestDeviceZ);
        #endif

        #if DIM_MIP_LEVEL_COUNT >= 2
        if (mipLevel == 1)
        {
            #ifdef DIM_FURTHEST
                textureStore(dstDepth1, outputPixelPos, resultFurthestDeviceZ);
            #endif
            #ifdef DIM_CLOSEST
                // TODO
            #endif
        }
        #endif
        #if DIM_MIP_LEVEL_COUNT >= 3
        else if (mipLevel == 2)
        {
            #if DIM_FURTHEST
                textureStore(dstDepth2, outputPixelPos, resultFurthestDeviceZ);
            #endif
            #if DIM_CLOSEST
                // TODO
            #endif
        }
        #endif
        #if DIM_MIP_LEVEL_COUNT >= 4
        else if (mipLevel == 3)
        {
            #if DIM_FURTHEST
                textureStore(dstDepth3, outputPixelPos, resultFurthestDeviceZ);
            #endif
            #if DIM_CLOSEST
                // TODO
            #endif
        }		
        #endif
    }

    #endif

    @compute @workgroup_size(GROUP_TILE_SIZE, GROUP_TILE_SIZE, 1)
    fn main(
        #if DIM_MIP_LEVEL_COUNT == 1
        @builtin(global_invocation_id) gid: vec3u
        #else
        @builtin(workgroup_id) groupId: vec3<u32>,
        @builtin(local_invocation_index) groupThreadIndex: u32
        #endif
    ) {
        #if DIM_MIP_LEVEL_COUNT == 1

        let outputPixelPos = gid.xy;
        let size = textureDimensions(dstDepth0);
        let bufferUV = (vec2f(outputPixelPos) + 0.5)
            * uniforms.dispatchThreadIdToBufferUV.xy
            + uniforms.dispatchThreadIdToBufferUV.zw;

        if (any(outputPixelPos >= size)) {
            return;
        }

        #else

        let groupThreadId = initialTilePixelPositionForReduction2x2(MAX_MIP_BATCH_SIZE_MINUS_ONE, groupThreadIndex);
        let dispatchThreadId = GROUP_TILE_SIZE * groupId.xy + groupThreadId;
        let bufferUV = (vec2f(dispatchThreadId) + 0.5)
            * uniforms.dispatchThreadIdToBufferUV.xy
            + uniforms.dispatchThreadIdToBufferUV.zw;

        var outputPixelPos = dispatchThreadId;

        #endif

        let deviceZ = gather4(bufferUV);

        // TODO: now not support reversed z (min -> furthest, max -> closest)
        var closestDeviceZ  = minInVec(deviceZ);
        var furthestDeviceZ = maxInVec(deviceZ);

        output0Level(outputPixelPos, furthestDeviceZ, closestDeviceZ);

        #if DIM_MIP_LEVEL_COUNT == 1
            // NOP
        #else

        sharedFurthestDeviceZ[groupThreadIndex] = furthestDeviceZ;
        sharedClosestDeviceZ[groupThreadIndex] = closestDeviceZ;
        workgroupBarrier(); // await workgroup

        for (var mipLevel: u32 = 1u; mipLevel < DIM_MIP_LEVEL_COUNT; mipLevel++) {

            let tileSize = GROUP_TILE_SIZE / (1u << mipLevel);
            let reduceBankSize = tileSize * tileSize;

            if (groupThreadIndex < reduceBankSize) {

                var parentFurthestDeviceZ = vec4<f32>();
                var parentClosestDeviceZ = vec4<f32>();

                parentClosestDeviceZ[0] = sharedClosestDeviceZ[groupThreadIndex];
                parentFurthestDeviceZ[0] = sharedFurthestDeviceZ[groupThreadIndex];

                for (var i: u32 = 1u; i < 4u; i++) {
                    let ldsIdx = groupThreadIndex + i * reduceBankSize;
                    parentClosestDeviceZ[i] = sharedClosestDeviceZ[ldsIdx];
                    parentFurthestDeviceZ[i] = sharedFurthestDeviceZ[ldsIdx];
                }

                closestDeviceZ  = minInVec(parentClosestDeviceZ);
                furthestDeviceZ = maxInVec(parentFurthestDeviceZ);

                outputPixelPos = outputPixelPos >> vec2<u32>(1u, 1u);
                outputMipLevel(mipLevel, outputPixelPos, furthestDeviceZ, closestDeviceZ);

                sharedClosestDeviceZ[groupThreadIndex] = closestDeviceZ;
                sharedFurthestDeviceZ[groupThreadIndex] = furthestDeviceZ;
            }
        }

        #endif
    }
`;