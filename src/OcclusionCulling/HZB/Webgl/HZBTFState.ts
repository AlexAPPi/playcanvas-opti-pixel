import { GPUIndexQueue } from "../../../Extras/GPUIndexQueue.js";
import { IndexManager } from "../../../Extras/IndexManager.js";
import pc from "../../../engine.js";
import { TFState } from "../../../GPUReadback/Webgl/TFState.js";

/**
 * HZB transform-feedback slot: AABB index queue + uint flags output + the
 * shared WebGL2 PBO/fence readback in {@link TFState}.
 */
export class HZBTFState extends TFState {

    public indexQueue: GPUIndexQueue;
    public packed: Uint32Array;

    public get count() { return this.indexQueue.count; }

    constructor(device: pc.WebglGraphicsDevice, indexManager: IndexManager) {
        super(device, indexManager.capacity, "uint32");
        this.indexQueue = new GPUIndexQueue(device, indexManager, false, 0);
        this.packed = new Uint32Array(this.indexQueue.capacity);
    }

    public override destroy() {
        super.destroy();
        this.indexQueue?.destroy();
        this.indexQueue = null!;
        this.packed = null!;
    }

    public enqueue(index: number, extra?: number | number[]): number {
        return this.indexQueue.enqueue(index, extra);
    }

    public override beforeFill(): void {
        this.indexQueue.update();
        super.beforeFill();
    }
}
