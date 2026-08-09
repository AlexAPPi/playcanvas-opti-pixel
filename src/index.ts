import { BVH } from "./BVH/BVH.js";
import { HybridBuilder } from "./BVH/HybridBuilder.js";
import { BitSet, IReadonlyBitSet } from "./Extras/BitSet.js";
import { ValueSortQueue } from "./Extras/ValueSortQueue.js";
import { GPUBufferTool } from "./Extras/GPUBufferTool.js";
import { GPUElementQueue } from "./Extras/GPUElementQueue.js";
import { GPUIndexQueue } from "./Extras/GPUIndexQueue.js";
import { IndexManager } from "./Extras/IndexManager.js";
import { IndexQueue } from "./Extras/IndexQueue.js";
import { IndexQueueEx } from "./Extras/IndexQueueEx.js";
import { NumberQueue } from "./Extras/NumberQueue.js";
import { Random } from "./Extras/Random.js";
import { getPixelFormatByArrayType, getSquareTextureSize, SquareDataTexture } from "./Extras/SquareDataTexture.js";
import { SquareDataTextureArray } from "./Extras/SquareDataTextureArray.js";
import { SquareDataTextureLayerProxy } from "./Extras/SquareDataTextureLayerProxy.js";
import {
    ColorDataTexture,
    ColorDataTextureArray,
    ColorDataTextureLayerProxy,
} from "./Extras/ColorDataTexture.js";
import {
    Mat4DataTexture,
    Mat4DataTextureArray,
    Mat4DataTextureLayerProxy,
} from "./Extras/Mat4DataTexture.js";
import {
    Vec4F32DataTextureArray,
    Vec4F32DataTextureLayerProxy,
    Vec4F32Texture
} from "./Extras/Vec4F32DataTexture.js";
import { HierarchicalInstancer } from "./Instancer/HierarchicalInstancer.js";
import { HierarchicalZBufferDebugger } from "./OcclusionCulling/HZB/HierarchicalZBufferDebugger.js";
import { IHierarchicalZBufferTester } from "./OcclusionCulling/HZB/IHierarchicalZBufferTester.js";
import { WebgpuHZBTester } from "./OcclusionCulling/HZB/Webgpu/WebgpuHZBTester.js";
import { FRUSTUM_CONTAINED, FRUSTUM_INTERSECTS, FRUSTUM_OUTSIDE, FRUSTUM_UNKNOWN,
    IGPU2CPUReadbackOcclusionCullingTester, IGPUIndirectDrawOcclusionCullingTester, IOcclusionCullingTester,
    IPrimitive,
    isGPU2CPUReadbackOcclusionCullingTester, isGPUIndirectDrawOcclusionCullingTester, isGPUOcclusionCullingTester,
    OCCLUSION_OCCLUDED, OCCLUSION_UNKNOWN, OCCLUSION_VISIBLE
} from "./OcclusionCulling/IOcclusionCullingTester.js";
import { OcclusionCullingSystem } from "./OcclusionCulling/OcclusionCullingSystem.js";
import { BoxMesh } from "./OcclusionCulling/Queries/BoxMesh.js";
import { OCCLUSION_ALGORITHM_TYPE_ACCURATE, OCCLUSION_ALGORITHM_TYPE_CONSERVATIVE } from "./OcclusionCulling/Queries/Types.js";
import { WebglFrameOcclusionQueries } from "./OcclusionCulling/Queries/Webgl/WebglFrameOcclusionQueries.js";
import { WebglOcclusionBoxMesh } from "./OcclusionCulling/Queries/Webgl/WebglOcclusionBoxMesh.js";
import { WebglOcclusionQueriesTester } from "./OcclusionCulling/Queries/Webgl/WebglOcclusionQueriesTester.js";
import { WebglQueryScope } from "./OcclusionCulling/Queries/Webgl/WebglQueryScope.js";
import { IHierarchicalZBuffer } from "./OcclusionCulling/HZB/IHierarchicalZBuffer.js";
import { WebglHierarchicalZBuffer } from "./OcclusionCulling/HZB/Webgl/WebglHierarchicalZBuffer.js";
import { WebgpuHierarchicalZBuffer } from "./OcclusionCulling/HZB/Webgpu/WebgpuHierarchicalZBuffer.js";
import { WebglHZBCPUFBTester } from "./OcclusionCulling/HZB/Webgl/WebglHZBCPUFBTester.js";
import { AABBStore } from "./Extras/AABBStore.js";
import { IAABBStore } from "./Extras/IAABBStore.js";
import { FadeTimeLODState } from "./Instancer/FadeTimeLODState.js";
import { FadeDistanceLODState } from "./Instancer/FadeDistanceLODState.js";
import { BasicHierarchicalInstancer, type IBasicHierarchicalInstancerParams } from "./Instancer/BasicHierarchicalInstancer.js";
import { BasicArrayHierarchicalInstancer, type IBasicArrayHierarchicalInstancerParams } from "./Instancer/BasicArrayHierarchicalInstancer.js";
import { BasicArrayHierarchicalInstancerLayer } from "./Instancer/BasicArrayHierarchicalInstancerLayer.js";
import { SimpleHierarchicalInstancer } from "./Instancer/SimpleHierarchicalInstancer.js";
import { InstancesFlags } from "./Instancer/InstancesFlags.js";
import { radixSort } from "./Extras/RadixSort.js";
import { ILODRender } from "./Instancer/ILODRender.js";
import { ILODLevel } from "./Instancer/ILODLevel.js";
import { IInstancerShaderChunkMap, IInstancerShaderChunkMapScope, IInstancerShaderDefaultChunkMapScope } from "./Instancer/InstancerShaderChunks.js";

export {

    FRUSTUM_UNKNOWN,
    FRUSTUM_OUTSIDE,
    FRUSTUM_INTERSECTS,
    FRUSTUM_CONTAINED,

    OCCLUSION_UNKNOWN,
    OCCLUSION_VISIBLE,
    OCCLUSION_OCCLUDED,
    OCCLUSION_ALGORITHM_TYPE_CONSERVATIVE,
    OCCLUSION_ALGORITHM_TYPE_ACCURATE,

    radixSort,

    AABBStore,

    BitSet,
    GPUBufferTool,
    GPUElementQueue,
    GPUIndexQueue,
    ValueSortQueue,
    IndexManager,
    IndexQueue,
    IndexQueueEx,
    NumberQueue,
    Random,

    SquareDataTexture,
    SquareDataTextureArray,
    SquareDataTextureLayerProxy,
    Mat4DataTexture,
    Mat4DataTextureArray,
    Mat4DataTextureLayerProxy,
    ColorDataTexture,
    ColorDataTextureArray,
    ColorDataTextureLayerProxy,
    Vec4F32Texture,
    Vec4F32DataTextureArray,
    Vec4F32DataTextureLayerProxy,
    getSquareTextureSize,
    getPixelFormatByArrayType,

    BoxMesh,

    WebglFrameOcclusionQueries,
    WebglOcclusionBoxMesh,
    WebglOcclusionQueriesTester,
    WebglQueryScope,
    isGPUOcclusionCullingTester,
    isGPU2CPUReadbackOcclusionCullingTester,
    isGPUIndirectDrawOcclusionCullingTester,

    WebglHierarchicalZBuffer,
    WebgpuHierarchicalZBuffer,

    WebglHZBCPUFBTester,
    WebgpuHZBTester,

    OcclusionCullingSystem,
    HierarchicalZBufferDebugger,

    BVH,
    HybridBuilder,

    InstancesFlags,
    FadeTimeLODState,
    FadeDistanceLODState,

    HierarchicalInstancer,
    BasicHierarchicalInstancer,
    BasicArrayHierarchicalInstancer,
    BasicArrayHierarchicalInstancerLayer,
    SimpleHierarchicalInstancer,
};

export type {
    ILODLevel,
    ILODRender,
    IReadonlyBitSet,
    IPrimitive,
    IAABBStore,
    IHierarchicalZBuffer,
    IOcclusionCullingTester,
    IHierarchicalZBufferTester,
    IGPU2CPUReadbackOcclusionCullingTester,
    IGPUIndirectDrawOcclusionCullingTester,
    IBasicHierarchicalInstancerParams,
    IBasicArrayHierarchicalInstancerParams,
    IInstancerShaderChunkMap,
    IInstancerShaderChunkMapScope
};
