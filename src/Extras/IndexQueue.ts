import { IndexManager } from "./IndexManager";
import { IndexQueueEx } from "./IndexQueueEx";

export class IndexQueue extends IndexQueueEx {

    constructor(capaticty: number = 512, extraSize: number = 0, uint32: boolean = true) {
        super(new IndexManager(capaticty, uint32), extraSize);
    }

    public resize(count: number): void {
        this.indexManager.resize(count);
        this.resizeIndexes();
    }

    public reserve(): number {
        return this.indexManager.reserve();
    }

    public free(index: number): void {
        this.indexManager.free(index);
    }
}