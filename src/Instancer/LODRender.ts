import pc from "../engine.js";
import { GPUInstancedList, instancingIndexSemantic } from "./InstancedList.js";

export class LODRender {

    private _minZ: number =  Infinity;
    private _maxZ: number = -Infinity;

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

        const meshes = this.meshes;
        const numMeshes = meshes.length;

        if (this.root) {
            _tempMat41.invert(this.root.getWorldTransform());
        }

        let result: pc.BoundingBox | null = null;

        for (let i = 0; i < numMeshes; i++) {

            const meshAABB = meshes[i].mesh.aabb;

            // Calculate the bounding box in local space of root,
            // to be able to use it for frustum culling without update matrixes on cpu
            if (this.root) {
                const meshWorldMatrix = meshes[i].node.getWorldTransform();
                const meshLocalMatrix = _tempMat42.mul2(_tempMat41, meshWorldMatrix);
                _tempBoundingBox.setFromTransformedAabb(meshAABB, meshLocalMatrix, false);
                result ??= _tempBoundingBox.clone();
                result.add(_tempBoundingBox);
            }
            else {
                result ??= meshAABB.clone();
                result.add(meshAABB);
            }
        }

        return result;
    }

    public start() {
        this.list.clear();
        this._minZ =  Infinity;
        this._maxZ = -Infinity;
    }

    public enqueue(index: number, depth: number, opacity: number) {
        opacity = Math.min(255, Math.max(0, opacity * 255));
        this.list.push(index, opacity);
        if (this._minZ > depth) this._minZ = depth;
        if (this._maxZ < depth) this._maxZ = depth;
    }

    public end() {

        const count = this.list.count;
        const meshes = this.meshes;
        const matrixes = this.meshesMatrix;
        const numMeshes = meshes.length;
        const needUpdateMatrix  = count > 0 && this.root;

        this.list.update();

        if (needUpdateMatrix) {
            _tempMat41.invert(this.root.getWorldTransform());
        }

        for (let i = 0; i < numMeshes; i++) {

            const mesh = meshes[i];
            mesh.instancingCount = count;

            if (needUpdateMatrix) {
                const meshWorldMatrix = mesh.node.getWorldTransform();
                const meshLocalMatrix = matrixes[i];
                meshLocalMatrix.mul2(_tempMat41, meshWorldMatrix);
                mesh.setParameter("local_matrix_instance", meshLocalMatrix.data);
            }
        }
    }
}

const _tempBoundingBox = new pc.BoundingBox();
const _tempMat41 = new pc.Mat4();
const _tempMat42 = new pc.Mat4();