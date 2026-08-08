// GLSL VS
import GLSLInstancerInstanceVS from "./ShaderChunks/Vert/GLSL/instance.js";
import GLSLInstancerInstanceAttrVS from "./ShaderChunks/Vert/GLSL/instanceAttr.js";
import GLSLInstancerInstanceIdVS from "./ShaderChunks/Vert/GLSL/instanceId.js";
import GLSLInstancerInstanceLayerVS from "./ShaderChunks/Vert/GLSL/instanceLayer.js";
import GLSLInstancerInstaceCrossFadeVS from "./ShaderChunks/Vert/GLSL/instanceCrossFade.js";
import GLSLInstancerInstanceMatrixVS from "./ShaderChunks/Vert/GLSL/instanceMatrix.js";
import GLSLInstancerInstanceColorVS from "./ShaderChunks/Vert/GLSL/instanceColor.js";
import GLSLTransformInstancingVS from "./ShaderChunks/Vert/GLSL/transformInstancing.js";
import GLSLInstancerDeclarationVS from "./ShaderChunks/Vert/GLSL/instancerDeclaration.js";
import GLSLInstancerMainEndVS from "./ShaderChunks/Vert/GLSL/instancerMainEnd.js";

// WGSL VS
import WGSLInstancerInstanceVS from "./ShaderChunks/Vert/WGSL/instance.js";
import WGSLInstancerInstanceAttrVS from "./ShaderChunks/Vert/WGSL/instanceAttr.js";
import WGSLInstancerInstanceIdVS from "./ShaderChunks/Vert/WGSL/instanceId.js";
import WGSLInstancerInstanceLayerVS from "./ShaderChunks/Vert/WGSL/instanceLayer.js";
import WGSLInstancerInstaceCrossFadeVS from "./ShaderChunks/Vert/WGSL/instanceCrossFade.js";
import WGSLInstancerInstanceMatrixVS from "./ShaderChunks/Vert/WGSL/instanceMatrix.js";
import WGSLInstancerInstanceColorVS from "./ShaderChunks/Vert/WGSL/instanceColor.js";
import WGSLTransformInstancingVS from "./ShaderChunks/Vert/WGSL/transformInstancing.js";
import WGSLInstancerDeclarationVS from "./ShaderChunks/Vert/WGSL/instancerDeclaration.js";
import WGSLInstancerMainEndVS from "./ShaderChunks/Vert/WGSL/instancerMainEnd.js";

// GLSL PS
import GLSLInstancerDeclarationPS from "./ShaderChunks/Frag/GLSL/instancerDeclaration.js";
import GLSLInstancerMainStartPS from "./ShaderChunks/Frag/GLSL/instancerMainStart.js";
import GLSLInstancerDiffusePS from "./ShaderChunks/Frag/GLSL/diffuse.js";
import GLSLInstancerOpacityPS from "./ShaderChunks/Frag/GLSL/opacity.js";

// WGSL PS
import WGSLInstancerDeclarationPS from "./ShaderChunks/Frag/WGSL/instancerDeclaration.js";
import WGSLInstancerMainStartPS from "./ShaderChunks/Frag/WGSL/instancerMainStart.js";
import WGSLInstancerDiffusePS from "./ShaderChunks/Frag/WGSL/diffuse.js";
import WGSLInstancerOpacityPS from "./ShaderChunks/Frag/WGSL/opacity.js";

export interface IInstancerShaderChunkMap {
    instancerInstanceVS: string;
    instancerInstanceAttrVS: string;
    instancerInstanceIdVS: string;
    instancerInstanceLayerVS: string;
    instancerInstaceCrossFadeVS: string;
    instancerInstanceMatrixVS: string;
    instancerInstanceColorVS: string;
    transformInstancingVS: string;
    instancerDeclarationVS: string;
    instancerMainEndVS: string;
    instancerDeclarationPS: string;
    instancerMainStartPS: string;
    instancerDiffusePS: string;
    instancerOpacityPS: string;
}

export interface IInstancerShaderChunkMapScope {
    glsl?: Partial<IInstancerShaderChunkMap>;
    wgsl?: Partial<IInstancerShaderChunkMap>;
}

export interface IInstancerShaderDefaultChunkMapScope {
    glsl: Readonly<IInstancerShaderChunkMap>;
    wgsl: Readonly<IInstancerShaderChunkMap>;
}

export const defaultShaderChunksMapScope: IInstancerShaderDefaultChunkMapScope = {
    glsl: {
        instancerInstanceVS: GLSLInstancerInstanceVS,
        instancerInstanceAttrVS: GLSLInstancerInstanceAttrVS,
        instancerInstanceIdVS: GLSLInstancerInstanceIdVS,
        instancerInstanceLayerVS: GLSLInstancerInstanceLayerVS,
        instancerInstaceCrossFadeVS: GLSLInstancerInstaceCrossFadeVS,
        instancerInstanceMatrixVS: GLSLInstancerInstanceMatrixVS,
        instancerInstanceColorVS: GLSLInstancerInstanceColorVS,
        transformInstancingVS: GLSLTransformInstancingVS,
        instancerDeclarationVS: GLSLInstancerDeclarationVS,
        instancerMainEndVS: GLSLInstancerMainEndVS,
        instancerDeclarationPS: GLSLInstancerDeclarationPS,
        instancerMainStartPS: GLSLInstancerMainStartPS,
        instancerDiffusePS: GLSLInstancerDiffusePS,
        instancerOpacityPS: GLSLInstancerOpacityPS,
    },
    wgsl: {
        instancerInstanceVS: WGSLInstancerInstanceVS,
        instancerInstanceAttrVS: WGSLInstancerInstanceAttrVS,
        instancerInstanceIdVS: WGSLInstancerInstanceIdVS,
        instancerInstanceLayerVS: WGSLInstancerInstanceLayerVS,
        instancerInstaceCrossFadeVS: WGSLInstancerInstaceCrossFadeVS,
        instancerInstanceMatrixVS: WGSLInstancerInstanceMatrixVS,
        instancerInstanceColorVS: WGSLInstancerInstanceColorVS,
        transformInstancingVS: WGSLTransformInstancingVS,
        instancerDeclarationVS: WGSLInstancerDeclarationVS,
        instancerMainEndVS: WGSLInstancerMainEndVS,
        instancerDeclarationPS: WGSLInstancerDeclarationPS,
        instancerMainStartPS: WGSLInstancerMainStartPS,
        instancerDiffusePS: WGSLInstancerDiffusePS,
        instancerOpacityPS: WGSLInstancerOpacityPS,
    }
};
