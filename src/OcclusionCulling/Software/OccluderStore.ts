import pc from "../../engine.js";
import { IndexManager } from "../../Extras/IndexManager.js";
import { setMatrixAt } from "../../Extras/Mat4DataTexture.js";
import {
    SO_MATRIX_STRIDE,
    SO_OCCLUDER_BOX,
    SO_OCCLUDER_CONE,
    SO_OCCLUDER_CYLINDER,
    SO_OCCLUDER_MESH,
    SO_OCCLUDER_PLANE,
    SO_OCCLUDER_SPHERE,
    SO_OCCLUDER_STRIDE
} from "./SoftwareOcclusionConstants.js";
import type {
    ISoftwareOcclusionMeshUpsert,
    ISoftwareOcclusionOccluderUpserts,
    ISoftwareOcclusionResize
} from "./SoftwareOcclusionMessages.js";

const _identity = new pc.Mat4();
const _noMesh = -1;

interface IOccluderMesh {
    vertices: Float32Array;
    indices: Uint32Array;
}

export interface IOccluderPendingBatch {
    resize: Pick<ISoftwareOcclusionResize, "occluderCapacity" | "meshSlots"> | null;
    meshUpserts: ISoftwareOcclusionMeshUpsert[];
    meshRemoves: number[];
    occluderUpserts: ISoftwareOcclusionOccluderUpserts | null;
    occluderRemoves: number[];
}

/**
 * Unique-mesh registry plus per-occluder type/matrix/meshId.
 * Geometry for the same `pc.Mesh` is stored once; instances only keep a mesh id.
 * Dirty ops are drained by {@link SoftwareOcclusionTester} for worker sync.
 */
export class OccluderStore {

    private _indexManager: IndexManager;
    private _types: Uint32Array;
    private _matrices: Float32Array;
    private _occluderMeshId: Int32Array;
    private _meshes: (IOccluderMesh | null)[] = [];
    private _meshRefCount: number[] = [];
    private _meshSources: (pc.Mesh | null)[] = [];
    private _usageVerts = 0;
    private _usageIdx = 0;
    private _meshKey = new WeakMap<pc.Mesh, number>();
    private _version = 0;
    private _meshVersion = 0;
    private _pendingOccluderOps = new Map<number, "upsert" | "remove">();
    private _pendingMeshOps = new Map<number, "upsert" | "remove">();
    private _capacityDirty = false;

    public get capacity() { return this._indexManager.capacity; }
    public get count() { return this._indexManager.reservedCount; }
    public get indexManager() { return this._indexManager; }
    public get types() { return this._types; }
    public get matrices() { return this._matrices; }
    public get meshIds() { return this._occluderMeshId; }
    public get meshSlotCount() { return this._meshes.length; }
    public get version() { return this._version; }
    public get meshVersion() { return this._meshVersion; }

    constructor(capacity: number = 256) {
        this._indexManager = new IndexManager(capacity, true);
        this._types = new Uint32Array(capacity);
        this._matrices = new Float32Array(capacity * SO_OCCLUDER_STRIDE);
        this._occluderMeshId = new Int32Array(capacity).fill(_noMesh);
        this._capacityDirty = true;
    }

    public get uniqueVertexFloats() { return this._usageVerts; }
    public get uniqueIndexCount() { return this._usageIdx; }

    public uniqueMeshUsage(): { vertices: number; indices: number } {
        return { vertices: this._usageVerts, indices: this._usageIdx };
    }

    public hasPending(): boolean {
        return this._capacityDirty
            || this._pendingOccluderOps.size > 0
            || this._pendingMeshOps.size > 0;
    }

    /**
     * Coalesces and clears pending worker sync ops. Mesh geometry is copied
     * so the returned buffers can be transferred without detaching store data.
     */
    public drainPending(): IOccluderPendingBatch {
        const resize = this._capacityDirty
            ? { occluderCapacity: this.capacity, meshSlots: Math.max(this._meshes.length, 1) }
            : null;
        this._capacityDirty = false;

        const meshUpserts: ISoftwareOcclusionMeshUpsert[] = [];
        const meshRemoves: number[] = [];
        for (const [meshId, op] of this._pendingMeshOps) {
            if (op === "remove") {
                meshRemoves.push(meshId);
                continue;
            }
            const mesh = this._meshes[meshId];
            if (mesh) {
                meshUpserts.push({
                    id: meshId,
                    vertices: mesh.vertices.slice(),
                    indices: mesh.indices.slice()
                });
            }
        }
        this._pendingMeshOps.clear();

        const upsertIds: number[] = [];
        const occluderRemoves: number[] = [];
        for (const [id, op] of this._pendingOccluderOps) {
            if (op === "remove") {
                occluderRemoves.push(id);
            }
            else {
                upsertIds.push(id);
            }
        }
        this._pendingOccluderOps.clear();

        let occluderUpserts: ISoftwareOcclusionOccluderUpserts | null = null;
        if (upsertIds.length > 0) {
            const n = upsertIds.length;
            const ids = new Uint32Array(n);
            const types = new Uint32Array(n);
            const matrices = new Float32Array(n * SO_OCCLUDER_STRIDE);
            const meshIds = new Int32Array(n);
            const srcTypes = this._types;
            const srcMat = this._matrices;
            const srcMesh = this._occluderMeshId;
            for (let i = 0; i < n; i++) {
                const id = upsertIds[i];
                ids[i] = id;
                types[i] = srcTypes[id];
                meshIds[i] = srcMesh[id];
                const s = id << 4;
                const d = i << 4;
                for (let j = 0; j < SO_MATRIX_STRIDE; j++) {
                    matrices[d + j] = srcMat[s + j];
                }
            }
            occluderUpserts = { ids, types, matrices, meshIds };
        }

        return { resize, meshUpserts, meshRemoves, occluderUpserts, occluderRemoves };
    }

    public resize(newCapacity: number) {
        this._indexManager.resize(newCapacity);

        const nextTypes = new Uint32Array(newCapacity);
        const nextMatrices = new Float32Array(newCapacity * SO_OCCLUDER_STRIDE);
        const nextMeshId = new Int32Array(newCapacity).fill(_noMesh);
        const copy = Math.min(this._types.length, newCapacity);

        nextTypes.set(this._types.subarray(0, copy));
        nextMatrices.set(this._matrices.subarray(0, copy * SO_OCCLUDER_STRIDE));
        nextMeshId.set(this._occluderMeshId.subarray(0, copy));

        this._types = nextTypes;
        this._matrices = nextMatrices;
        this._occluderMeshId = nextMeshId;
        this._capacityDirty = true;
        this._version++;
    }

    public lockBox(matrix?: pc.Mat4): number {
        return this._lock(SO_OCCLUDER_BOX, matrix);
    }

    public lockPlane(matrix?: pc.Mat4): number {
        return this._lock(SO_OCCLUDER_PLANE, matrix);
    }

    public lockCylinder(matrix?: pc.Mat4): number {
        return this._lock(SO_OCCLUDER_CYLINDER, matrix);
    }

    public lockCone(matrix?: pc.Mat4): number {
        return this._lock(SO_OCCLUDER_CONE, matrix);
    }

    public lockSphere(matrix?: pc.Mat4): number {
        return this._lock(SO_OCCLUDER_SPHERE, matrix);
    }

    /**
     * Registers a triangle-mesh occluder. Geometry is snapshotted at lock time
     * as unique vertices + indices. The same `pc.Mesh` is interned and shared.
     * If `source` is a `MeshInstance` and `matrix` is omitted, the node's world transform is used.
     */
    public lockMesh(source: pc.Mesh | pc.MeshInstance, matrix?: pc.Mat4): number {
        const meshInstance = isMeshInstance(source);
        const mesh = meshInstance ? source.mesh : source;
        const transform = matrix ?? (meshInstance ? source.node.getWorldTransform() : undefined);
        const id = this._indexManager.reserve();
        try {
            let meshId = this._meshKey.get(mesh);
            if (meshId === undefined) {
                meshId = this._allocMesh(extractMeshData(mesh), mesh);
            }
            else {
                this._meshRefCount[meshId]++;
            }
            this._bindMesh(id, meshId, transform);
            return id;
        }
        catch (error) {
            this._indexManager.free(id);
            throw error;
        }
    }

    /**
     * Registers a triangle-mesh occluder from raw xyz positions.
     * `indices` are optional; without them `positions` is treated as a triangle soup.
     */
    public lockMeshData(positions: ArrayLike<number>, indices?: ArrayLike<number> | null, matrix?: pc.Mat4): number {
        const id = this._indexManager.reserve();
        try {
            const mesh = extractVertData(positions, indices ?? null);
            const meshId = this._allocMesh(mesh, null);
            this._bindMesh(id, meshId, matrix);
            return id;
        }
        catch (error) {
            this._indexManager.free(id);
            throw error;
        }
    }

    public unlock(id: number): void {
        this._releaseMesh(id);
        this._types[id] = 0;
        this._indexManager.free(id);
        this._pendingOccluderOps.set(id, "remove");
        this._version++;
    }

    public enqueueUpdate(id: number, matrix: pc.Mat4): void {
        setMatrixAt(this._matrices, id, matrix);
        this._pendingOccluderOps.set(id, "upsert");
        this._version++;
    }

    private _lock(type: number, matrix?: pc.Mat4): number {
        const id = this._indexManager.reserve();
        this._types[id] = type;
        this._occluderMeshId[id] = _noMesh;
        setMatrixAt(this._matrices, id, matrix ?? _identity);
        this._pendingOccluderOps.set(id, "upsert");
        this._version++;
        return id;
    }

    private _bindMesh(id: number, meshId: number, matrix?: pc.Mat4): void {
        this._types[id] = SO_OCCLUDER_MESH;
        this._occluderMeshId[id] = meshId;
        setMatrixAt(this._matrices, id, matrix ?? _identity);
        this._pendingOccluderOps.set(id, "upsert");
        this._version++;
    }

    private _allocMesh(mesh: IOccluderMesh, source: pc.Mesh | null): number {
        let meshId = this._meshes.indexOf(null);
        if (meshId < 0) {
            meshId = this._meshes.length;
            this._meshes.push(mesh);
            this._meshRefCount.push(1);
            this._meshSources.push(source);
            this._capacityDirty = true;
        }
        else {
            this._meshes[meshId] = mesh;
            this._meshRefCount[meshId] = 1;
            this._meshSources[meshId] = source;
        }
        if (source) {
            this._meshKey.set(source, meshId);
        }
        this._usageVerts += mesh.vertices.length;
        this._usageIdx += mesh.indices.length;
        this._pendingMeshOps.set(meshId, "upsert");
        this._meshVersion++;
        return meshId;
    }

    private _releaseMesh(id: number): void {
        const meshId = this._occluderMeshId[id];
        this._occluderMeshId[id] = _noMesh;
        if (meshId < 0) {
            return;
        }

        const refCount = this._meshRefCount[meshId] - 1;
        this._meshRefCount[meshId] = refCount;
        if (refCount > 0) {
            return;
        }

        const source = this._meshSources[meshId];
        if (source) {
            this._meshKey.delete(source);
        }
        const dropped = this._meshes[meshId];
        this._meshes[meshId] = null;
        this._meshSources[meshId] = null;
        if (dropped) {
            this._usageVerts -= dropped.vertices.length;
            this._usageIdx -= dropped.indices.length;
        }
        this._pendingMeshOps.set(meshId, "remove");
        this._meshVersion++;
    }
}

function isMeshInstance(value: pc.Mesh | pc.MeshInstance): value is pc.MeshInstance {
    return value instanceof pc.MeshInstance;
}

function extractMeshData(mesh: pc.Mesh): IOccluderMesh {
    const positions: number[] = [];
    mesh.getPositions(positions);
    const srcIndices: number[] = [];
    const indexCount = mesh.getIndices(srcIndices);
    const hasIndices = indexCount > 0;
    const primitives = mesh.primitive;
    const collected: number[] = [];
    const trianglesPrim = primitives[pc.PRIMITIVE_TRIANGLES];

    if (trianglesPrim && trianglesPrim.count >= 3) {
        const prim = trianglesPrim;
        const count = (prim.count / 3) * 3;
        if (prim.indexed && hasIndices) {
            const baseVertex = prim.baseVertex || 0;
            for (let k = 0; k < count; k++) {
                collected.push(srcIndices[prim.base + k] + baseVertex);
            }
        }
        else {
            const start = prim.base + (prim.baseVertex || 0);
            for (let k = 0; k < count; k++) {
                collected.push(start + k);
            }
        }
    }

    return compactMesh(positions, collected);
}

function extractVertData(positions: ArrayLike<number>, indices: ArrayLike<number> | null): IOccluderMesh {
    const collected: number[] = [];
    if (indices && indices.length > 0) {
        const count = (indices.length / 3) * 3;
        for (let i = 0; i < count; i++) {
            collected.push(indices[i]);
        }
    }
    else {
        const count = ((positions.length / 9) | 0) * 3;
        for (let i = 0; i < count; i++) {
            collected.push(i);
        }
    }
    return compactMesh(positions, collected);
}

function compactMesh(positions: ArrayLike<number>, indices: number[]): IOccluderMesh {
    if (indices.length === 0) {
        return { vertices: new Float32Array(0), indices: new Uint32Array(0) };
    }

    const vertexCount = (positions.length / 3) | 0;
    const map = new Int32Array(vertexCount).fill(-1);
    const remapped = new Uint32Array(indices.length);
    let used = 0;

    for (let i = 0; i < indices.length; i++) {
        const old = indices[i];
        if (old < 0 || old >= vertexCount) {
            remapped[i] = 0;
            continue;
        }
        let id = map[old];
        if (id < 0) {
            id = used++;
            map[old] = id;
        }
        remapped[i] = id;
    }

    const vertices = new Float32Array(used * 3);
    for (let old = 0; old < vertexCount; old++) {
        const id = map[old];
        if (id < 0) {
            continue;
        }
        const src = old * 3;
        const dst = id * 3;
        vertices[dst] = positions[src];
        vertices[dst + 1] = positions[src + 1];
        vertices[dst + 2] = positions[src + 2];
    }

    return { vertices, indices: remapped };
}
