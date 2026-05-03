import pc from "../engine.js";

export class WebglReadbackBuffer<TData extends ArrayBufferView<ArrayBuffer> = Uint8Array<ArrayBuffer>> extends pc.VertexBuffer {

    public declare device: pc.WebglGraphicsDevice;
    public readonly storageData: TData;

    private _lengthFactor: number = 1;
    private _itemByteSize: number = 1;
    private _version: number = 0;

    constructor(device: pc.WebglGraphicsDevice, capacity: number, itemByteSize: number = 4, arrayOrConstructor: TData | ArrayConstructorOf<TData>) {

        const data = tryCreateStorage(arrayOrConstructor, capacity, itemByteSize) ?? (new Uint8Array(capacity * itemByteSize) as unknown as TData);
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
    }

    public abortRead() {
        this._version++;
    }

    public destroy() {
        this.abortRead();
        super.destroy();
    }

    private async _clientWaitAsync(currentVersion: number, flags: number, interval: number): Promise<boolean> {

        const gl = this.device.gl;
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!;
        const self = this;

        gl.flush();

        return new Promise<boolean>((resolve, reject) => {

            let timeoutId: number | undefined;

            function dispose() {

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
                //*
                if (currentVersion !== self._version) {
                    dispose();
                    resolve(false);
                    return;
                }
                //*/

                const res = gl.clientWaitSync(sync, flags, 0);

                if (res === gl.TIMEOUT_EXPIRED) {
                    // check again in a while
                    timeoutId = setTimeout(test, interval);
                    return;
                }

                dispose();

                if (res === gl.WAIT_FAILED) {
                    reject(new Error("webgl clientWaitSync sync failed"));
                } else {
                    resolve(true);
                }
            }

            // timeoutId = setTimeout(test, 0);
            test();
        });
    }

    public async read(length: number) {

        this.abortRead();

        const currentVersion = this._version;
        const ready = await this._clientWaitAsync(currentVersion, 0, 16);

        if (ready && currentVersion === this._version) {

            const safeStorageLength = Math.floor(this.storageData.byteLength / this._itemByteSize);
            const safeLength = Math.min(length, safeStorageLength);
            const safeGetLength = safeLength * this._lengthFactor;

            const gl = this.device.gl;
            gl.bindBuffer(gl.ARRAY_BUFFER, this.impl.bufferId);
            gl.getBufferSubData(gl.ARRAY_BUFFER, 0, this.storageData, 0, safeGetLength);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
            return safeLength;
        }

        return 0;
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