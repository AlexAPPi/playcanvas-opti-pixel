import pc from "../engine.js";
import { ILODRender } from "./ILODRender.js";
import { GPUInstancedList } from "./InstancedList.js";
import { invertWorldTranslationRotation } from "./Utils/ConvertUtils.js";

export class LODRender implements ILODRender {

    /**
     * The gpu instanced list
     */
    public readonly list: GPUInstancedList;

    /**
     * The root of mesh instances
     */
    public readonly root: pc.Entity | null = null;

    /**
     * The mesh instances
     */
    public readonly meshes: pc.MeshInstance[];

    /**
     * The mesh instances matrix
     */
    public readonly meshesMatrix: pc.Mat4[];

    /**
     * Sort object flag
     */
    public sortObjects: boolean = false;

    public constructor(list: GPUInstancedList, meshes: pc.MeshInstance[], root: pc.Entity | null = null) {
        this.list = list;
        this.root = root;
        this.meshes = [...meshes];
        this.meshesMatrix = [];
        this.initMatrixes();
        this.patchMeshes();
        this.checkNeedSortObjects();
    }

    public initMatrixes() {
        const numMeshes = this.meshes.length;
        this.meshesMatrix.length = 0;
        for (let i = 0; i < numMeshes; i++) {
            this.meshesMatrix.push(new pc.Mat4());
        }
    }

    public patchMeshes() {
        const meshes = this.meshes;
        const numMeshes = meshes.length;
        const instancingBuffer = this.list.instancingBuffer;
        for (let i = 0; i < numMeshes; i++) {
            const mesh = meshes[i];
            mesh.setInstancing(instancingBuffer, false);
            mesh.instancingCount = 0;
        }
    }

    public checkNeedSortObjects() {
        let needSortObjects = false;
        const meshes = this.meshes;
        const numMeshes = meshes.length;
        for (let i = 0; i < numMeshes; i++) {
            const mesh = meshes[i];
            const material = mesh.material;
            if (material.transparent) {
                needSortObjects = true;
                break;
            }
        }
        this.sortObjects = needSortObjects;
    }

    public computeMaxMeshBoundingBox(): pc.BoundingBox | null {

        const root = this.root;
        const meshes = this.meshes;
        const numMeshes = meshes.length;

        if (numMeshes < 1) {
            return null;
        }

        if (root) {
            invertWorldTranslationRotation(root.getWorldTransform(), _tempMat41);
        }

        let result: pc.BoundingBox | null = null;

        for (let i = 0; i < numMeshes; i++) {

            const meshInstance = meshes[i];
            const aabb = meshInstance.mesh.aabb;

            let meshTransformMatrix = meshInstance.node.getWorldTransform();

            // Bounding box in local space of root (scale kept) for CPU frustum culling
            if (root) {
                _tempMat42.mulAffine2(_tempMat41, meshTransformMatrix);
                meshTransformMatrix = _tempMat42;
            }

            _tempBoundingBox.setFromTransformedAabb(aabb, meshTransformMatrix, false);

            if (result) {
                result.add(_tempBoundingBox);
            }
            else {
                result = _tempBoundingBox.clone();
            }
        }

        return result;
    }

    public resize(newCapacity: number) {
        this.list.resize(newCapacity);
        this.patchMeshes();
    }

    public start() {
        this.list.clear();
    }

    public enqueue(index: number, crossFade: number, extraPad: number = 0) {
        crossFade = Math.min(255, Math.max(0, crossFade * 255));
        this.list.push(index, crossFade, extraPad);
    }

    public sort(reversed: boolean, buf: Uint32Array, depthStore: Uint32Array) {
        this.list.sort(reversed, buf, depthStore);
    }

    public end() {

        const root = this.root;
        const count = this.list.count;
        const meshes = this.meshes;
        const matrixes = this.meshesMatrix;
        const numMeshes = meshes.length;
        const needUpdateMatrix  = count > 0 && root;

        this.list.update();

        if (needUpdateMatrix) {
            invertWorldTranslationRotation(root.getWorldTransform(), _tempMat41);
        }

        for (let i = 0; i < numMeshes; i++) {

            const mesh = meshes[i];

            mesh.instancingCount = count;

            if (needUpdateMatrix) {
                const meshLocalMatrix = matrixes[i];
                meshLocalMatrix.mulAffine2(_tempMat41, mesh.node.getWorldTransform());
                mesh.setParameter("uInstancerLocalInstanceMatrix", meshLocalMatrix.data);
            }
        }
    }

    public destroy(): void {
        this.list.destroy();
        this.meshes.forEach(x => x?.destroy());
    }
}

const _tempBoundingBox = new pc.BoundingBox();
const _tempMat41 = new pc.Mat4();
const _tempMat42 = new pc.Mat4();