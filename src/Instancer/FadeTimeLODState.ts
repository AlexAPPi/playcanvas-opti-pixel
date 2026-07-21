import { ILODState } from "./ILODState";

const LOD_MASK = 0x0f;

export class FadeTimeLODState {

    public data: Uint8Array;
    public time: Float32Array;
    public count: number;

    constructor(count: number) {
        this.count = count;
        this.data = new Uint8Array(count);
        this.time = new Float32Array(count);
    }

    public resize(count: number): void {

        if (count === this.count) return;

        const safeDataLen = Math.min(this.data.length, count);
        const safeTimeLen = Math.min(this.time.length, count);
        const prevData = this.data.subarray(0, safeDataLen);
        const prevTime = this.time.subarray(0, safeTimeLen);

        this.count = count;
        this.data = new Uint8Array(count);
        this.time = new Float32Array(count);

        this.data.set(prevData);
        this.time.set(prevTime);
    }

    public setLodsAll(currentLod: number, targetLod: number, skipFade: boolean = true) {

        const lodPacked = ((currentLod & LOD_MASK) << 4) | (targetLod & LOD_MASK);
        const count = this.count;

        for (let index = 0; index < count; index++) {

            this.data[index] = lodPacked;

            if (skipFade) {

                this.time[index] = 0;
            }
        }
    }

    public getCurrentLod(index: number) {
        const packed = this.data[index];
        return (packed >> 4) & LOD_MASK;
    }

    public needFade(index: number, time: number) {

        const storedTime = this.time[index];

        if (storedTime > time) {

            return true;
        }

        return false;
    }

    public set(index: number, currentLod: number, targetLod: number, skipFade: boolean = true) {
        this.data[index] = ((currentLod & LOD_MASK) << 4) | (targetLod & LOD_MASK);
        if (skipFade) {
            this.time[index] = 0;
        }
    }

    public get(
        index: number,
        targetLod: number,
        time: number,
        fadeTime: number,
        out: ILODState
    ): ILODState {

        const packed = this.data[index];

        let currentLod = (packed >> 4) & LOD_MASK;
        let storedTargetLod = packed & LOD_MASK;
        let storedTime = this.time[index];

        // The instance has not been animated for a long time,
        // or there was no animation in the past.
        if (storedTime < time) {

            // Since the update function is not called for elements that fall outside the frustum or occluded,
            // we check whether the animation still needs to play or if the playback time has long since
            // expired and a new LOD should be displayed.
            const elapsed = time - storedTime;

            if (elapsed < fadeTime) {

                if (storedTargetLod !== targetLod) {
                    storedTargetLod = targetLod;
                    storedTime = time + fadeTime;

                    this.data[index] = (currentLod << 4) | (storedTargetLod & LOD_MASK);
                    this.time[index] = storedTime;
                }
            }
        }

        // Animation in progress
        if (storedTime > time) {

            const elapsed = storedTime - time;
            const progress = 1.0 - Math.min(1, Math.max(0, elapsed / fadeTime));
            const w = progress * progress * (3 - 2 * progress);

            out.current = currentLod;
            out.next = storedTargetLod;
            out.weight = 1 - w;
            out.nextWeight = w;
            return out;
        }

        // Update timer
        this.time[index] = time;

        if (targetLod !== currentLod || 
            targetLod !== storedTargetLod) {
            this.data[index] = (targetLod << 4) | targetLod;
        }

        out.current = targetLod;
        out.next = null;
        out.weight = 1;
        out.nextWeight = 0;
        return out;
    }
}