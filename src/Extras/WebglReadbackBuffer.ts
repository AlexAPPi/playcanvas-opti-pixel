import pc from "../engine.js";

export class WebglReadbackBuffer<TData extends ArrayBufferView<ArrayBuffer>> extends pc.VertexBuffer {

    public declare device: pc.WebglGraphicsDevice;
    public readonly storageData: TData;

    private _lengthFactor: number = 1;
    private _itemByteSize: number = 1;
    private _syncObject: WebGLSync | null = null;
    private _beginReadLength: number = 0;
    private _beginReadTime: number = 0;

    private _handleOnDeviceDestroy: pc.EventHandle;
    private _handleOnDeviceContextLost: pc.EventHandle;

    public get beginReadTime() { return this._beginReadTime; }
    
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

        this._handleOnDeviceDestroy = this.device.on("destroy", this.destroy, this);
        this._handleOnDeviceContextLost = this.device.on("contextlost", this._onContextLost, this);
    }

    protected _onContextLost() {
        this.deleteBuf();
        this.deleteSync();
    }

    public deleteBuf() {
        let bufferId = this.impl.bufferId;
        if (bufferId) {
            this.impl.bufferId = undefined;
            const gl = this.device.gl;
            gl?.deleteBuffer(bufferId);
        }
    }

    public deleteSync() {

        // dispose
        if (this._syncObject) {

            const gl = this.device.gl;
            const syncObject = this._syncObject;
            this._syncObject = null;

            gl?.deleteSync(syncObject);
        }
    }

    public abortRead() {
        this.deleteBuf();
        this.deleteSync();
    }

    public destroy() {

        this._handleOnDeviceDestroy?.off();
        this._handleOnDeviceContextLost?.off();

        this.deleteSync();
        this.deleteBuf();
        super.destroy();
    }

    protected _fenceSync() {

        const gl = this.device.gl;
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);

        gl.flush();

        return sync;
    }

    protected _readBuffer(length: number) {

        const safeStorageLength = Math.floor(this.storageData.byteLength / this._itemByteSize);
        const safeLength = Math.min(length, safeStorageLength);
        const safeGetLength = safeLength * this._lengthFactor;
        const bufferId = this.impl.bufferId;

        const gl = this.device.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, bufferId);
        gl.getBufferSubData(gl.ARRAY_BUFFER, 0, this.storageData, 0, safeGetLength);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        // Delete buffer
        this.impl.bufferId = null;
        gl.deleteBuffer(bufferId);

        return safeLength;
    }

    public beginRead(length: number) {

        if (this._syncObject) {
            throw new Error("Reading started earlier");
        }

        this._beginReadLength = length;
        this._beginReadTime = performance.now();

        // Skip empty read
        if (length > 0) {
            this._syncObject = this._fenceSync();
        }
    }

    public zeroSync(): number {

        if (!this._syncObject) {
            throw new Error("Reading not started");
        }

        const gl = this.device.gl;
        const res = gl.clientWaitSync(this._syncObject, 0, 0);

        if (res === gl.WAIT_FAILED) {
            this.deleteSync();
        }

        return res;
    }

    public read() {

        // If empty read
        if (this._beginReadLength > 0) {
            return this._readBuffer(this._beginReadLength);
        }

        return 0;
    }

    public clear(): void {

        this.deleteSync();
        this.deleteBuf();

        const gl = this.device.gl;
        const byteSize = this.storage.byteLength;

        let bufferId = this.impl.bufferId;

        if (!bufferId) {
            bufferId = gl.createBuffer();
            this.impl.bufferId = bufferId;
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, bufferId);
        gl.bufferData(gl.ARRAY_BUFFER, byteSize, gl.STREAM_READ);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    public override unlock(): void {
        this.clear();
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