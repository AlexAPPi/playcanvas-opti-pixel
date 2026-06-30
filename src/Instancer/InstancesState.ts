export interface ILodUpdateResult {
    current: number;
    next: number | null;
    weight: number;
    nextWeight: number;
}

const enum StateOffset {
    Flags = 0,
    LodPacked = 1,
}

const enum Flags {
    Active  = 1,
    Visible = 2,
    ActiveAndVisible = Active | Visible
}

const LOD_MASK = 0x0f;

export class InstancesState {

    public readonly stride = 2;

    public data: Uint8Array;
    public time: Float32Array;
    public count: number;

    constructor(count: number) {
        this.count = count;
        this.data = new Uint8Array(count * this.stride);
        this.time = new Float32Array(count);
    }

    public resize(count: number): void {

        if (count === this.count) return;

        const safeDataLen = Math.min(this.data.length, count * this.stride);
        const safeTimeLen = Math.min(this.time.length, count);
        const prevData = this.data.subarray(0, safeDataLen);
        const prevTime = this.time.subarray(0, safeTimeLen);

        this.count = count;
        this.data = new Uint8Array(count * this.stride);
        this.time = new Float32Array(count);

        this.data.set(prevData);
        this.time.set(prevTime);
    }

    private _base(index: number): number {
        return index * this.stride;
    }

    public getActive(index: number): boolean {
        const flags = this.data[this._base(index) + StateOffset.Flags];
        return (flags & Flags.Active) !== 0;
    }

    public setActive(index: number, value: boolean): void {
        const offset = this._base(index) + StateOffset.Flags;
        if (value) this.data[offset] |= Flags.Active;
        else       this.data[offset] &= ~Flags.Active
    }

    public getVisibility(index: number): boolean {
        const flags = this.data[this._base(index) + StateOffset.Flags];
        return (flags & Flags.Visible) !== 0;
    }

    public setVisibility(index: number, value: boolean): void {
        const offset = this._base(index) + StateOffset.Flags;
        if (value) this.data[offset] |= Flags.Visible;
        else       this.data[offset] &= ~Flags.Visible;
    }

    public getActiveAndVisibility(index: number): boolean {
        const flags = this.data[this._base(index) + StateOffset.Flags];
        return (flags & Flags.ActiveAndVisible) === Flags.ActiveAndVisible;
    }

    public setActiveAndVisibility(index: number, value: boolean): void {
        const offset = this._base(index) + StateOffset.Flags;
        if (value) this.data[offset] |= Flags.ActiveAndVisible;
        else       this.data[offset] &= ~Flags.ActiveAndVisible;
    }

    public setLodsAll(currentLod: number, targetLod: number, skipFade: boolean = true) {

        const lodPacked = ((currentLod & LOD_MASK) << 4) | (targetLod & LOD_MASK);

        for (let index = 0; index < this.count; index++) {

            const basePtr = this._base(index);

            this.data[basePtr + StateOffset.LodPacked] = lodPacked;

            if (skipFade) {

                this.time[index] = 0;
            }
        }
    }

    public updateLodState(
        index: number,
        targetLod: number,
        time: number,
        fadeTime: number,
        out: ILodUpdateResult
    ): void {

        const basePtr = this._base(index);
        const lodPtr = basePtr + StateOffset.LodPacked;
        const packed = this.data[lodPtr];

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

                    this.data[lodPtr] = (currentLod << 4) | (storedTargetLod & LOD_MASK);
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
            return;
        }

        // Update timer
        this.time[index] = time;

        if (targetLod !== currentLod || 
            targetLod !== storedTargetLod) {
            this.data[lodPtr] = (targetLod << 4) | targetLod;
        }

        out.current = targetLod;
        out.next = null;
        out.weight = 1;
        out.nextWeight = 0;
    }
}