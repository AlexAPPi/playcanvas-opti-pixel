import pc from "../engine.js";

export class WebglReadbackBuffer<TData extends ArrayBufferView<ArrayBuffer>> extends pc.VertexBuffer {

    public declare device: pc.WebglGraphicsDevice;
    public readonly storageData: TData;

    private _lengthFactor: number = 1;
    private _itemByteSize: number = 1;
    private _version: number = 0;
    private _syncVersion: number = -1;
    private _syncObject: WebGLSync | null = null;
    private _beginReadLength: number = 0;

    constructor(device: pc.WebglGraphicsDevice, capacity: number, itemByteSize: number = 4, arrayOrConstructor: TData | ArrayConstructorOf<TData>) {

        const data = tryCreateStorage(arrayOrConstructor, capacity, itemByteSize);

        if (!data) {
            throw new Error("Parameter arrayOrConstructor must be type of array or array constructor.");
        }

        const { type, isInt, components, byte } = getVertexFormatOptions(data, itemByteSize);

        const format = new pc.VertexFormat(device, [{
            semantic: pc.SEMANTIC_ATTR6,
            components: components,
            type: type,
            normalize: false,
            asInt: isInt,
        }]);

        super(device, format, capacity, {
            usage: pc.BUFFER_GPUDYNAMIC,
            data: data.buffer
        });

        this._lengthFactor = itemByteSize / byte;
        this._itemByteSize = itemByteSize;
        this.storageData = data;

        this.device.on("destroy", this.destroy, this);
        this.device.on("contextlost", this.abortRead, this);
    }

    public abortRead() {

        this._version++;

        // dispose
        if (this._syncObject) {
            const gl = this.device.gl;
            gl?.deleteSync(this._syncObject);
            this._syncObject = null;
        }
    }

    public destroy() {
        this.abortRead();
        super.destroy();
    }

    protected _fenceSync() {

        const gl = this.device.gl;
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);

        gl.flush();

        return sync;
    }

    protected _clientWaitAsync(currentVersion: number, flags: number, interval: number): Promise<boolean> {

        return new Promise<boolean>((resolve, reject) => {

            const self = this;
            const tmpSync = this._fenceSync();

            if (!tmpSync) {
                reject(new Error("failed fenceSync"));
                return;
            }

            const gl = this.device.gl;
            const sync = tmpSync;

            let timeoutId: number | undefined;

            function disposeTest() {

                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = undefined;
                }

                gl?.deleteSync(sync);
            }

            function test() {

                // Abort prev read
                // Where we can give warn:
                // "performance warning:
                // READ-usage buffer was written,
                // then fenced, but written again before being read back.
                // This discarded the shadow copy that was created to accelerate readback."
                if (currentVersion !== self._version) {
                    disposeTest();
                    resolve(false);
                }
                else {

                    const res = gl.clientWaitSync(sync, flags, 0);

                    // check again in a while
                    if (res === gl.TIMEOUT_EXPIRED) {
                        timeoutId = setTimeout(test, interval);
                    }
                    else {
                        disposeTest();
                        if (res === gl.WAIT_FAILED) {
                            reject(new Error("webgl clientWaitSync sync failed"));
                        }
                        else {
                            resolve(true);
                        }
                    }
                }
            }

            test();
        });
    }

    protected _readBuffer(length: number) {

        const safeStorageLength = Math.floor(this.storageData.byteLength / this._itemByteSize);
        const safeLength = Math.min(length, safeStorageLength);
        const safeGetLength = safeLength * this._lengthFactor;

        const gl = this.device.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.impl.bufferId);
        gl.getBufferSubData(gl.ARRAY_BUFFER, 0, this.storageData, 0, safeGetLength);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        return safeLength;
    }

    public beginRead(length: number) {

        if (this._syncObject) {
            throw new Error("Reading started earlier");
        }

        this.abortRead();
        this._beginReadLength = length;

        // Skip empty read
        if (length > 0) {

            const sync = this._fenceSync();
            this._syncVersion = this._version;
            this._syncObject  = sync;
        }
    }

    public checkRead(): number {

        if (this._syncObject &&
            this._syncVersion === this._version) {

            const gl = this.device.gl;
            const res = gl.clientWaitSync(this._syncObject, 0, 0);

            // result ready
            if (res !== gl.TIMEOUT_EXPIRED) {

                // dispose
                gl.deleteSync(this._syncObject);
                this._syncObject = null;

                // failed read
                if (res === gl.WAIT_FAILED) {
                    return 0;
                }

                return this._readBuffer(this._beginReadLength);   
            }
        }

        // If empty read
        if (this._beginReadLength < 1) {

            return 0;
        }

        return -1;
    }

    public async read(length: number, intervalMs: number = 16) {

        this.abortRead();

        const currentVersion = this._version;
        const success = await this._clientWaitAsync(currentVersion, 0, intervalMs);

        if (!success || currentVersion !== this._version) {
            return 0;
        }

        return this._readBuffer(length);
    }

    public override unlock(): void {

        const gl = this.device.gl;

        let bufferId = this.impl.bufferId;

        if (!bufferId) {

            bufferId = gl.createBuffer();

            // Use READ for transform feedback buffer
            gl.bindBuffer(gl.ARRAY_BUFFER, bufferId);
            gl.bufferData(gl.ARRAY_BUFFER, this.storage, gl.STREAM_READ);

            this.impl.bufferId = bufferId;
        }
        else {
            gl.bindBuffer(gl.ARRAY_BUFFER, bufferId);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.storage);
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
}

export type ArrayConstructorOf<T> = new (buffer: ArrayBuffer, byteOffset?: number, length?: number) => T;

export function tryCreateStorage<TData extends ArrayBufferView<ArrayBuffer> = Uint8Array<ArrayBuffer>>(
    storageOrStorageConstructor: TData | ArrayConstructorOf<TData> | undefined,
    capacity: number,
    itemByteSize: number
): TData | null {

    if (!storageOrStorageConstructor) {
        return null;
    }

    if (typeof storageOrStorageConstructor === "function") {
        const buffer = new ArrayBuffer(capacity * itemByteSize);
        return new storageOrStorageConstructor(buffer);
    }

    return storageOrStorageConstructor;
}

export function getVertexFormatOptions(data: ArrayBufferView, itemByteSize: number) {

    const isInt = !(data instanceof Float32Array || data instanceof Float64Array);

    let byte: number = 0;
    let type: number = 0;

         if (data instanceof Float32Array) { type = pc.TYPE_FLOAT32; byte = data.BYTES_PER_ELEMENT; }
    else if (data instanceof Uint32Array)  { type = pc.TYPE_UINT32;  byte = data.BYTES_PER_ELEMENT; }
    else if (data instanceof Int32Array)   { type = pc.TYPE_INT32;   byte = data.BYTES_PER_ELEMENT; }
    else if (data instanceof Uint16Array)  { type = pc.TYPE_UINT16;  byte = data.BYTES_PER_ELEMENT; }
    else if (data instanceof Int16Array)   { type = pc.TYPE_INT16;   byte = data.BYTES_PER_ELEMENT; }
    else if (data instanceof Uint8Array)   { type = pc.TYPE_UINT8;   byte = data.BYTES_PER_ELEMENT; }
    else if (data instanceof Int8Array)    { type = pc.TYPE_INT8;    byte = data.BYTES_PER_ELEMENT; }
    else {
        throw new Error("Data type unsupported");
    }

    const components = itemByteSize / byte;

    return { type, isInt, components, byte };
}