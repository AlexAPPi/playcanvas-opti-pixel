import instancerInstanceVS from "./ShaderChunks/Vert/instance.js";
import instancerInstaceCrossFadeVS from "./ShaderChunks/Vert/instanceCrossFade.js";
import instancerInstanceMatrixVS from "./ShaderChunks/Vert/instanceMatrix.js";
import instancerInstanceColorVS from "./ShaderChunks/Vert/instanceColor.js";
import transformInstancingVS from "./ShaderChunks/Vert/transformInstancing.js";
import instancerDeclarationVS from "./ShaderChunks/Vert/instancerDeclaration.js";
import instancerMainEndVS from "./ShaderChunks/Vert/instancerMainEnd.js";

import instancerDeclarationPS from "./ShaderChunks/Frag/instancerDeclaration.js";
import instancerMainStartPS from "./ShaderChunks/Frag/instancerMainStart.js";
import instancerDiffusePS from "./ShaderChunks/Frag/diffuse.js";
import instancerOpacityPS from "./ShaderChunks/Frag/opacity.js";

import pc from "../engine.js";
import { SquareDataTexture } from "../Extras/SquareDataTexture.js";
import { IInstancer } from "./IInstancer";
import { ILODLevel } from "./ILODLevel";
import { GPUInstancedList, instancingIndexSemantic } from "./InstancedList.js";
import { LODRender } from "./LODRender.js";

export type TOnFrustumEnter = (index: number, camera: pc.Camera, level: number, distance: number) => void;
export type TOnFrustumEnterThenUpdate = (index: number, camera: pc.Camera, level: number, depth: number) => boolean | void;

const VISIBLE = 1;
const ACTIVE  = 2;
const BOTH    = VISIBLE | ACTIVE;

/**
 * Parameters for configuring an `InstancedMesh` instance.
 */
export interface InstancedMeshParams {

    /**
     * Determines the maximum number of instances that buffers can hold.
     * The buffers will be expanded automatically if necessary.
     * @default 1000
     */
    capacity?: number;
}

export abstract class AbsHierarchicalInstancer implements IInstancer {

    /** @internal */ _perObjectFrustumCulled = true;
    /** @internal */ _sortObjects = false;
    /** @internal */ _useOpacity = false;

    protected _maxInstanceBoundingBox: pc.BoundingBox;
    protected _instanceAABBCenter: pc.Vec3 = new pc.Vec3();
    protected _instanceAABBRadius: number = 0;

    protected _capacity: number;
    protected _sharedDepthStore: Float32Array;
    protected _sharedDepthStoreU: Uint32Array;
    protected _sharedIndexes: Uint32Array;

    protected _visibilityAndActivibility: Uint8Array;
    protected _needUpdateMaterials: boolean = true;

    public LODs: ILODLevel[] = [];
    public shadowLODs: ILODLevel[] = [];

    /**
     * Instanced mesh graphics device
     */
    public readonly device: pc.GraphicsDevice;

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

    /**
     * The number of active instances.
     */
    public get instancesCount(): number { return this.capacity; }

    /**
     * The number of active instances array.
     */
    public get instancesArrayCount() { return this.capacity; }

    public constructor(device: pc.GraphicsDevice, params: InstancedMeshParams = {}) {

        const { capacity = _defaultCapacity } = params;

        this.device = device;

        this._maxInstanceBoundingBox = new pc.BoundingBox();
        this._sharedDepthStore = new Float32Array(capacity);
        this._sharedDepthStoreU = new Uint32Array(this._sharedDepthStore.buffer);
        this._sharedIndexes = new Uint32Array(capacity);
        this._visibilityAndActivibility = new Uint8Array(capacity);
        this._capacity = capacity;

        this._initMatricesTexture();
    }

    protected _initMatricesTexture(): void {
        this.matricesTexture?.destroy();
        this.matricesTexture = new SquareDataTexture(this.device, Float32Array, 4, 4, this.capacity);
        this._needUpdateMaterials = true;
    }

    protected _initColorsTexture(): void {
        this.colorsTexture?.destroy();
        this.colorsTexture = new SquareDataTexture(this.device, Uint8Array, 4, 1, this.capacity, pc.PIXELFORMAT_RGBA8, 255);
        this._needUpdateMaterials = true;
    }

    public computeMaxInstanceBoundingBox(src?: pc.BoundingBox): pc.BoundingBox {

        // TODO: Ignore shadows ?
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

    public addLOD(meshInstanceList: pc.MeshInstance[] | null, root: pc.Entity | null, distance: number = 0, hysteresis: number = 0) {
        this._addLevel(this.LODs, meshInstanceList, root, distance, hysteresis);
        this.updateInstanceBoundingBox();
    }

    public updateLOD(levelIndex: number, distance: number, hysteresis: number) {

        if (levelIndex === 0 && distance !== 0) {
            console.warn("Cannot change distance for LOD0. It is the main mesh and must stay at 0."); // If user try to change first lod
            return;
        }

        return this._updateLevel(this.LODs, levelIndex, distance, hysteresis);
    }

    public remoteLOD(levelIndex: number, destroyObject: boolean = true) {
        const removed = this._removeLevel(this.LODs, levelIndex, destroyObject);
        this.updateInstanceBoundingBox();
        return removed;
    }

    public addShadowLOD(meshInstanceList: pc.MeshInstance[] | null, root: pc.Entity | null, distance: number = 0, hysteresis: number = 0) {
        this._addLevel(this.shadowLODs, meshInstanceList, root, distance, hysteresis);
    }

    public updateShadowLOD(levelIndex: number, distance: number, hysteresis: number) {
        return this._updateLevel(this.shadowLODs, levelIndex, distance, hysteresis);
    }

    public remoteShadowLOD(levelIndex: number, destroyObject: boolean = true) {
        return this._removeLevel(this.shadowLODs, levelIndex, destroyObject);
    }

    protected _addLevel(lods: ILODLevel[], meshInstanceList: pc.MeshInstance[] | null, root: pc.Entity | null, distance: number, hysteresis: number) {

        // to avoid to use Math.sqrt every time
        distance = distance ** 2;

        let index: number;

        for (index = 0; index < lods.length; index++) {
            if (distance < lods[index].distance) break;
        }

        let render: LODRender | undefined;

        if (meshInstanceList && meshInstanceList.length > 0) {
            const instancedList = new GPUInstancedList(this.device, this.capacity);
            render = new LODRender(instancedList, meshInstanceList, root);
            this.patchMeshInstancesMaterials(meshInstanceList);
        }

        lods.splice(index, 0, {
            distance,
            hysteresis,
            render
        });
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
                render.list.destroy();
                render.meshes.forEach(x => x?.destroy());
            }
        }

        return removedObj;
    }

    public patchMeshInstancesMaterials(meshInstanceList: pc.MeshInstance[]) {
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
                this.patchMeshInstancesMaterials(render.meshes);
            }
        }
    }

    public updateInstanceBoundingBox() {
        this.computeMaxInstanceBoundingBox(this._maxInstanceBoundingBox);
        this._instanceAABBCenter.copy(this._maxInstanceBoundingBox.center);
        this._instanceAABBRadius = this._maxInstanceBoundingBox.halfExtents.length();
    }

    protected _patchMaterial(material: pc.StandardMaterial) {

        const glslChunks = material.getShaderChunks(pc.SHADERLANGUAGE_GLSL);

        // Restore original user shader chunk code

        // VS
        let originalLitUserDeclarationVS = glslChunks.get("litUserDeclarationVS") ?? "/**/";
        if (originalLitUserDeclarationVS === instancerDeclarationVS) {
            originalLitUserDeclarationVS = glslChunks.get("instancerUserDeclarationVS") ?? "/**/";
        }

        let originalLitUserMainEndVS = glslChunks.get("litUserMainEndVS") ?? "/**/";
        if (originalLitUserMainEndVS === instancerMainEndVS) {
            originalLitUserMainEndVS = glslChunks.get("instancerUserMainEndVS") ?? "/**/";
        }

        // PS
        let originalLitUserDeclarationPS = glslChunks.get("litUserDeclarationPS") ?? "/**/";
        if (originalLitUserDeclarationPS === instancerDeclarationPS) {
            originalLitUserDeclarationPS = glslChunks.get("instancerUserDeclarationPS") ?? "/**/";
        }

        let originalLitUserStartMainPS = glslChunks.get("litUserMainStartPS") ?? "/**/";
        if (originalLitUserStartMainPS === instancerMainStartPS) {
            originalLitUserDeclarationPS = glslChunks.get("instancerUserMainStartPS") ?? "/**/";
        }

        material.shaderChunksVersion = "2.8";

        glslChunks
            // Lit shader VS
            .set("transformInstancingVS", transformInstancingVS)
            .set("litUserDeclarationVS", instancerDeclarationVS)
            .set("litUserMainEndVS", instancerMainEndVS)

            // Lit shader PS
            .set("litUserDeclarationPS", instancerDeclarationPS)
            .set("litUserMainStartPS", instancerMainStartPS)
            .set("diffusePS", instancerDiffusePS)
            .set("opacityPS", instancerOpacityPS)

            // Instancer
            .set("instancerInstanceVS", instancerInstanceVS)
            .set("instancerInstanceCrossFadeVS", instancerInstaceCrossFadeVS)
            .set("instancerInstanceMatrixVS", instancerInstanceMatrixVS)
            .set("instancerInstanceColorVS", instancerInstanceColorVS)

            // Instancer user VS
            .set("instancerUserDeclarationVS", originalLitUserDeclarationVS)
            .set("instancerUserMainEndVS", originalLitUserMainEndVS)

            // Instancer user PS
            .set("instancerUserDeclarationPS", originalLitUserDeclarationPS)
            .set("instancerMainStartPS", originalLitUserDeclarationPS)
        ;

        material.setAttribute("aInstanceIndex", instancingIndexSemantic);
        material.setParameter("uMatricesTexture", this.matricesTexture.texture);
        material.setParameter("local_matrix_instance", pc.Mat4.IDENTITY.data);

        material.setDefine("INSTANCER_USE_CROSSFADE", true);

        if (this.colorsTexture) {
            material.setDefine("INSTANCER_USE_CUSTOM_COLOR", true);
            material.setDefine("INSTANCER_USE_CUSTOM_OPACITY", this._useOpacity);
            material.setParameter("uColorTexture", this.colorsTexture.texture);
        }
        else {
            material.setDefine("INSTANCER_USE_CUSTOM_COLOR", false);
            material.setDefine("INSTANCER_USE_CUSTOM_OPACITY", false);
            material.deleteParameter("uColorTexture");
        }

        material.update();
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
     * Sets the visibility of a specific instance.
     * @param id The index of the instance.
     * @param visible Whether the instance should be visible.
     */
    public setVisibilityAt(id: number, visible: boolean): void {
        if (visible) {
            this._visibilityAndActivibility[id] |= VISIBLE;
        }
        else {
            this._visibilityAndActivibility[id] &= ~VISIBLE;
        }
    }

    /**
     * Gets the visibility of a specific instance.
     * @param id The index of the instance.
     * @returns Whether the instance is visible.
     */
    public getVisibilityAt(id: number): boolean {
        return (this._visibilityAndActivibility[id] & VISIBLE) !== 0;
    }

    /**
     * Sets the availability of a specific instance.
     * @param id The index of the instance.
     * @param active Whether the instance is active (not deleted).
     */
    public setActiveAt(id: number, active: boolean): void {
        if (active) {
            this._visibilityAndActivibility[id] |= ACTIVE;
        }
        else {
            this._visibilityAndActivibility[id] &= ~ACTIVE;
        }
    }

    /**
     * Gets the availability of a specific instance.
     * @param id The index of the instance.
     * @returns Whether the instance is active (not deleted).
     */
    public getActiveAt(id: number): boolean {
        return (this._visibilityAndActivibility[id] & ACTIVE) !== 0;
    }

    /**
     * Indicates if a specific instance is visible and active.
     * @param id The index of the instance.
     * @returns Whether the instance is visible and active.
     */
    public getActiveAndVisibilityAt(id: number): boolean {
        return (this._visibilityAndActivibility[id] & BOTH) === BOTH;
    }

    /**
     * Set if a specific instance is visible and active.
     * @param id The index of the instance.
     * @param value Whether the instance is active and active (not deleted).
     */
    public setActiveAndVisibilityAt(id: number, value: boolean): void {
        this._visibilityAndActivibility[id] = value ? BOTH : 0;
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

    public frustumCulling(camera: pc.Camera, cameraPosition: pc.Vec3, onFrustumEnter: TOnFrustumEnter) {

        const lods = this.LODs;
        const count = this.instancesArrayCount;

        for (let index = 0; index < count; index++) {

            if (!this.getActiveAndVisibilityAt(index)) continue;

            const maxScale = this.getPositionAndMaxScaleOnAxisAt(index, _sphere.center);
            const relativeCenterOfCamera = _tempVec32.sub2(_sphere.center, cameraPosition);
            const distance = relativeCenterOfCamera.lengthSq();
            const level = this.getObjectLODIndexForDistance(lods, distance);

            _sphere.radius = maxScale;

            if (camera.frustum.containsSphere(_sphere) > 0) {

                onFrustumEnter(index, camera, level, distance);
            }
        }
    }

    protected _updateRenders(camera: pc.Camera, cameraPosition: pc.Vec3, cameraForward: pc.Vec3, onFrustumEnter?: TOnFrustumEnterThenUpdate) {

        const lods = this.LODs;
        const frustum = camera.frustum;

        let minIndex = this.instancesArrayCount;
        let maxIndex = 0;
        let minZ =  Infinity;
        let maxZ = -Infinity;

        const count = this.instancesArrayCount;

        for (let index = 0; index < count; index++) {

            if (!this.getActiveAndVisibilityAt(index)) continue;

            this.applyMatrixAtToSphere(index, _sphere, this._instanceAABBCenter, this._instanceAABBRadius);

            //const maxScale = this.getPositionAndMaxScaleOnAxisAt(i, _sphere.center);
            //_sphere.radius = this._instanceAABBRadius * maxScale;

            if (frustum.containsSphere(_sphere) > 0) {

                const relativeCenterOfCamera = _tempVec32.sub2(_sphere.center, cameraPosition);
                const distance = relativeCenterOfCamera.lengthSq();
                const level = this.getLODIndexAndWeight(lods, distance);
                const levelRender = lods[level.index].render;

                let depth = Infinity;

                if (levelRender?.sortObjects) {
                    depth = relativeCenterOfCamera.dot(cameraForward);
                }

                if (!onFrustumEnter || onFrustumEnter(index, camera, level.index, depth)) {

                    // add 0.1 for safe off negative
                    this._sharedDepthStore[index] = depth + 0.1;
                    if (minZ > depth) minZ = depth;
                    if (maxZ < depth) maxZ = depth;
                    if (minIndex > index) minIndex = index;
                    if (maxIndex < index) maxIndex = index;

                    levelRender?.enqueue(index, depth, level.weight);

                    if (level.nextIndex !== null) {

                        const nextLevelRender = lods[level.nextIndex].render;

                        if (nextLevelRender) {
                            nextLevelRender.enqueue(index, depth, level.nextWeight);
                        }
                    }
                }
            }
        }

        // We adapt the depth for lower bit depths.
        const from = minIndex;
        const to   = maxIndex + 1;
        for (let i = from; i < to; i++) {
            this._sharedDepthStore[i] -= minZ;
        }
    }

    public update(dt: number, camera: pc.Camera, cameraPosition: pc.Vec3, cameraForward: pc.Vec3, onFrustumEnter?: TOnFrustumEnterThenUpdate) {

        this.matricesTexture?.update();
        this.colorsTexture?.update();

        if (this._needUpdateMaterials) {
            this.updateMaterials();
        }

        const lods = this.LODs;
        const numLods = lods.length;

        for (let lodIndex = 0; lodIndex < numLods; lodIndex++) {
            const render = lods[lodIndex].render;
            if (render) {
                render.start();
            }
        }

        this._updateRenders(camera, cameraPosition, cameraForward, onFrustumEnter);

        for (let lodIndex = 0; lodIndex < numLods; lodIndex++) {

            const render = lods[lodIndex].render;

            if (render) {

                if (render.sortObjects) {
                    render.list.sort(true, this._sharedIndexes, this._sharedDepthStoreU);
                }

                render.end();
            }
        }
    }

    public getLODIndexAndWeight(
        lods: ILODLevel[],
        distance: number
    ): { index: number; weight: number; nextWeight: number; nextIndex: number | null } {

        for (let i = 1, l = lods.length; i < l; i++) {

            const level = lods[i];

            if (distance < level.distance) {

                const levelDistance = level.distance - (level.distance * level.hysteresis);

                if (distance < levelDistance) {

                    return {
                        index: i - 1,
                        weight: 1,
                        nextWeight: 0,
                        nextIndex: null
                    };
                }

                const t = (distance - levelDistance) / (level.distance * level.hysteresis);
                const weight = Math.min(Math.max(0, t), 1);

                return {
                    index: i - 1,
                    weight: 1 - weight,
                    nextWeight: weight,
                    nextIndex: i
                }
            }
        }

        return {
            index: lods.length - 1,
            weight: 1,
            nextWeight: 0,
            nextIndex: null
        };
    }
}

export default AbsHierarchicalInstancer;

const _defaultCapacity = 1000;
const _sphere = new pc.BoundingSphere();
const _tempCol = new pc.Color();
const _tempMat41 = new pc.Mat4();
const _tempVec31 = new pc.Vec3();
const _tempVec32 = new pc.Vec3();