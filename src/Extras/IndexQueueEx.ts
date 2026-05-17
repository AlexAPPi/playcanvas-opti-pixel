import { IndexManager } from "./IndexManager.js";
import { AbsNumberQueue } from "./AbsNumberQueue.js";

export class IndexQueueEx extends AbsNumberQueue<Uint32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>> {

    private _indexManager: IndexManager;

    public get indexes() { return this._store; }
    public get capacity() { return this._indexManager.capacity; }
    public get isUint32() { return this._indexManager.isUint32 }
    public get indexManager() { return this._indexManager; }

    public constructor(indexManager: IndexManager, extraSize: number = 0) {
        super(extraSize, indexManager.capacity, indexManager.isUint32 ? Uint32Array : Uint16Array);
        this._indexManager = indexManager;
    }

    protected _getDefaultExtra(): number {
        // set max uint by default
        return this.indexManager.isUint32 ? 0xffffffff : 0xffff;
    }

    public resizeIndexes() {

        this._resize(
            this.indexManager.capacity,
            this.indexManager.isUint32 ? Uint32Array : Uint16Array
        );
    }
}