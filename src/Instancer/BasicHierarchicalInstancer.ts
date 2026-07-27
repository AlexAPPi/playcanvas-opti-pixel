// GLSL VS
import GLSLInstancerInstanceVS from "./ShaderChunks/Vert/GLSL/instance.js";
import GLSLInstancerInstanceIdVS from "./ShaderChunks/Vert/GLSL/instanceId.js";
import GLSLInstancerInstaceCrossFadeVS from "./ShaderChunks/Vert/GLSL/instanceCrossFade.js";
import GLSLInstancerInstanceMatrixVS from "./ShaderChunks/Vert/GLSL/instanceMatrix.js";
import GLSLInstancerInstanceColorVS from "./ShaderChunks/Vert/GLSL/instanceColor.js";
import GLSLTransformInstancingVS from "./ShaderChunks/Vert/GLSL/transformInstancing.js";
import GLSLInstancerDeclarationVS from "./ShaderChunks/Vert/GLSL/instancerDeclaration.js";
import GLSLInstancerMainEndVS from "./ShaderChunks/Vert/GLSL/instancerMainEnd.js";

// WGSL VS
import WGSLInstancerInstanceVS from "./ShaderChunks/Vert/WGSL/instance.js";
import WGSLInstancerInstanceIdVS from "./ShaderChunks/Vert/WGSL/instanceId.js";
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

import pc from "../engine.js";
import { SquareDataTexture } from "../Extras/SquareDataTexture.js";
import { IInstancer } from "./IInstancer.js";
import { ILODLevel } from "./ILODLevel.js";
import { GPUInstancedList, instancingIndexSemantic as instancingInstanceSemantic } from "./InstancedList.js";
import { LODRender } from "./LODRender.js";
import { ILODRender } from "./ILODRender.js";

export interface IInstancerShaderChunks {
    instancerInstanceVS: string;
    instancerInstanceIdVS: string;
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

export interface IInstancerShaderChunksScope {
    glsl?: Partial<IInstancerShaderChunks>;
    wgsl?: Partial<IInstancerShaderChunks>;
}

/**
 * Parameters for configuring an `BasicHierarchicalInstancer` instance.
 */
export interface IBasicHierarchicalInstancerParams {

    /**
     * Determines the maximum number of instances that buffers can hold.
     * The buffers will be expanded automatically if necessary.
     * @default 1000
     */
    capacity?: number;
}

export class BasicHierarchicalInstancer implements IInstancer {

    /** @internal */ _sortObjects = false;
    /** @internal */ _useOpacity = false;

    protected _time: number = 0;

    protected _maxInstanceBoundingBox: pc.BoundingBox = new pc.BoundingBox();
    protected _instanceAABBCenter: pc.Vec3 = new pc.Vec3();
    protected _instanceAABBRadius: number = 0;

    protected _needUpdateMaterials: boolean = true;
    protected _sortObjectsInStep: boolean = false;
    protected _capacity: number;

    // Need for sort
    protected _sharedDepthStore: Float32Array | null;
    protected _sharedDepthStoreU: Uint32Array | null;
    protected _sharedIndexes: Uint32Array | null;

    /**
     * Instanced mesh graphics device
     */
    public readonly device: pc.GraphicsDevice;

    /**
     * LODs
     */
    public LODs: ILODLevel[] = [];

    /**
     * Texture storing matrices for instances.
     */
    public matricesTexture: SquareDataTexture<Float32Array>;

    /**
     * Texture storing colors for instances.
     */
    public colorsTexture: SquareDataTexture<Uint8Array> = null!;

    /**
     * The capacity of the instance buffers.
     */
    public get capacity(): number { return this._capacity; }

    public constructor(device: pc.GraphicsDevice, params: IBasicHierarchicalInstancerParams = {}) {

        const { capacity = _defaultCapacity } = params;

        this.device = device;

        this._capacity = capacity;
        this._initMatricesTexture();
    }

    protected _disposeSorter(): void {
        this._sharedIndexes = null;
        this._sharedDepthStore = null;
        this._sharedDepthStoreU = null;
        this._sortObjects = false;
    }

    protected _initOrUpdateSorter(): void {

        const capacity = this.capacity;

        // Need for sort by depth
        if (!this._sharedDepthStore ||
            this._sharedDepthStore.length !== capacity) {
            this._sharedDepthStore = new Float32Array(capacity);
            this._sharedDepthStoreU = new Uint32Array(this._sharedDepthStore.buffer);
        }

        if (!this._sharedIndexes ||
            this._sharedIndexes.length !== capacity) {
            this._sharedIndexes = new Uint32Array(capacity);
        }

        this._sortObjects = true;
    }

    protected _initOrDisposeSorterIfNeed(lods: ILODLevel[]) {

        let needSorter = false;
        for (let index = 0; index < lods.length; index++) {
            needSorter ||= !!lods[index].render?.sortObjects;
            if (needSorter) {
                break;
            }
        }

        if (needSorter) this._initOrUpdateSorter(); 
        else            this._disposeSorter();
    }

    protected _initMatricesTexture(): void {
        this.matricesTexture?.destroy();
        this.matricesTexture = new SquareDataTexture(this.device, {
            arrayConstructor: Float32Array,
            channels: 4,
            pixelsPerInstance: 4,
            capacity: this.capacity
        });
        this._needUpdateMaterials = true;
    }

    protected _initColorsTexture(): void {
        this.colorsTexture?.destroy();
        this.colorsTexture = new SquareDataTexture(this.device, {
            arrayConstructor: Uint8Array,
            channels: 4,
            pixelsPerInstance: 1,
            capacity: this.capacity,
            pixelFormat: pc.PIXELFORMAT_RGBA8,
            defaultPixelValue: 255
        });
        this._needUpdateMaterials = true;
    }

    protected _resizeRenders(): void {
        const levels = this.LODs;
        const numLevels = levels.length;
        for (let levelIndex = 0; levelIndex < numLevels; levelIndex++) {
            const level  = levels[levelIndex];
            const render = level.render;
            if (render) {
                render.resize(this.capacity);
            }
        }
    }

    public applySortingIfNeeded(): void {
        this._initOrDisposeSorterIfNeed(this.LODs);        
    }

    public resize(newCapacity: number) {

        if (this._capacity === newCapacity) {
            return;
        }

        this._capacity = newCapacity;
        this.matricesTexture?.resize(newCapacity);
        this.colorsTexture?.resize(newCapacity);

        // Resize renders
        this._resizeRenders();

        // Resize sorter if need
        this._initOrDisposeSorterIfNeed(this.LODs);
    }

    public computeMaxInstanceBoundingBox(src?: pc.BoundingBox): pc.BoundingBox {

        const levels = this.LODs;

        if (levels.length < 1) {
            throw new Error("Lods empty");
        }

        for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
            const aabb = levels[levelIdx].render?.computeMaxMeshBoundingBox();
            if (aabb) {
                src ??= aabb;
                src.add(aabb);
            }
        }

        if (!src) {
            throw new Error("Failed to compute the bounding box for the mesh.");
        }

        return src;
    }

    public addLOD(meshInstanceList: pc.MeshInstance[] | null, root: pc.Entity | null, distance: number = 0, hysteresis: number = 0): number {
        const levelIndex = this._addLevel(this.LODs, meshInstanceList, root, distance, hysteresis);
        this._initOrDisposeSorterIfNeed(this.LODs);
        this.updateInstanceBoundingBox();
        return levelIndex;
    }

    public updateLOD(levelIndex: number, distance: number, hysteresis: number) {

        if (levelIndex === 0 && distance !== 0) {
            console.warn("Cannot change distance for LOD0. It is the main mesh and must stay at 0."); // If user try to change first lod
            return;
        }

        return this._updateLevel(this.LODs, levelIndex, distance, hysteresis);
    }

    public removeLOD(levelIndex: number, destroyObject: boolean = true) {
        const removed = this._removeLevel(this.LODs, levelIndex, destroyObject);
        this.updateInstanceBoundingBox();
        return removed;
    }

    protected _createRender(meshInstanceList: pc.MeshInstance[], root: pc.Entity | null): ILODRender {
        const instancedList = new GPUInstancedList(this.device, this.capacity);
        const render = new LODRender(instancedList, meshInstanceList, root);
        this._patchMeshInstancesMaterials(meshInstanceList);
        return render;
    }

    protected _addLevel(lods: ILODLevel[], meshInstanceList: pc.MeshInstance[] | null, root: pc.Entity | null, distance: number, hysteresis: number): number {

        // to avoid to use Math.sqrt every time
        distance = distance ** 2;

        let index: number;

        for (index = 0; index < lods.length; index++) {
            if (distance < lods[index].distance) break;
        }

        let render: ILODRender | undefined;

        if (meshInstanceList && meshInstanceList.length > 0) {
            render = this._createRender(meshInstanceList, root);
        }

        lods.splice(index, 0, {
            distance,
            hysteresis,
            render
        });

        return index;
    }

    protected _updateLevel(lods: ILODLevel[], levelIndex: number, distance: number | null = null, hysteresis: number | null = null) {

        const level = lods[levelIndex];
        if (!level) throw new Error("Cannot update an empty LOD.");

        if (distance != null && !Number.isNaN(distance)) {
            const d2 = distance ** 2;
            level.distance = d2;
        }

        if (hysteresis != null && !Number.isNaN(hysteresis)) {
            level.hysteresis = hysteresis;
        }
    }

    protected _removeLevel(lods: ILODLevel[], levelIndex: number, destroyObject: boolean = true) {

        const n = lods.length;

        if (levelIndex < 0 || levelIndex >= n) throw new Error("Level index OOB");
        if (n > 1 && levelIndex === 0) throw new Error("Cannot remove LOD0 while others exist");

        const removedArr = lods.splice(levelIndex, 1);
        const removedObj = removedArr[0];

        if (destroyObject) {
            const render = removedObj.render;
            if (render) {
                render.destroy();
            }
        }

        return removedObj;
    }

    protected _patchMeshInstancesMaterials(meshInstanceList: pc.MeshInstance[]) {
        const numMeshes = meshInstanceList.length;
        for (let i = 0; i < numMeshes; i++) {
            const mesh = meshInstanceList[i];
            const material = mesh.material;
            if (material instanceof pc.StandardMaterial) {
                this._patchMaterial(material);
                mesh.material = material;
            }
        }
    }

    public updateMaterials() {

        const levels = this.LODs;
        const numLevels = levels.length;
        for (let levelIndex = 0; levelIndex < numLevels; levelIndex++) {
            const level  = levels[levelIndex];
            const render = level.render;
            if (render) {
                this._patchMeshInstancesMaterials(render.meshes);
            }
        }

        this._needUpdateMaterials = false;
    }

    public updateInstanceBoundingBox() {
        this.computeMaxInstanceBoundingBox(this._maxInstanceBoundingBox);
        this._instanceAABBCenter.copy(this._maxInstanceBoundingBox.center);
        this._instanceAABBRadius = this._maxInstanceBoundingBox.halfExtents.length();
    }

    protected _setMaterialParamsAndDefine(material: pc.StandardMaterial) {

        material.setParameter("uInstancerMatricesTexture", this.matricesTexture.texture);
        material.setParameter("uInstancerLocalInstanceMatrix", pc.Mat4.IDENTITY.data);

        material.setDefine("INSTANCER_USE_CROSSFADE", true);

        if (this.colorsTexture) {
            material.setDefine("INSTANCER_USE_CUSTOM_COLOR", true);
            material.setDefine("INSTANCER_USE_CUSTOM_OPACITY", this._useOpacity);
            material.setParameter("uInstancerColorTexture", this.colorsTexture.texture);
        }
        else {
            material.setDefine("INSTANCER_USE_CUSTOM_COLOR", false);
            material.setDefine("INSTANCER_USE_CUSTOM_OPACITY", false);
            material.deleteParameter("uInstancerColorTexture");
        }
    }

    protected _setMaterialAttributes(material: pc.StandardMaterial) {
        material.setAttribute("aInstancerInstance", instancingInstanceSemantic);
    }

    protected _replaceMaterialShaderChunks(shaderChunkMap: ReturnType<pc.Material["getShaderChunks"]>, chunks: IInstancerShaderChunks) {

        // Restore original user shader chunk code

        // VS
        let originalLitUserDeclarationVS = shaderChunkMap.get("litUserDeclarationVS") ?? "/**/";
        if (originalLitUserDeclarationVS === chunks.instancerDeclarationVS) {
            originalLitUserDeclarationVS = shaderChunkMap.get("instancerUserDeclarationVS") ?? "/**/";
        }

        let originalLitUserMainEndVS = shaderChunkMap.get("litUserMainEndVS") ?? "/**/";
        if (originalLitUserMainEndVS === chunks.instancerMainEndVS) {
            originalLitUserMainEndVS = shaderChunkMap.get("instancerUserMainEndVS") ?? "/**/";
        }

        // PS
        let originalLitUserDeclarationPS = shaderChunkMap.get("litUserDeclarationPS") ?? "/**/";
        if (originalLitUserDeclarationPS === chunks.instancerDeclarationPS) {
            originalLitUserDeclarationPS = shaderChunkMap.get("instancerUserDeclarationPS") ?? "/**/";
        }

        let originalLitUserStartMainPS = shaderChunkMap.get("litUserMainStartPS") ?? "/**/";
        if (originalLitUserStartMainPS === chunks.instancerMainStartPS) {
            originalLitUserStartMainPS = shaderChunkMap.get("instancerUserMainStartPS") ?? "/**/";
        }

        shaderChunkMap
            // Lit shader VS
            .set("transformInstancingVS", chunks.transformInstancingVS)
            .set("litUserDeclarationVS", chunks.instancerDeclarationVS)
            .set("litUserMainEndVS", chunks.instancerMainEndVS)

            // Lit shader PS
            .set("litUserDeclarationPS", chunks.instancerDeclarationPS)
            .set("litUserMainStartPS", chunks.instancerMainStartPS)
            .set("diffusePS", chunks.instancerDiffusePS)
            .set("opacityPS", chunks.instancerOpacityPS)

            // Instancer
            .set("instancerInstanceVS", chunks.instancerInstanceVS)
            .set("instancerInstanceIdVS", chunks.instancerInstanceIdVS)
            .set("instancerInstanceCrossFadeVS", chunks.instancerInstaceCrossFadeVS)
            .set("instancerInstanceMatrixVS", chunks.instancerInstanceMatrixVS)
            .set("instancerInstanceColorVS", chunks.instancerInstanceColorVS)

            // Instancer user VS
            .set("instancerUserDeclarationVS", originalLitUserDeclarationVS)
            .set("instancerUserMainEndVS", originalLitUserMainEndVS)

            // Instancer user PS
            .set("instancerUserDeclarationPS", originalLitUserDeclarationPS)
            .set("instancerUserMainStartPS", originalLitUserStartMainPS)
        ;
    }

    protected _patchMaterial(material: pc.StandardMaterial, shaderChunksScope?: IInstancerShaderChunksScope, updateMaterial: boolean = true) {

        const glslChunks = material.getShaderChunks(pc.SHADERLANGUAGE_GLSL);
        const wgslChunks = material.getShaderChunks(pc.SHADERLANGUAGE_WGSL);

        const glslInstancerChunks = {
            instancerInstanceVS: GLSLInstancerInstanceVS,
            instancerInstanceIdVS: GLSLInstancerInstanceIdVS,
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
            ...shaderChunksScope?.glsl,
        };

        const wgslInstancerChunks = {
            instancerInstanceVS: WGSLInstancerInstanceVS,
            instancerInstanceIdVS: WGSLInstancerInstanceIdVS,
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
            ...shaderChunksScope?.wgsl,
        };

        material.shaderChunksVersion = "2.8";

        this._replaceMaterialShaderChunks(glslChunks, glslInstancerChunks);
        this._replaceMaterialShaderChunks(wgslChunks, wgslInstancerChunks);
        this._setMaterialAttributes(material);
        this._setMaterialParamsAndDefine(material);

        if (updateMaterial) {
            material.update();
        }
    }

    /**
     * Sets the local transformation matrix for a specific instance.
     * @param id The index of the instance.
     * @param matrix A `Mat4` representing the local transformation to apply to the instance.
     */
    public setMatrixAt(id: number, matrix: pc.Mat4): void {

        const inData = matrix.data;
        const outData = this.matricesTexture.data;
        const offset = id * 16;
        for (let i = 0; i < 16; i++) {
            outData[offset + i] = inData[i];
        }

        this.matricesTexture.enqueueUpdate(id);
    }

    /**
     * Gets the local transformation matrix of a specific instance.
     * @param id The index of the instance.
     * @param matrix Optional `Mat4` to store the result.
     * @returns The transformation matrix of the instance.
     */
    public getMatrixAt(id: number, matrix = _tempMat41): pc.Mat4 {
        const outData = matrix.data;
        const inData = this.matricesTexture.data;
        const offset = id * 16;
        for (let i = 0; i < 16; i++) {
            outData[i] = inData[offset + i];
        }
        return matrix;
    }

    /**
     * Retrieves the position of a specific instance.
     * @param index The index of the instance.
     * @param target Optional `Vec3` to store the result.
     * @returns The position of the instance as a `Vec3`.
     */
    public getPositionAt(index: number, target = _tempVec31): pc.Vec3 {
        const offset = index * 16;
        const array = this.matricesTexture.data;
        target.x = array[offset + 12];
        target.y = array[offset + 13];
        target.z = array[offset + 14];
        return target;
    }

    /**
     * Retrieves the position and max scale of a specific instance.
     * @param index The index of the instance.
     * @param position The position of the instance as a `Vec3` to store the result.
     * @returns The max scale
     */
    public getPositionAndMaxScaleOnAxisAt(index: number, position: pc.Vec3): number {

        const offset = index * 16;
        const array = this.matricesTexture.data;

        const te0 = array[offset + 0];
        const te1 = array[offset + 1];
        const te2 = array[offset + 2];
        const scaleXSq = te0 * te0 + te1 * te1 + te2 * te2;

        const te4 = array[offset + 4];
        const te5 = array[offset + 5];
        const te6 = array[offset + 6];
        const scaleYSq = te4 * te4 + te5 * te5 + te6 * te6;

        const te8 = array[offset + 8];
        const te9 = array[offset + 9];
        const te10 = array[offset + 10];
        const scaleZSq = te8 * te8 + te9 * te9 + te10 * te10;

        position.x = array[offset + 12];
        position.y = array[offset + 13];
        position.z = array[offset + 14];

        return Math.sqrt(Math.max(scaleXSq, scaleYSq, scaleZSq));
    }

    public applyMatrixAtToSphere(index: number, sphere: pc.BoundingSphere, center: pc.Vec3, radius: number): void {

        const offset = index * 16;
        const array = this.matricesTexture.data;

        const te0 = array[offset + 0];
        const te1 = array[offset + 1];
        const te2 = array[offset + 2];
        const te3 = array[offset + 3];
        const te4 = array[offset + 4];
        const te5 = array[offset + 5];
        const te6 = array[offset + 6];
        const te7 = array[offset + 7];
        const te8 = array[offset + 8];
        const te9 = array[offset + 9];
        const te10 = array[offset + 10];
        const te11 = array[offset + 11];
        const te12 = array[offset + 12];
        const te13 = array[offset + 13];
        const te14 = array[offset + 14];
        const te15 = array[offset + 15];

        const position = sphere.center;
        const x = center.x;
        const y = center.y;
        const z = center.z;
        const w = 1 / (te3 * x + te7 * y + te11 * z + te15);

        position.x = (te0 * x + te4 * y + te8 * z + te12) * w;
        position.y = (te1 * x + te5 * y + te9 * z + te13) * w;
        position.z = (te2 * x + te6 * y + te10 * z + te14) * w;

        const scaleXSq = te0 * te0 + te1 * te1 + te2 * te2;
        const scaleYSq = te4 * te4 + te5 * te5 + te6 * te6;
        const scaleZSq = te8 * te8 + te9 * te9 + te10 * te10;

        sphere.radius = radius * Math.sqrt(Math.max(scaleXSq, scaleYSq, scaleZSq));
    }

    /**
     * Sets the color of a specific instance.
     * @param id The index of the instance.
     * @param color The color to assign to the instance.
     */
    public setColorAt(id: number, color: pc.Color): void {

        if (this.colorsTexture === null) {
            this._initColorsTexture();
        }

        const offset = id * 4;
        const data = this.colorsTexture.data;
        data[offset    ] = Math.min(Math.max(0, color.r * 255), 255);
        data[offset + 1] = Math.min(Math.max(0, color.g * 255), 255);
        data[offset + 2] = Math.min(Math.max(0, color.b * 255), 255);
        data[offset + 3] = Math.min(Math.max(0, color.a * 255), 255);

        this.colorsTexture.enqueueUpdate(id);
    }

    /**
     * Gets the color of a specific instance.
     * @param id The index of the instance.
     * @param color Optional `Color` to store the result.
     * @returns The color of the instance.
     */
    public getColorAt(id: number, color: pc.Color = _tempCol): pc.Color {
        const offset = id * 4;
        const data = this.colorsTexture.data;
        color.r = data[offset]     / 255;
        color.g = data[offset + 1] / 255;
        color.b = data[offset + 2] / 255;
        color.a = data[offset + 3] / 255;
        return color;
    }

    /**
     * Sets the opacity of a specific instance.
     * @param id The index of the instance.
     * @param value The opacity value to assign.
     */
    public setOpacityAt(id: number, value: number): void {

        if (!this._useOpacity) {

            if (this.colorsTexture === null) {
                this._initColorsTexture();
            } else {
                this._needUpdateMaterials = true;
            }

            this._useOpacity = true;
        }

        this.colorsTexture.data[id * 4 + 3] = Math.min(Math.max(0, value * 255), 255);
        this.colorsTexture.enqueueUpdate(id);
    }

    /**
     * Gets the opacity of a specific instance.
     * @param id The index of the instance.
     * @returns The opacity of the instance.
     */
    public getOpacityAt(id: number): number {
        if (!this._useOpacity) return 1;
        return this.colorsTexture.data[id * 4 + 3] / 255;
    }

    protected _beforeUpdateRenders(dt: number) {

        this._time += dt;

        this.matricesTexture?.update();
        this.colorsTexture?.update();

        if (this._needUpdateMaterials) {
            this.updateMaterials();
        }

        const lods = this.LODs;
        const numLods = lods.length;

        let sortObjectsInStep = false;

        for (let lodIndex = 0; lodIndex < numLods; lodIndex++) {
            const render = lods[lodIndex].render;
            if (render) {
                render.start();
                sortObjectsInStep ||= render.sortObjects;
            }
        }

        this._sortObjectsInStep = sortObjectsInStep;
    }

    protected _afterUpdateRenders(dt: number) {

        const lods = this.LODs;
        const numLods = lods.length;
        const sharedIndexes = this._sharedIndexes!;
        const sharedDepthStore = this._sharedDepthStoreU!;

        for (let lodIndex = 0; lodIndex < numLods; lodIndex++) {
            const render = lods[lodIndex].render;
            if (render) {
                if (render.sortObjects) {
                    render.sort(true, sharedIndexes, sharedDepthStore);
                }
                render.end();
            }
        }
    }

    /**
     * Retrieves the index of the LOD level for a given distance.
     * @param lods The array of LODs.
     * @param distance The squared distance from the camera to the object.
     * @returns The index of the LOD that should be used.
     */
    public getObjectLODIndexForDistance(lods: ILODLevel[], distance: number): number {
        for (let i = lods.length - 1; i > 0; i--) {
            const level = lods[i];
            const levelDistance = level.distance - (level.distance * level.hysteresis);
            if (distance >= levelDistance) return i;
        }
        return 0;
    }
}

export default BasicHierarchicalInstancer;

const _defaultCapacity = 1000;
const _tempCol = new pc.Color();
const _tempMat41 = new pc.Mat4();
const _tempVec31 = new pc.Vec3();