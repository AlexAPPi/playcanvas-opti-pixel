import pc from "../engine.js";
import { ILODLevel } from "./ILODLevel.js";
import { FadeTimeLODState } from "./FadeTimeLODState.js";
import { ILODState } from "./ILODState.js";
import { InstancesFlags } from "./InstancesFlags.js";
import BasicHierarchicalInstancer, { IBasicHierarchicalInstancerParams } from "./BasicHierarchicalInstancer.js";

export type TOnFrustumEnter = (index: number, camera: pc.Camera, level: number, distance: number) => void;
export type TOnFrustumEnterThenUpdate = (index: number, camera: pc.Camera, level: number, distance: number) => boolean | void;

export interface ISimpleHierarchicalInstancerParams extends IBasicHierarchicalInstancerParams {

    /**
     * Time at which the LOD disappears before switching to another LOD.
     * @default 0.25
     */
    lodFadeTime?: number;
}

export class SimpleHierarchicalInstancer extends BasicHierarchicalInstancer {

    protected _instancesFlags: InstancesFlags;
    protected _fadeTimeLODState: FadeTimeLODState;

    /**
     * Time at which the LOD disappears before switching to another LOD.
     */
    public lodFadeTime: number;

    /**
     * The number of active instances.
     */
    public get instancesCount(): number { return this.capacity; }

    /**
     * The number of active instances array.
     */
    public get instancesArrayCount() { return this.capacity; }

    public constructor(device: pc.GraphicsDevice, params: ISimpleHierarchicalInstancerParams = {}) {

        const { lodFadeTime = 0.25 } = params;

        super(device, params);

        this.lodFadeTime = lodFadeTime;

        // State
        this._instancesFlags = new InstancesFlags(this.capacity);
        this._fadeTimeLODState = new FadeTimeLODState(this.capacity);
    }

    public override resize(newCapacity: number): void {
        const oldCapacity = this.capacity;
        super.resize(newCapacity);
        if (oldCapacity === newCapacity) {
            return;
        }
        this._instancesFlags?.resize(newCapacity);
        this._fadeTimeLODState?.resize(newCapacity);
    }

    public applySortingIfNeeded(): void {
        this._initOrDisposeSorterIfNeed(this.LODs);        
    }

    public addLOD(meshInstanceList: pc.MeshInstance[] | null, root: pc.Entity | null, distance: number = 0, hysteresis: number = 0) {
        super.addLOD(meshInstanceList, root, distance, hysteresis);
        this._setLodStateToMax(this.LODs);
    }

    protected _setLodStateToMax(lods: ILODLevel[]) {
        // set default last lod with render
        for (let index = lods.length - 1; index > -1; index--) {
            if (lods[index].render) {
                this._fadeTimeLODState.setLodsAll(index, index, true);
                break;
            }
        }
    }

    /**
     * Sets the visibility of a specific instance.
     * @param id The index of the instance.
     * @param visible Whether the instance should be visible.
     */
    public setVisibilityAt(id: number, visible: boolean): void {
        this._instancesFlags.setVisibility(id, visible);
    }

    /**
     * Gets the visibility of a specific instance.
     * @param id The index of the instance.
     * @returns Whether the instance is visible.
     */
    public getVisibilityAt(id: number): boolean {
        return this._instancesFlags.getVisibility(id);
    }

    /**
     * Sets the availability of a specific instance.
     * @param id The index of the instance.
     * @param active Whether the instance is active (not deleted).
     */
    public setActiveAt(id: number, active: boolean): void {
        this._instancesFlags.setActive(id, active);
    }

    /**
     * Gets the availability of a specific instance.
     * @param id The index of the instance.
     * @returns Whether the instance is active (not deleted).
     */
    public getActiveAt(id: number): boolean {
        return this._instancesFlags.getActive(id);
    }

    /**
     * Set if a specific instance is visible and active.
     * @param id The index of the instance.
     * @param value Whether the instance is active and active (not deleted).
     */
    public setActiveAndVisibilityAt(id: number, value: boolean): void {
        this._instancesFlags.setActiveAndVisibility(id, value);
    }

    /**
     * Indicates if a specific instance is visible and active.
     * @param id The index of the instance.
     * @returns Whether the instance is visible and active.
     */
    public getActiveAndVisibilityAt(id: number): boolean {
        return this._instancesFlags.getActiveAndVisibility(id);
    }

    public frustumCulling(camera: pc.Camera, cameraPosition: pc.Vec3, onFrustumEnter: TOnFrustumEnter) {

        const lods = this.LODs;
        const count = this.instancesArrayCount;

        for (let index = 0; index < count; index++) {

            if (!this.getActiveAndVisibilityAt(index)) continue;

            const maxScale = this.getPositionAndMaxScaleOnAxisAt(index, _sphere.center);
            const relativeCenterOfCamera = _vec31.sub2(_sphere.center, cameraPosition);
            const distance = relativeCenterOfCamera.lengthSq();
            const level = this.getObjectLODIndexForDistance(lods, distance);

            _sphere.radius = maxScale;

            if (camera.frustum.containsSphere(_sphere) > 0) {

                onFrustumEnter(index, camera, level, distance);
            }
        }
    }

    public update(dt: number, camera: pc.Camera, cameraPosition: pc.Vec3, onFrustumEnter?: TOnFrustumEnterThenUpdate) {
        this._beforeUpdateRenders(dt);
        this._updateRenders(camera, cameraPosition, onFrustumEnter);
        this._afterUpdateRenders(dt);
    }

    protected _checkAndGetRelativePosition(index: number, frustum: pc.Frustum, cameraPosition: pc.Vec3, outRelativePosition: pc.Vec3) {

        if (this.getActiveAndVisibilityAt(index)) {

            // For non centered
            this.applyMatrixAtToSphere(index, _sphere, this._instanceAABBCenter, this._instanceAABBRadius);

            // For centered
            //const maxScale = this.getPositionAndMaxScaleOnAxisAt(i, _sphere.center);
            //_sphere.radius = this._instanceAABBRadius * maxScale;

            if (frustum.containsSphere(_sphere) > 0) {

                outRelativePosition.sub2(_sphere.center, cameraPosition);
                return true;
            }
        }

        return false;
    }

    protected _updateRenders(camera: pc.Camera, cameraPosition: pc.Vec3, onFrustumEnter?: TOnFrustumEnterThenUpdate) {

        const lods = this.LODs;
        const frustum = camera.frustum;

        const time = this._time;
        const lodFadeTime = this.lodFadeTime;
        const count = this.instancesArrayCount;
        const relativeCenterOfCamera = _vec31;

        // Need sort objects
        const depthStore = this._sharedDepthStore;
        const sortObjects = this._sortObjectsInStep && this._sortObjects && depthStore;
        const fadeTimeLODState = this._fadeTimeLODState;

        let minIndex = count;
        let maxIndex = 0;
        let minDistance =  Infinity;
        let maxDistance = -Infinity;

        for (let index = 0; index < count; index++) {

            if (this._checkAndGetRelativePosition(index, frustum, cameraPosition, relativeCenterOfCamera)) {

                const distance = relativeCenterOfCamera.lengthSq();
                const targetLevel = this.getObjectLODIndexForDistance(lods, distance);
                const lodState = fadeTimeLODState.get(index, targetLevel, time, lodFadeTime, _lodState);

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
        }

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
}

export default SimpleHierarchicalInstancer;

const _sphere = new pc.BoundingSphere();
const _vec31 = new pc.Vec3();
const _lodState: ILODState = {
    current: 0,
    next: 0,
    weight: 1,
    nextWeight: 0
};