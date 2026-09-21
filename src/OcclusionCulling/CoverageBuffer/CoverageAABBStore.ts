import { AbsAABBStore } from "../../Extras/AbsAABBStore.js";

/**
 * CPU-only AABB pool for coverage testers (no GPU textures).
 */
export class CoverageAABBStore extends AbsAABBStore {

    private _centers: Float32Array;
    private _halves: Float32Array;

    public get centersData() { return this._centers; }
    public get halfExtentsData() { return this._halves; }

    public constructor(capacity: number) {
        super(capacity);
        this._centers = new Float32Array(capacity << 2);
        this._halves = new Float32Array(capacity << 2);
    }

    public update(): void {
        // CPU-only.
    }

    public destroy(): void {
        this._centers = new Float32Array(0);
        this._halves = new Float32Array(0);
    }

    protected _resizeStorage(newCapacity: number): void {
        const floats = newCapacity << 2;
        const centers = new Float32Array(floats);
        const halves = new Float32Array(floats);
        centers.set(this._centers.subarray(0, Math.min(this._centers.length, floats)));
        halves.set(this._halves.subarray(0, Math.min(this._halves.length, floats)));
        this._centers = centers;
        this._halves = halves;
    }
}
