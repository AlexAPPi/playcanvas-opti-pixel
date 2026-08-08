import pc from "../engine.js";
import { ColorDataTextureArray, ColorDataTextureLayerProxy } from "../Extras/ColorDataTexture.js";
import { Mat4DataTextureArray, Mat4DataTextureLayerProxy } from "../Extras/Mat4DataTexture.js";
import { ILODLevel } from "./ILODLevel.js";
import { GPUInstancedList, instancingIndexSemantic as instancingInstanceSemantic } from "./InstancedList.js";
import { LODRender } from "./LODRender.js";
import { ILODRender } from "./ILODRender.js";
import { defaultShaderChunksMapScope, IInstancerShaderChunkMap, IInstancerShaderChunkMapScope } from "./InstancerShaderChunks.js";

/**
 * Parameters for configuring a `BasicArrayHierarchicalInstancer` instance.
 */
export interface IBasicArrayHierarchicalInstancerParams {

    /**
     * Determines the maximum number of instances that buffers can hold.
     * The buffers will be expanded automatically if necessary.
     * @default 1000
     */
    capacity?: number;

    /**
     * Number of logical layers (and texture-array depth for matrices/colors).
     * @default 1
     */
    layers?: number;
}

/**
 * Per-layer view of {@link BasicArrayHierarchicalInstancer}: own LODs, sorter,
 * material/opacity flags; shares capacity and texture arrays with the host.
 */
export class BasicArrayHierarchicalInstancerLayer {

    /** @internal */ _sortObjects = false;
    /** @internal */ _useOpacity = false;

    protected _needUpdateMaterials: boolean = true;
    protected _time: number = 0;

    protected _maxInstanceBoundingBox: pc.BoundingBox = new pc.BoundingBox();
    protected _instanceAABBCenter: pc.Vec3 = new pc.Vec3();
    protected _instanceAABBRadius: number = 0;

    protected _sortObjectsInStep: boolean = false;

    // Need for sort
    protected _sharedDepthStore: Float32Array | null = null;
    protected _sharedDepthStoreU: Uint32Array | null = null;
    protected _sharedIndexes: Uint32Array | null = null;

    protected _host: BasicArrayHierarchicalInstancer;
    protected _layer: number;

    /**
     * LODs for this layer.
     */
    public LODs: ILODLevel[] = [];

    /**
     * Matrix writer proxy for this layer.
     */
    public matricesTexture: Mat4DataTextureLayerProxy;

    /**
     * Color writer proxy for this layer. Lazy-initialized with host colors array.
     */
    public colorsTexture: ColorDataTextureLayerProxy = null!;

    public get layer(): number { return this._layer; }

    public get device(): pc.GraphicsDevice { return this._host.device; }

    public get capacity(): number { return this._host.capacity; }

    /** @internal — constructed by {@link BasicArrayHierarchicalInstancer} only. */
    public constructor(host: BasicArrayHierarchicalInstancer, layer: number) {
        this._host = host;
        this._layer = layer;
        this.matricesTexture = host.matricesTextureArray.getLayer(layer);
        if (host.colorsTextureArray) {
            this.colorsTexture = host.colorsTextureArray.getLayer(layer);
        }
    }

    /** @internal — host lifecycle. */
    public _rebindTextureProxies(): void {
        this.matricesTexture = this._host.matricesTextureArray.getLayer(this._layer);
        if (this._host.colorsTextureArray) {
            this.colorsTexture = this._host.colorsTextureArray.getLayer(this._layer);
        } else {
            this.colorsTexture = null!;
        }
        this._needUpdateMaterials = true;
    }

    /** @internal — host lifecycle. */
    public _bindColorProxy(): void {
        this.colorsTexture = this._host.colorsTextureArray.getLayer(this._layer);
        this._needUpdateMaterials = true;
    }

    /** @internal — host lifecycle. */
    public _markNeedUpdateMaterials(): void {
        this._needUpdateMaterials = true;
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

    /** @internal — host lifecycle. */
    public _onHostCapacityChanged(): void {
        this._resizeRenders();
        this._initOrDisposeSorterIfNeed(this.LODs);
    }

    public applySortingIfNeeded(): void {
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
            console.warn("Cannot change distance for LOD0. It is the main mesh and must stay at 0.");
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

        const host = this._host;

        material.setParameter("uInstancerMatricesTexture", host.matricesTextureArray.texture);
        material.setParameter("uInstancerMatricesLayer", this._layer);
        material.setParameter("uInstancerLocalInstanceMatrix", pc.Mat4.IDENTITY.data);
        material.setParameter("uInstancerInstanceLayer", this._layer);

        material.setDefine("INSTANCER_USE_LAYERS", true);
        material.setDefine("INSTANCER_USE_CROSSFADE", true);
        material.setDefine("INSTANCER_USE_EXTRAPAD", true);

        if (host.colorsTextureArray) {
            material.setDefine("INSTANCER_USE_CUSTOM_COLOR", true);
            material.setDefine("INSTANCER_USE_CUSTOM_OPACITY", this._useOpacity);
            material.setParameter("uInstancerColorTexture", host.colorsTextureArray.texture);
            material.setParameter("uInstancerColorLayer", this._layer);
        }
        else {
            material.setDefine("INSTANCER_USE_CUSTOM_COLOR", false);
            material.setDefine("INSTANCER_USE_CUSTOM_OPACITY", false);
            material.deleteParameter("uInstancerColorTexture");
            material.deleteParameter("uInstancerColorLayer");
        }
    }

    protected _setMaterialAttributes(material: pc.StandardMaterial) {
        material.setAttribute("aInstancerInstance", instancingInstanceSemantic);
    }

    protected _replaceMaterialShaderChunks(shaderChunkMap: ReturnType<pc.Material["getShaderChunks"]>, chunks: IInstancerShaderChunkMap) {

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
            .set("instancerInstanceAttrVS", chunks.instancerInstanceAttrVS)
            .set("instancerInstanceIdVS", chunks.instancerInstanceIdVS)
            .set("instancerInstanceLayerVS", chunks.instancerInstanceLayerVS)
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

    protected _patchMaterial(material: pc.StandardMaterial, shaderChunkMapScope?: IInstancerShaderChunkMapScope, updateMaterial: boolean = true) {

        const glslChunks = material.getShaderChunks(pc.SHADERLANGUAGE_GLSL);
        const wgslChunks = material.getShaderChunks(pc.SHADERLANGUAGE_WGSL);

        const glslInstancerChunks = {
            ...defaultShaderChunksMapScope.glsl,
            ...shaderChunkMapScope?.glsl,
        };

        const wgslInstancerChunks = {
            ...defaultShaderChunksMapScope.wgsl,
            ...shaderChunkMapScope?.wgsl,
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

    public setMatrixAt(id: number, matrix: pc.Mat4): void {
        this.matricesTexture.setMatrixAt(id, matrix);
    }

    public getMatrixAt(id: number, matrix?: pc.Mat4): pc.Mat4 {
        return this.matricesTexture.getMatrixAt(id, matrix);
    }

    public getPositionAt(index: number, target?: pc.Vec3): pc.Vec3 {
        return this.matricesTexture.getPositionAt(index, target);
    }

    public getPositionAndMaxScaleOnAxisAt(index: number, position: pc.Vec3): number {
        return this.matricesTexture.getPositionAndMaxScaleOnAxisAt(index, position);
    }

    public applyMatrixAtToSphere(index: number, sphere: pc.BoundingSphere, center: pc.Vec3, radius: number): void {
        this.matricesTexture.applyMatrixAtToSphere(index, sphere, center, radius);
    }

    public setColorAt(id: number, color: pc.Color): void {

        if (this.colorsTexture === null) {
            this._host._initColorsTexture();
        }

        this.colorsTexture.setColorAt(id, color);
    }

    public getColorAt(id: number, color?: pc.Color): pc.Color {
        return this.colorsTexture.getColorAt(id, color);
    }

    public setOpacityAt(id: number, value: number): void {

        if (!this._useOpacity) {

            if (this.colorsTexture === null) {
                this._host._initColorsTexture();
            } else {
                this._needUpdateMaterials = true;
            }

            this._useOpacity = true;
        }

        this.colorsTexture.setOpacityAt(id, value);
    }

    public getOpacityAt(id: number): number {
        if (!this._useOpacity) return 1;
        return this.colorsTexture.getOpacityAt(id);
    }

    /** @internal — host lifecycle. */
    public _beforeUpdateRenders(dt: number): void {

        this._time += dt;

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

    /** @internal — host lifecycle. */
    public _afterUpdateRenders(_dt: number): void {

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

    public getObjectLODIndexForDistance(lods: ILODLevel[], distance: number): number {
        for (let i = lods.length - 1; i > 0; i--) {
            const level = lods[i];
            const levelDistance = level.distance - (level.distance * level.hysteresis);
            if (distance >= levelDistance) return i;
        }
        return 0;
    }

    /** @internal — host lifecycle. */
    public _destroy(): void {
        const lods = this.LODs;
        for (let i = 0; i < lods.length; i++) {
            lods[i].render?.destroy();
        }
        this.LODs.length = 0;
        this._disposeSorter();
    }
}

/**
 * Hierarchical instancer backed by `sampler2DArray` data textures.
 * Shared capacity / texture arrays; per-layer LODs and material/sort state via {@link getLayer}.
 */
export class BasicArrayHierarchicalInstancer {

    protected _capacity: number;
    protected _layers: number;
    protected _layerList: BasicArrayHierarchicalInstancerLayer[];

    /**
     * Instanced mesh graphics device
     */
    public readonly device: pc.GraphicsDevice;

    /**
     * Matrix texture array host (`sampler2DArray`).
     */
    public matricesTextureArray: Mat4DataTextureArray;

    /**
     * Color texture array host (`sampler2DArray`). Lazy-initialized.
     */
    public colorsTextureArray: ColorDataTextureArray = null!;

    public get capacity(): number { return this._capacity; }

    public get layers(): number { return this._layers; }

    public constructor(device: pc.GraphicsDevice, params: IBasicArrayHierarchicalInstancerParams = {}) {

        const {
            capacity = _defaultCapacity,
            layers = 1
        } = params;

        if (layers < 1) {
            throw new Error("BasicArrayHierarchicalInstancer: layers must be >= 1");
        }

        this.device = device;
        this._capacity = capacity;
        this._layers = layers;
        this._layerList = [];

        this._initMatricesTexture();
        this._syncLayers(layers);
    }

    public getLayer(layer: number): BasicArrayHierarchicalInstancerLayer {

        if (layer < 0 || layer >= this._layerList.length) {
            throw new Error(`BasicArrayHierarchicalInstancer: layer ${layer} OOB (layers=${this._layers})`);
        }

        return this._layerList[layer];
    }

    /**
     * Factory for layer views. Override to supply a specialized layer subclass.
     */
    protected _createLayer(layer: number): BasicArrayHierarchicalInstancerLayer {
        return new BasicArrayHierarchicalInstancerLayer(this, layer);
    }

    protected _syncLayers(layers: number): void {

        const list = this._layerList;

        while (list.length > layers) {
            const removed = list.pop()!;
            removed._destroy();
        }

        while (list.length < layers) {
            list.push(this._createLayer(list.length));
        }

        for (let i = 0; i < list.length; i++) {
            list[i]._rebindTextureProxies();
        }

        this._layers = layers;
    }

    protected _initMatricesTexture(): void {
        this.matricesTextureArray?.destroy();
        this.matricesTextureArray = new Mat4DataTextureArray(this.device, {
            capacity: this.capacity,
            layers: this._layers
        });
    }

    /** @internal — called from layer when colors are first used. */
    public _initColorsTexture(): void {
        this.colorsTextureArray?.destroy();
        this.colorsTextureArray = new ColorDataTextureArray(this.device, {
            capacity: this.capacity,
            layers: this._layers
        });
        for (let i = 0; i < this._layerList.length; i++) {
            this._layerList[i]._bindColorProxy();
        }
    }

    public updateTextures(): void {
        this.matricesTextureArray?.update();
        this.colorsTextureArray?.update();
    }

    public resize(newCapacity: number) {

        if (this._capacity === newCapacity) {
            return;
        }

        this._capacity = newCapacity;
        this.matricesTextureArray?.resize(newCapacity);
        this.colorsTextureArray?.resize(newCapacity);

        for (let i = 0; i < this._layerList.length; i++) {
            const layer = this._layerList[i];
            layer._onHostCapacityChanged();
            layer._markNeedUpdateMaterials();
        }
    }

    /**
     * Resize logical / texture-array layer count. Recreates GPU textures — materials rebound.
     */
    public resizeLayers(layers: number): void {

        if (layers < 1) {
            throw new Error("BasicArrayHierarchicalInstancer: layers must be >= 1");
        }

        if (layers === this._layers) {
            return;
        }

        this._layers = layers;
        this.matricesTextureArray.resizeLayers(layers);
        this.colorsTextureArray?.resizeLayers(layers);
        this._syncLayers(layers);
    }

    protected _beforeUpdateRenders(dt: number) {

        this.updateTextures();

        const list = this._layerList;
        for (let i = 0; i < list.length; i++) {
            list[i]._beforeUpdateRenders(dt);
        }
    }

    protected _afterUpdateRenders(dt: number) {

        const list = this._layerList;
        for (let i = 0; i < list.length; i++) {
            list[i]._afterUpdateRenders(dt);
        }
    }
}

export default BasicArrayHierarchicalInstancer;

const _defaultCapacity = 1000;
