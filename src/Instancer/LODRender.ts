import pc from "../engine.js";
import { ILODRender } from "./ILODRender.js";
import { GPUInstancedList } from "./InstancedList.js";

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

function invertWorldTranslationRotation(world: pc.Mat4, out: pc.Mat4): void {

    const m = world.data;
    const r = out.data;

    let m0 = m[0], m1 = m[1], m2 = m[2];
    const m4 = m[4], m5 = m[5], m6 = m[6];
    const m8 = m[8], m9 = m[9], m10 = m[10];
    const tx = m[12], ty = m[13], tz = m[14];

    // Negative scale / reflection: match Quat.setFromMat4
    const det = m0 * (m5 * m10 - m6 * m9) - m1 * (m4 * m10 - m6 * m8) + m2 * (m4 * m9 - m5 * m8);
    if (det < 0) {
        m0 = -m0;
        m1 = -m1;
        m2 = -m2;
    }

    const lx = m0 * m0 + m1 * m1 + m2 * m2;
    const ly = m4 * m4 + m5 * m5 + m6 * m6;
    const lz = m8 * m8 + m9 * m9 + m10 * m10;
    const invLx = lx > 0 ? 1 / Math.sqrt(lx) : 0;
    const invLy = ly > 0 ? 1 / Math.sqrt(ly) : 0;
    const invLz = lz > 0 ? 1 / Math.sqrt(lz) : 0;

    const n0 = m0 * invLx, n1 = m1 * invLx, n2 = m2 * invLx;
    const n4 = m4 * invLy, n5 = m5 * invLy, n6 = m6 * invLy;
    const n8 = m8 * invLz, n9 = m9 * invLz, n10 = m10 * invLz;

    // inv(T*R) = [R^T | -R^T * t], scale stays in the later mul
    r[0] = n0; r[1] = n4; r[2] = n8; r[3] = 0;
    r[4] = n1; r[5] = n5; r[6] = n9; r[7] = 0;
    r[8] = n2; r[9] = n6; r[10] = n10; r[11] = 0;
    r[12] = -(n0 * tx + n1 * ty + n2 * tz);
    r[13] = -(n4 * tx + n5 * ty + n6 * tz);
    r[14] = -(n8 * tx + n9 * ty + n10 * tz);
    r[15] = 1;
}

const _tempBoundingBox = new pc.BoundingBox();
const _tempMat41 = new pc.Mat4();
const _tempMat42 = new pc.Mat4();