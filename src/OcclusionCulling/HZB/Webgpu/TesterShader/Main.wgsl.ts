export default `

    struct Uniforms {
        boundingBoxPixelsSizePerInstance: u32,
        metaDataPixelsSizePerInstance: u32,
        viewProjection: mat4x4<f32>,
        screenSize: vec2<f32>,
        hzbSize: vec2<f32>,
        count: u32
    }

    struct IndirectQueueItem {
        index: u32,
        slot: u32,
        instanceCount: u32
    }

    #include "indirectCoreCS"
    #include "getIndirectMetaCS"
    #include "getBoundingBoxCS"
    #include "cullBoundingBoxCS"

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
            let indirectMeta = getIndirectMetaData(queueItem.index);
            let boundingBox  = getBoundingBox(queueItem.index);
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