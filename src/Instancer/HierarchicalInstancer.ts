import pc from "../engine.js";
import { BVHParams, InstancedMeshBVH } from "./InstancedMeshBVH.js";
import SimpleHierarchicalInstancer, { ISimpleHierarchicalInstancerParams, TOnFrustumEnter, TOnFrustumEnterThenUpdate } from "./SimpleHierarchicalInstancer.js";

export class HierarchicalInstancer extends SimpleHierarchicalInstancer {

    public bvh: InstancedMeshBVH<number, Float32Array<ArrayBuffer>> | undefined;
    public autoUpdateBVH: boolean = true;

    public constructor(device: pc.GraphicsDevice, params: ISimpleHierarchicalInstancerParams = {}) {
        super(device, params);
    }

    /**
     * Creates and computes the BVH (Bounding Volume Hierarchy) for the instances.
     * It's recommended to create it when all the instance matrices have been assigned.
     * Once created it will be updated automatically.
     * @param config Optional configuration parameters object. See `BVHParams` for details.
     */
    public computeBVH(config: BVHParams = {}): void {
        this.bvh ??= new InstancedMeshBVH(this, Float32Array, config.margin, config.getBBoxFromBSphere, config.accurateCulling);
        this.bvh.clear();
        this.bvh.create();
    }

    /**
     * Disposes of the BVH structure.
     */
    public disposeBVH(): void {
        this.bvh = null!;
    }

    /**
     * Sets the local transformation matrix for a specific instance.
     * @param id The index of the instance.
     * @param matrix A `Mat4` representing the local transformation to apply to the instance.
     */
    public override setMatrixAt(id: number, matrix: pc.Mat4): void {
        super.setMatrixAt(id, matrix);
        if (this.bvh && this.autoUpdateBVH) {
            this.bvh.move(id);
        }
    }

    protected override _updateRenders(camera: pc.Camera, cameraPosition: pc.Vec3, onFrustumEnter?: TOnFrustumEnterThenUpdate) {

        if (!this.bvh) {
            super._updateRenders(camera, cameraPosition, onFrustumEnter);
            return;
        }

        let minIndex = this.instancesArrayCount;
        let maxIndex = 0;
        let minDistance =  Infinity;
        let maxDistance = -Infinity;

        const lods = this.LODs;
        const frustum = camera.frustum;

        const time = this._time;
        const lodFadeTime = this.lodFadeTime;

        // Need sort objects
        const sortObjects = this._sortObjectsInStep && this._sortObjects;
        const depthStore = this._sharedDepthStore!;
        const fadeTimeLODState = this._fadeTimeLODState;

        this.bvh?.frustumCullingLOD(frustum, cameraPosition, lods, (node, level, min, max) => {

            const index = node.object;

            // we don't check if active because we remove inactive instances from BVH
            if (this.getVisibilityAt(index)) {

                let distance: number;

                if (level === null || sortObjects) {

                    // distance can be get by BVH, but is not the distance from center
                    const pos = this.getPositionAt(index, _tempVec31);
                    const tmp = _tempVec32.sub2(pos, cameraPosition);

                    distance = tmp.lengthSq();
                    level = this.getObjectLODIndexForDistance(lods, distance);
                }
                else {
                    distance = min;
                }

                fadeTimeLODState.get(index, level, time, lodFadeTime, lodState);

                const currentLod = lods[lodState.current];
                const currentLodRender = currentLod.render;

                if (!onFrustumEnter || onFrustumEnter(index, camera, lodState.current, distance)) {

                    if (sortObjects) {

                        // add 0.05 for safe off negative
                        depthStore[index] = distance + 0.05;

                        if (minDistance > distance) minDistance = distance;
                        if (maxDistance < distance) maxDistance = distance;
                        if (minIndex > index) minIndex = index;
                        if (maxIndex < index) maxIndex = index;
                    }

                    currentLodRender?.enqueue(index, lodState.weight);

                    if (lodState.next !== null) {

                        lods[lodState.next].render?.enqueue(index, lodState.nextWeight);
                    }
                }
            }
        });

        if (sortObjects) {

            // We fill depth buffer by distances
            // Now need convert distance to depth
            // Diff minDistance
            const from = minIndex;
            const to   = maxIndex + 1;
            for (let i = from; i < to; i++) {
                depthStore[i] -= minDistance;
            }
        }
    }

    public override frustumCulling(camera: pc.Camera, cameraPosition: pc.Vec3, onFrustumEnter: TOnFrustumEnter) {

        if (!this.bvh) {
            super.frustumCulling(camera, cameraPosition, onFrustumEnter);
        }

        const lods = this.LODs;

        this.bvh?.frustumCullingLOD(camera.frustum, cameraPosition, lods, (node, level, min, max) => {

            const index = node.object;

            if (this.getActiveAndVisibilityAt(index)) {

                let distance: number;

                if (level === null) {

                    // distance can be get by BVH, but is not the distance from center
                    const pos = this.getPositionAt(index, _tempVec31);
                    const tmp = _tempVec32.sub2(pos, cameraPosition);

                    distance = tmp.lengthSq();
                    level = this.getObjectLODIndexForDistance(lods, distance);
                }
                else {
                    distance = min;
                }

                onFrustumEnter(index, camera, level, distance);
            }
        });
    }
}

const _tempVec31 = new pc.Vec3();
const _tempVec32 = new pc.Vec3();
const lodState = {
    current: 0,
    next: 0,
    weight: 1,
    nextWeight: 0
};