import pc from "../../engine.js";

/**
 * Fences behind the frames already recorded.
 *
 * On ANGLE/D3D11 `getBufferSubData` maps the buffer and waits for every
 * command already recorded, not only the copy it reads. A copy while that
 * work is still on the GPU drains it right before PlayCanvas opens its GPU
 * timer, and the timer then counts the GPU idling while the CPU records the
 * next frame. A slot is read only once a fence inserted after its copy has
 * signaled, so the copy itself is done.
 *
 * {@link seal} inserts the fence in a microtask: after the rest of the current
 * task — every later `frameend` listener included — and before the browser
 * composites. No `gl.flush()`: on Android GLES a flush mid-frame often stalls,
 * and the fence reaches the GPU with the end of the frame anyway.
 *
 * Chromium does not report that fence on the next frame. The commands are
 * flushed with the frame that follows, and `SYNC_STATUS` comes back a frame
 * after that, so the fence signals on the `frameRender` two frames later.
 * Each fence stays until then. Replacing it with the next frame's fence would
 * drop the only one Chromium is about to signal, and nothing would be read.
 *
 * WebGL only updates `SYNC_STATUS` between tasks, and Chromium issues one
 * real query per task. {@link signaledFrame} polls the oldest open fence
 * once; call it once per frame.
 */

/** Open fences. Past this the oldest is dropped; a later one still covers its frame. */
const FRAME_FENCE_LIMIT = 8;

interface FrameFence {
    sync: WebGLSync;
    frame: number;
}

export class WebglFrameFence {

    private _device: pc.WebglGraphicsDevice;
    private _fences: FrameFence[] = [];
    private _signaledFrame = -1;
    private _sealFrame = -1;
    private _sealScheduled = false;
    private _destroyed = false;
    private _sealTask: () => void;

    /** @param device - WebGL2 device */
    constructor(device: pc.WebglGraphicsDevice) {
        this._device = device;
        this._sealTask = () => this._insert();
    }

    /** Fence frame `frameId` once the current task is done. Repeat calls before then are ignored. */
    public seal(frameId: number): void {
        if (this._destroyed || this._sealScheduled) {
            return;
        }
        this._sealScheduled = true;
        this._sealFrame = frameId;
        queueMicrotask(this._sealTask);
    }

    /**
     * Newest frame whose fence has signaled, or `-1`. Polls the oldest open
     * fence once. A later signaled fence means every earlier frame is done too.
     */
    public signaledFrame(): number {
        const gl = this._device.gl;
        const oldest = this._fences[0];
        if (!gl || this._device.isContextLost()) {
            return -1;
        }
        if (oldest && gl.getSyncParameter(oldest.sync, gl.SYNC_STATUS) === gl.SIGNALED) {
            this._signaledFrame = oldest.frame;
            this._fences.shift();
            gl.deleteSync(oldest.sync);
        }
        return this._signaledFrame;
    }

    /** The sync ids died with the context. Deleting them is invalid. */
    public onDeviceLost(): void {
        this._fences.length = 0;
        this._signaledFrame = -1;
        this._sealScheduled = false;
    }

    public destroy(): void {
        this._destroyed = true;
        this._deleteFences();
    }

    private _insert(): void {
        this._sealScheduled = false;
        const gl = this._device.gl;
        if (this._destroyed || !gl || this._device.isContextLost()) {
            return;
        }

        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (!sync) {
            return;
        }

        while (this._fences.length >= FRAME_FENCE_LIMIT) {
            const dropped = this._fences.shift();
            if (dropped) {
                gl.deleteSync(dropped.sync);
            }
        }
        this._fences.push({ sync, frame: this._sealFrame });
    }

    private _deleteFences(): void {
        const fences = this._fences;
        this._fences = [];
        this._signaledFrame = -1;
        const gl = this._device.gl;
        if (!gl || this._device.isContextLost()) {
            return;
        }
        for (let i = 0; i < fences.length; i++) {
            gl.deleteSync(fences[i].sync);
        }
    }
}
