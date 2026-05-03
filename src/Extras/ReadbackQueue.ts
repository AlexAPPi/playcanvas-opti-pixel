export interface IReadbackQueueItemReader {
    count: number;
    lock: boolean;
    abortRead(): void;
    resize(): void;
    clear(): void;
    destroy(): void;
}

export abstract class ReadbackQueue<TReader extends IReadbackQueueItemReader> {

    private _readers: TReader[] = [];
    private _freeReaders: TReader[] = [];
    private _usedReaders: TReader[] = [];
    private _tmpReader: TReader | null = null;
    private _finishedReader: TReader | null = null;

    private _freeToUsedRatio: number = 2;
    private _historyLength: number = 60 * 3; // ~ 3 sec (60 frames/sec)

    private _avgUsed: number = 0;
    private _alpha: number = 0;
    private _targetFree: number = 0;

    public get avgUsed() { return this._avgUsed; }
    public get targetFree() { return this._targetFree; }
    public get allCount() { return this._readers.length; }
    public get usedCount() { return this._usedReaders.length; }
    public get freeCount() { return this._freeReaders.length; }

    public get actual() { return this._tmpReader; }
    public get finished() { return this._finishedReader; }

    public get freeToUsedRatio() { return this._freeToUsedRatio; }
    public set freeToUsedRatio(value: number) {
        this._freeToUsedRatio = value;
    }

    public get historyLength() { return this._historyLength; }
    public set historyLength(value: number) {
        this._historyLength = value;
        this._alpha = 2 / (this._historyLength + 1);
    }

    public constructor(freeToUsedRatio: number = 2, historyLength: number = 60 * 3) {
        this.freeToUsedRatio = freeToUsedRatio;
        this.historyLength = historyLength;
    }

    private _optimizationOfConsumedResources() {

        // Stabilize the size, clean up unnecessary state holders
        const used = this._readers.length - this._freeReaders.length;

        if (this._avgUsed === 0) {
            this._avgUsed = used;
        } else {
            this._avgUsed += this._alpha * (used - this._avgUsed);
        }

        this._targetFree = Math.floor(this._freeToUsedRatio * Math.max(used, this._avgUsed));

        this.shrinkFreePool(this._targetFree);
    }

    protected abstract _createReader(): TReader;

    public destroy() {
        this.free();
    }

    public resize() {

        for (let i = 0; i < this._readers.length; i++) {
            const state = this._readers[i];
            if (state) {
                state.resize();
            }
        }
    }

    public free() {

        for (let i = 0; i < this._readers.length; i++) {
            const reader = this._readers[i];
            if (reader) {
                reader.destroy();
            }
        }

        this._readers.length = 0;
        this._freeReaders.length = 0;
        this._usedReaders.length = 0;
    }

    public shrinkFreePool(maxFreeCount: number = 5) {
        while (this._freeReaders.length > maxFreeCount) {
            const reader = this._freeReaders.shift();
            if (reader) {
                reader.destroy();
                const index = this._readers.indexOf(reader);
                if (index > -1) {
                    this._readers.splice(index, 1);
                }
            }
        }
    }

    public frameUpdate() {

        for (let i = this._usedReaders.length - 1; i > -1; i--) {

            const reader = this._usedReaders[i];

            if (!reader.lock) {

                this._finishedReader = reader;

                // Skip test for prev frames states
                if (i > 0) {

                    for (let j = 0; j < i; j++) {

                        this._freeReaders.push(this._usedReaders[j]);
                        this._usedReaders[j].abortRead();
                    }

                    this._usedReaders.splice(0, i);
                }

                break;
            }
        }

        this._optimizationOfConsumedResources();
    }

    public next() {

        // Used current for next frame or other
        let update = true;

        const currentReader = this._tmpReader;

        if (currentReader) {

            if (currentReader.count > 0) {
                this._usedReaders.push(currentReader);
            }
            else {
                update = false;
            }
        }

        if (update) {

            // Take reader from free and use for next frame
            let tmp = this._freeReaders.shift();

            if (!tmp) {
                tmp = this._createReader();
                this._readers.push(tmp);
            }

            this._tmpReader = tmp;
            this._tmpReader.clear();
        }

        return currentReader;
    }
}