export default `

    #include "indirectCoreCS"
    #include "floatAsUintPS"

    struct BoundingBox {
        center: vec3<f32>,
        halfExtents: vec3<f32>
    }

    struct IndirectMetaData {
        indexCount: u32,
        firstIndex: u32,
        baseVertex: i32,
        firstInstance: u32
    }

    struct IndirectQueueItem {
        index: u32,
        slot: u32,
        instanceCount: u32
    }

    struct DepthTest {
        instanceDepth: f32,
        hzbDepth: f32,
        result: i32,
    }

    struct Uniforms {
        boundingBoxPixelsSizePerInstance: u32,
        metaDataPixelsSizePerInstance: u32,
        viewProjection: mat4x4<f32>,
        screenSize: vec2<f32>,
        hzbSize: vec2<f32>,
        count: u32
    }

    fn getBoundingBox(itemIndex: u32) -> BoundingBox {

        let index = i32(itemIndex * uniforms.boundingBoxPixelsSizePerInstance);
        let width = i32(textureDimensions(boundingBoxes).x);

        let v = index / width;
        let u = index % width;

        var box: BoundingBox;

        box.center      = textureLoad(boundingBoxes, vec2<i32>(u + 0, v), 0).xyz;
        box.halfExtents = textureLoad(boundingBoxes, vec2<i32>(u + 1, v), 0).xyz;

        return box;
    }

    fn getIndirectMetaData(itemIndex: u32) -> IndirectMetaData {

        let index = i32(itemIndex * uniforms.metaDataPixelsSizePerInstance);
        let width = i32(textureDimensions(indirectMetaData).x);

        let v = index / width;
        let u = index % width;

        let data = textureLoad(indirectMetaData, vec2<i32>(u, v), 0);
        var indr: IndirectMetaData;

        // TODO: available for indexed
        indr.indexCount    = data.x;
        indr.firstIndex    = data.y;
        indr.baseVertex    = i32(data.z);
        indr.firstInstance = data.w;

        return indr;
    }

    fn getDepth(uv: vec2<f32>, lod: f32) -> f32 {

        // Webgpu fix uv
        let mUV: vec2<f32>  = vec2<f32>(uv.x, 1.0 - uv.y);
        let data: vec4<f32> = textureSampleLevel(hzb, hzbSampler, mUV, lod);

        #ifdef DEPTH_IS_FLOAT
            return data.r;
        #else
            return uint2float(data);
        #endif
    }

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

    fn cullBoundingBox(boundingBox: BoundingBox, viewProjection: mat4x4<f32>, screenSize: vec2<f32>, hzbSize: vec2<f32>) -> i32 {

        var boundingBoxCorners = array<vec4<f32>, 8>(
            vec4<f32>(boundingBox.center + vec3<f32>( boundingBox.halfExtents.x, boundingBox.halfExtents.y, boundingBox.halfExtents.z), 1.0),
            vec4<f32>(boundingBox.center + vec3<f32>(-boundingBox.halfExtents.x, boundingBox.halfExtents.y, boundingBox.halfExtents.z), 1.0),
            vec4<f32>(boundingBox.center + vec3<f32>( boundingBox.halfExtents.x,-boundingBox.halfExtents.y, boundingBox.halfExtents.z), 1.0),
            vec4<f32>(boundingBox.center + vec3<f32>(-boundingBox.halfExtents.x,-boundingBox.halfExtents.y, boundingBox.halfExtents.z), 1.0),
            vec4<f32>(boundingBox.center + vec3<f32>( boundingBox.halfExtents.x, boundingBox.halfExtents.y,-boundingBox.halfExtents.z), 1.0),
            vec4<f32>(boundingBox.center + vec3<f32>(-boundingBox.halfExtents.x, boundingBox.halfExtents.y,-boundingBox.halfExtents.z), 1.0),
            vec4<f32>(boundingBox.center + vec3<f32>( boundingBox.halfExtents.x,-boundingBox.halfExtents.y,-boundingBox.halfExtents.z), 1.0),
            vec4<f32>(boundingBox.center + vec3<f32>(-boundingBox.halfExtents.x,-boundingBox.halfExtents.y,-boundingBox.halfExtents.z), 1.0)
        );

        var outXPos: i32 = 0;
        var outXNeg: i32 = 0;
        var outYPos: i32 = 0;
        var outYNeg: i32 = 0;
        var outZPos: i32 = 0;
        var outZNeg: i32 = 0;

        var minCoord: vec2<f32> = vec2<f32>(10000.0);
        var maxCoord: vec2<f32> = vec2<f32>(-10000.0);
        var instanceDepth: f32 = 10000.0;

        for (var i: i32 = 0; i < 8; i = i + 1) {

            let bbc = viewProjection * boundingBoxCorners[i];

            outXPos = outXPos + select(0, 1, bbc.x >  bbc.w);
            outXNeg = outXNeg + select(0, 1, bbc.x < -bbc.w);
            outYPos = outYPos + select(0, 1, bbc.y >  bbc.w);
            outYNeg = outYNeg + select(0, 1, bbc.y < -bbc.w);
            outZPos = outZPos + select(0, 1, bbc.z >  bbc.w);
            outZNeg = outZNeg + select(0, 1, bbc.z < -bbc.w);

            let ndc: vec3<f32> = bbc.xyz / bbc.w;
            minCoord = min(minCoord, ndc.xy);
            maxCoord = max(maxCoord, ndc.xy);
            instanceDepth = min(instanceDepth, ndc.z);
        }

        let intersectsScreenX = (maxCoord.x >= -1.0 && minCoord.x <= 1.0);
        let intersectsScreenY = (maxCoord.y >= -1.0 && minCoord.y <= 1.0);

        if (!intersectsScreenX || !intersectsScreenY) {
            return 4;
        }

        var outsidePlanes: i32 =
            select(0, 1, outXPos > 0 || outXNeg > 0) +
            select(0, 1, outYPos > 0 || outYNeg > 0) +
            select(0, 1, outZPos > 0 || outZNeg > 0);

        if (outsidePlanes == 3) {
            return 3;
        }

        if (outXPos == 8 || outXNeg == 8 ||
            outYPos == 8 || outYNeg == 8 ||
            outZPos == 8 || outZNeg == 8) {
            return 2;
        }

        let clampedMinCoord: vec2<f32> = clamp(minCoord * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0));
        let clampedMaxCoord: vec2<f32> = clamp(maxCoord * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0));

        let hzbInstanceDepth = getRectDepth(clampedMinCoord, clampedMaxCoord, screenSize, hzbSize);

        return select(1, 0, instanceDepth > hzbInstanceDepth);
    }

    @group(0) @binding(0) var<uniform> uniforms: Uniforms;
    @group(0) @binding(1) var hzb: texture_2d<f32>;
    @group(0) @binding(2) var hzbSampler: sampler;
    @group(0) @binding(3) var boundingBoxes: texture_2d<f32>;
    @group(0) @binding(4) var indirectMetaData: texture_2d<u32>;
    @group(0) @binding(5) var<storage, read> indirectDrawQueueBuffer: array<IndirectQueueItem>;
    @group(0) @binding(6) var<storage, read_write> indirectDrawBuffer: array<DrawIndexedIndirectArgs>;

    @compute @workgroup_size({WORKGROUP_SIZE_X}, {WORKGROUP_SIZE_Y}, 1)
    fn main(@builtin(global_invocation_id) gid: vec3u) {

        let index = gid.x;

        if (index < uniforms.count) {

            let queueItem    = indirectDrawQueueBuffer[index];
            let boundingBox  = getBoundingBox(queueItem.index);
            let indirectMeta = getIndirectMetaData(queueItem.index);
            let cullResult   = cullBoundingBox(boundingBox, uniforms.viewProjection, uniforms.screenSize, uniforms.hzbSize);

            let instanceCount = select(queueItem.instanceCount, 0u, cullResult == 0);

            indirectDrawBuffer[queueItem.slot].indexCount    = indirectMeta.indexCount;
            indirectDrawBuffer[queueItem.slot].instanceCount = instanceCount;
            indirectDrawBuffer[queueItem.slot].firstIndex    = indirectMeta.firstIndex;
            indirectDrawBuffer[queueItem.slot].baseVertex    = indirectMeta.baseVertex;
            indirectDrawBuffer[queueItem.slot].firstInstance = indirectMeta.firstInstance;
        }
    }
`;