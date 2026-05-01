import pc from "../engine.js";

export class WebglReadbackBuffer extends pc.VertexBuffer {

    public declare device: pc.WebglGraphicsDevice;
    public readonly storageData: Uint32Array;

    private _version: number = 0;

    constructor(device: pc.WebglGraphicsDevice, capacity: number) {

        const data = new Uint32Array(capacity);
        const format = new pc.VertexFormat(device, [{
            semantic: pc.SEMANTIC_ATTR6,
            components: 1,
            type: pc.TYPE_UINT32,
            normalize: false,
            asInt: true,
        }]);

        super(device, format, capacity, {
            usage: pc.BUFFER_GPUDYNAMIC,
            data: data.buffer
        });

        this.storageData = data;
    }

    public abortRead() {
        this._version++;
    }

    public destroy() {
        this.abortRead();
        super.destroy();
    }

    private async _clientWaitAsync(currentVersion: number, flags: number, interval_ms: number): Promise<boolean> {

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
                    timeoutId = setTimeout(test, interval_ms);
                    return;
                }

                dispose();
                
                if (res === gl.WAIT_FAILED) {
                    reject(new Error("webgl clientWaitSync sync failed"));
                } else {
                    resolve(true);
                }
            }

            //timeoutId = setTimeout(test, 0);
            test();
        });
    }

    public async read(length: number) {

        this.abortRead();

        const currentVersion = this._version;
        const ready = await this._clientWaitAsync(currentVersion, 0, 16);

        if (ready && currentVersion === this._version) {

            length = Math.min(length, this.storageData.length);

            const gl = this.device.gl;
            gl.bindBuffer(gl.ARRAY_BUFFER, this.impl.bufferId);
            gl.getBufferSubData(gl.ARRAY_BUFFER, 0, this.storageData, 0, length);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
            return length;
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