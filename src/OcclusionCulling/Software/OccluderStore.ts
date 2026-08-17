import pc from "../../engine.js";
import { IndexManager } from "../../Extras/IndexManager.js";
import { setMatrixAt } from "../../Extras/Mat4DataTexture.js";
import {
    SO_DEFAULT_MESH_INDEX_CAPACITY,
    SO_DEFAULT_MESH_VERTEX_CAPACITY,
    SO_MESH_RANGE_STRIDE,
    SO_OCCLUDER_BOX,
    SO_OCCLUDER_CONE,
    SO_OCCLUDER_CYLINDER,
    SO_OCCLUDER_MESH,
    SO_OCCLUDER_PLANE,
    SO_OCCLUDER_SPHERE,
    SO_OCCLUDER_STRIDE
} from "./SoftwareOcclusionConstants.js";

const _identity = new pc.Mat4();
const _noMesh = -1;

interface IOccluderMesh {
    vertices: Float32Array;
    indices: Uint32Array;
}

export class OccluderStore {

    private _indexManager: IndexManager;
    private _types: Uint32Array;
    private _matrices: Float32Array;
    private _occluderMeshId: Int32Array;
    private _meshRanges: Uint32Array;
    private _packedVertices: Float32Array;
    private _packedIndices: Uint32Array;
    private _packedVertUsed = 0;
    private _packedIndexUsed = 0;
    private _packedDirty = false;
    private _meshes: (IOccluderMesh | null)[] = [];
    private _meshRefCount: number[] = [];
    private _meshSources: (pc.Mesh | null)[] = [];
    private _meshKey = new WeakMap<pc.Mesh, number>();
    private _version = 0;
    private _meshVersion = 0;

    public get capacity() { return this._indexManager.capacity; }
    public get count() { return this._indexManager.reservedCount; }
    public get indexManager() { return this._indexManager; }
    public get types() { return this._types; }
    public get matrices() { return this._matrices; }
    public get meshRanges() {
        this._ensurePacked();
        return this._meshRanges;
    }
    public get meshVertices() {
        this._ensurePacked();
        return this._packedVertices;
    }
    public get meshIndices() {
        this._ensurePacked();
        return this._packedIndices;
    }
    public get meshVertexCount() {
        this._ensurePacked();
        return this._packedVertUsed;
    }
    public get meshIndexCount() {
        this._ensurePacked();
        return this._packedIndexUsed;
    }
    public get meshVertexCapacity() { return this._packedVertices.length; }
    public get meshIndexCapacity() { return this._packedIndices.length; }
    public get version() { return this._version; }
    public get meshVersion() { return this._meshVersion; }

    constructor(
        capacity: number = 256,
        meshVertexCapacity: number = SO_DEFAULT_MESH_VERTEX_CAPACITY,
        meshIndexCapacity: number = SO_DEFAULT_MESH_INDEX_CAPACITY
    ) {
        this._indexManager = new IndexManager(capacity, true);
        this._types = new Uint32Array(capacity);
        this._matrices = new Float32Array(capacity * SO_OCCLUDER_STRIDE);
        this._occluderMeshId = new Int32Array(capacity).fill(_noMesh);
        this._meshRanges = new Uint32Array(capacity * SO_MESH_RANGE_STRIDE);
        this._packedVertices = new Float32Array(Math.max(0, meshVertexCapacity));
        this._packedIndices = new Uint32Array(Math.max(0, meshIndexCapacity));
    }

    public resize(newCapacity: number) {
        this._indexManager.resize(newCapacity);

        const nextTypes = new Uint32Array(newCapacity);
        const nextMatrices = new Float32Array(newCapacity * SO_OCCLUDER_STRIDE);
        const nextMeshId = new Int32Array(newCapacity).fill(_noMesh);
        const nextRanges = new Uint32Array(newCapacity * SO_MESH_RANGE_STRIDE);
        const copy = Math.min(this._types.length, newCapacity);

        nextTypes.set(this._types.subarray(0, copy));
        nextMatrices.set(this._matrices.subarray(0, copy * SO_OCCLUDER_STRIDE));
        nextMeshId.set(this._occluderMeshId.subarray(0, copy));
        nextRanges.set(this._meshRanges.subarray(0, copy * SO_MESH_RANGE_STRIDE));

        this._types = nextTypes;
        this._matrices = nextMatrices;
        this._occluderMeshId = nextMeshId;
        this._meshRanges = nextRanges;
        this._packedDirty = true;
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
        let meshId = this._meshKey.get(mesh);
        if (meshId === undefined) {
            meshId = this._allocMesh(extractIndexedMesh(mesh), mesh);
        }
        else {
            this._meshRefCount[meshId]++;
        }
        return this._lockMesh(meshId, transform);
    }

    /**
     * Registers a triangle-mesh occluder from raw xyz positions.
     * `indices` are optional; without them `positions` is treated as a triangle soup.
     */
    public lockMeshData(positions: ArrayLike<number>, indices?: ArrayLike<number> | null, matrix?: pc.Mat4): number {
        const meshId = this._allocMesh(extractIndexedData(positions, indices ?? null), null);
        return this._lockMesh(meshId, matrix);
    }

    public unlock(id: number): void {
        this._releaseMesh(id);
        this._types[id] = 0;
        this._indexManager.free(id);
        this._version++;
    }

    public enqueueUpdate(id: number, matrix: pc.Mat4): void {
        setMatrixAt(this._matrices, id, matrix);
        this._version++;
    }

    private _lock(type: number, matrix?: pc.Mat4): number {
        const id = this._indexManager.reserve();
        this._types[id] = type;
        this._occluderMeshId[id] = _noMesh;
        setMatrixAt(this._matrices, id, matrix ?? _identity);
        this._version++;
        return id;
    }

    private _lockMesh(meshId: number, matrix?: pc.Mat4): number {
        const id = this._indexManager.reserve();
        this._types[id] = SO_OCCLUDER_MESH;
        this._occluderMeshId[id] = meshId;
        setMatrixAt(this._matrices, id, matrix ?? _identity);
        this._packedDirty = true;
        this._version++;
        return id;
    }

    private _allocMesh(mesh: IOccluderMesh, source: pc.Mesh | null): number {
        let meshId = this._meshes.indexOf(null);
        if (meshId < 0) {
            meshId = this._meshes.length;
            this._meshes.push(mesh);
            this._meshRefCount.push(1);
            this._meshSources.push(source);
        }
        else {
            this._meshes[meshId] = mesh;
            this._meshRefCount[meshId] = 1;
            this._meshSources[meshId] = source;
        }
        if (source) {
            this._meshKey.set(source, meshId);
        }
        this._packedDirty = true;
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
            this._packedDirty = true;
            return;
        }

        const source = this._meshSources[meshId];
        if (source) {
            this._meshKey.delete(source);
        }
        this._meshes[meshId] = null;
        this._meshSources[meshId] = null;
        this._packedDirty = true;
        this._meshVersion++;
    }

    private _ensurePacked(): void {
        if (!this._packedDirty) {
            return;
        }
        this._packedDirty = false;

        let neededVerts = 0;
        let neededIndices = 0;
        for (let i = 0; i < this._meshes.length; i++) {
            const mesh = this._meshes[i];
            if (mesh) {
                neededVerts += mesh.vertices.length;
                neededIndices += mesh.indices.length;
            }
        }

        if (neededVerts > this._packedVertices.length) {
            this._packedVertices = new Float32Array(nextPow2(neededVerts));
        }
        if (neededIndices > this._packedIndices.length) {
            this._packedIndices = new Uint32Array(nextPow2(neededIndices));
        }

        const vertOffset = new Uint32Array(this._meshes.length);
        const indexOffset = new Uint32Array(this._meshes.length);
        let v = 0;
        let idx = 0;
        for (let i = 0; i < this._meshes.length; i++) {
            const mesh = this._meshes[i];
            if (!mesh) {
                continue;
            }
            vertOffset[i] = v / 3;
            indexOffset[i] = idx;
            this._packedVertices.set(mesh.vertices, v);
            this._packedIndices.set(mesh.indices, idx);
            v += mesh.vertices.length;
            idx += mesh.indices.length;
        }
        this._packedVertUsed = v;
        this._packedIndexUsed = idx;

        this._meshRanges.fill(0);
        for (let i = 0; i < this._occluderMeshId.length; i++) {
            const meshId = this._occluderMeshId[i];
            if (meshId < 0) {
                continue;
            }
            const mesh = this._meshes[meshId];
            if (!mesh) {
                continue;
            }
            const range = i * SO_MESH_RANGE_STRIDE;
            this._meshRanges[range] = vertOffset[meshId];
            this._meshRanges[range + 1] = mesh.vertices.length / 3;
            this._meshRanges[range + 2] = indexOffset[meshId];
            this._meshRanges[range + 3] = mesh.indices.length;
        }
    }
}

function nextPow2(needed: number): number {
    let cap = 1;
    while (cap < needed) {
        cap <<= 1;
    }
    return cap;
}

function isMeshInstance(value: pc.Mesh | pc.MeshInstance): value is pc.MeshInstance {
    return value instanceof pc.MeshInstance;
}

function extractIndexedMesh(mesh: pc.Mesh): IOccluderMesh {
    const positions: number[] = [];
    const positionCount = mesh.getPositions(positions);
    const srcIndices: number[] = [];
    const indexCount = mesh.getIndices(srcIndices);
    const hasIndices = indexCount > 0;
    const primitives = mesh.primitive;
    const collected: number[] = [];

    for (let i = 0; i < primitives.length; i++) {
        const prim = primitives[i];
        if (!prim || prim.type !== pc.PRIMITIVE_TRIANGLES || prim.count < 3) {
            continue;
        }
        const count = (prim.count / 3) * 3;
        if (prim.indexed !== false && hasIndices) {
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

function extractIndexedData(positions: ArrayLike<number>, indices: ArrayLike<number> | null): IOccluderMesh {
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
