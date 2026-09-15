import pc from "../engine.js";
import { AbsAABBStore } from "./AbsAABBStore.js";
import { Vec4F32Texture } from "./Vec4F32DataTexture.js";

export class AABBStore extends AbsAABBStore {

    private _centersStore: Vec4F32Texture;
    private _halfExtentsStore: Vec4F32Texture;

    public readonly device: pc.GraphicsDevice;

    public override get centersTexture() {
        return this._centersStore.texture;
    }

    public override get halfExtentsTexture() {
        return this._halfExtentsStore.texture;
    }

    public override get hasTextures() {
        return this._centersStore.hasTexture && this._halfExtentsStore.hasTexture;
    }

    public get centersData() { return this._centersStore.data; }
    public get halfExtentsData() { return this._halfExtentsStore.data; }

    public constructor(device: pc.GraphicsDevice, capacity: number) {
        super(capacity);
        this.device = device;
        this._centersStore = new Vec4F32Texture(device, capacity);
        this._halfExtentsStore = new Vec4F32Texture(device, capacity);
    }

    public update() {
        this._centersStore.update();
        this._halfExtentsStore.update();
    }

    public destroy() {
        this._centersStore.destroy();
        this._halfExtentsStore.destroy();
    }

    protected _resizeStorage(newCapacity: number) {
        this._centersStore.resize(newCapacity);
        this._halfExtentsStore.resize(newCapacity);
    }

    protected override _writeCenter(index: number, vec: pc.Vec3, extra: number): boolean {
        return this._centersStore.tryEnqueueUpdateVec3(index, vec, extra);
    }

    protected override _writeHalfExtents(index: number, vec: pc.Vec3, extra: number): boolean {
        return this._halfExtentsStore.tryEnqueueUpdateVec3(index, vec, extra);
    }
}
