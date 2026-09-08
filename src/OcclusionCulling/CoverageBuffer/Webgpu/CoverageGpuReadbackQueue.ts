import pc from "../../../engine.js";
import { CoverageGpuReadbackState } from "./CoverageGpuReadbackState.js";

/**
 * In-flight coverage mapAsync pool, same role as WebGL {@link CoverageTFStateQueue}:
 * acquire a slot, compute writes into `slot.outputBuffer`, then {@link submit}
 * copies to a MAP_READ staging buffer. {@link frameUpdate} harvests the newest
 * ready capture. Do not harvest from `coverage.update` / postrender.
 */
export class CoverageGpuReadbackQueue {

    private _device: pc.WebgpuGraphicsDevice;
    private _pixelCount = 0;
    private _slotCount = 1;
    private _minLatencyFrames = 2;
    private _frameId = 0;
    private _submitFrame = -1;
    private _slots: CoverageGpuReadbackState[] = [];
    private _cpuDepth: Float32Array;
    private _cpuVP = new Float32Array(16);
    private _cpuParams = new Float32Array(4);
    private _cpuReady = false;
    private _cpuVersion = 0;

    constructor(device: pc.WebgpuGraphicsDevice, pixelCount: number, slotCount: number = 4) {
        this._device = device;
        this._slotCount = Math.max(1, slotCount | 0);
        this.resize(pixelCount);
    }

    public get frameId() { return this._frameId; }
    public get cpuReady() { return this._cpuReady; }
    public get cpuVersion() { return this._cpuVersion; }
    public get cpuDepth() { return this._cpuDepth; }
    public get cpuViewProjection() { return this._cpuVP; }
    public get cpuCameraParams() { return this._cpuParams; }

    public get minLatencyFrames() { return this._minLatencyFrames; }
    public set minLatencyFrames(value: number) {
        this._minLatencyFrames = Math.max(0, value | 0);
    }

    public get slotCount() { return this._slotCount; }
    public set slotCount(value: number) {
        const next = Math.max(1, value | 0);
        if (next === this._slotCount) {
            return;
        }
        this._slotCount = next;
        this._rebuildSlots();
    }

    public resize(pixelCount: number) {
        this._pixelCount = Math.max(0, pixelCount | 0);
        this._cpuDepth = new Float32Array(this._pixelCount);
        this._cpuDepth.fill(1e10);
        this._cpuReady = false;
        this._cpuVersion++;
        this._submitFrame = -1;
        this._rebuildSlots();
    }

    public destroy() {
        this._disposeSlots();
        this._cpuReady = false;
        this._submitFrame = -1;
    }

    public frameUpdate() {
        this._frameId++;
        this.harvest();
    }

    public harvest() {

        const slots = this._slots;
        let newest = -1;

        for (let i = 0; i < slots.length; i++) {

            const slot = slots[i];
            if (!slot.pending) {
                continue;
            }

            if (this._frameId - slot.submitFrame < this._minLatencyFrames) {
                continue;
            }

            const status = slot.poll();
            if (status === "failed") {
                slot.abortRead();
                continue;
            }

            if (status === "ready" && (newest < 0 || slot.submitFrame > slots[newest].submitFrame)) {
                newest = i;
            }
        }

        if (newest < 0) {
            return;
        }

        const slot = slots[newest];
        const stolen = slot.stealReady(this._cpuDepth);
        if (stolen) {
            this._cpuDepth = stolen;
            this._cpuVP.set(slot.vp);
            this._cpuParams.set(slot.cameraParams);
            this._cpuReady = true;
            this._cpuVersion++;
        }
        else if (slot.read(this._cpuDepth) > 0) {
            this._cpuVP.set(slot.vp);
            this._cpuParams.set(slot.cameraParams);
            this._cpuReady = true;
            this._cpuVersion++;
        }

        for (let i = 0; i < slots.length; i++) {
            const other = slots[i];
            if (other.pending && other.submitFrame <= slot.submitFrame) {
                other.abortRead();
            }
        }
    }

    public acquire(): CoverageGpuReadbackState | null {

        if (this._submitFrame === this._frameId) {
            return null;
        }

        const slots = this._slots;
        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            if (!slot.pending && !slot.unread) {
                return slot;
            }
        }

        return null;
    }

    public submit(slot: CoverageGpuReadbackState, vp: Float32Array, cameraParams: Float32Array): boolean {

        slot.vp.set(vp);
        slot.cameraParams.set(cameraParams);
        slot.submitFrame = this._frameId;
        slot.beginRead();

        if (!slot.pending) {
            return false;
        }

        this._submitFrame = this._frameId;
        return true;
    }

    private _rebuildSlots() {

        this._disposeSlots();

        const n = this._slotCount;
        const pixels = this._pixelCount;
        this._slots = new Array(n);
        for (let i = 0; i < n; i++) {
            this._slots[i] = new CoverageGpuReadbackState(this._device, pixels);
        }
    }

    private _disposeSlots() {
        for (let i = 0; i < this._slots.length; i++) {
            this._slots[i].destroy();
        }
        this._slots.length = 0;
    }
}
