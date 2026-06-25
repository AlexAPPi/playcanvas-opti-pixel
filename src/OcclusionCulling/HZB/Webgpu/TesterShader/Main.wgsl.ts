export default `

    struct Uniforms {
        nonIndexedSign: i32,
        cameraPosition: vec3<f32>,
        viewProjection: mat4x4<f32>,
        hzbUvFactor: vec2<f32>,
        screenSize: vec2<f32>,
        hzbSize: vec2<f32>,
        count: u32
    }

    struct IndirectQueueItem {
        index: u32,
        slot: u32
    }

    struct IndirectData {
        indexOrVertexCount: u32,
        instanceCount: u32,
        firstIndexOrVertex: u32,
        baseVertexOrNonIndexedSign: i32,
        firstInstance: u32
    }

    struct DrawIndirectFlexArgs {
        indexOrVertexCount: u32,
        instanceCount: u32,
        firstIndexOrVertex: u32,
        indexedBaseVertexOrFirstInstance: i32,
        indexedFirstInstanceOrPad: u32
    }

    #include "indirectCoreCS"
    #include "getBoundingBoxCS"
    #include "cullBoundingBoxCS"

    @group(0) @binding(0) var<uniform> uniforms: Uniforms;
    @group(0) @binding(1) var hzb: texture_2d<{DEPTH_STORAGE_FORMAT}>;
    @group(0) @binding(2) var hzbSampler: sampler;
    @group(0) @binding(3) var boundingBoxCenters: texture_2d<f32>;
    @group(0) @binding(4) var boundingBoxHalfExtents: texture_2d<f32>;
    @group(0) @binding(5) var<storage, read> indirectDataBuffer: array<IndirectData>;
    @group(0) @binding(6) var<storage, read> indirectDrawQueueBuffer: array<IndirectQueueItem>;
    @group(0) @binding(7) var<storage, read_write> indirectDrawBuffer: array<DrawIndirectFlexArgs>;

    @compute @workgroup_size({WORKGROUP_SIZE_X}, 1, 1)
    fn main(@builtin(global_invocation_id) gid: vec3u) {

        let index = gid.x;

        if (index < uniforms.count) {

            let queueItem    = indirectDrawQueueBuffer[index];
            let indirectData = indirectDataBuffer[queueItem.index];
            let boundingBox  = getBoundingBox(queueItem.index);
            let cullResult   = cullBoundingBox(boundingBox);

            let slot = queueItem.slot;
            let instanceCount = select(indirectData.instanceCount, 0u, cullResult == 0);

            // TODO: Consider other logics for separating buffers
            if (indirectData.baseVertexOrNonIndexedSign == uniforms.nonIndexedSign) {
                indirectDrawBuffer[slot].indexOrVertexCount = indirectData.indexOrVertexCount;
                indirectDrawBuffer[slot].instanceCount = instanceCount;
                indirectDrawBuffer[slot].firstIndexOrVertex = indirectData.firstIndexOrVertex;
                indirectDrawBuffer[slot].indexedBaseVertexOrFirstInstance = bitcast<i32>(indirectData.firstInstance);
                // ignore pad
            }
            else {
                indirectDrawBuffer[slot].indexOrVertexCount = indirectData.indexOrVertexCount;
                indirectDrawBuffer[slot].instanceCount = instanceCount;
                indirectDrawBuffer[slot].firstIndexOrVertex = indirectData.firstIndexOrVertex;
                indirectDrawBuffer[slot].indexedBaseVertexOrFirstInstance = indirectData.baseVertexOrNonIndexedSign;
                indirectDrawBuffer[slot].indexedFirstInstanceOrPad = indirectData.firstInstance;
            }
        }
    }
`;