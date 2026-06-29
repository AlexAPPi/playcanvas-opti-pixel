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
    public fadeStartTime: Float32Array;
    public lastViewTime: Float32Array;
    public count: number;

    constructor(count: number) {
        this.count = count;
        this.data = new Uint8Array(count * this.stride);
        this.fadeStartTime = new Float32Array(count);
        this.lastViewTime = new Float32Array(count);
    }

    public resize(count: number): void {

        if (count === this.count) return;

        const safeDataLen = Math.min(this.data.length, count * this.stride);
        const safeTimeLen = Math.min(this.fadeStartTime.length, count);
        const prevData = this.data.subarray(0, safeDataLen);
        const prevTime = this.fadeStartTime.subarray(0, safeTimeLen);

        this.count = count;
        this.data = new Uint8Array(count * this.stride);
        this.fadeStartTime = new Float32Array(count);
        this.lastViewTime = new Float32Array(count);

        this.data.set(prevData);
        this.fadeStartTime.set(prevTime);
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
                this.fadeStartTime[index] = 0;
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

        const prevViewTime = this.lastViewTime[index];
        this.lastViewTime[index] = time;

        if (time - prevViewTime >= fadeTime) {
            this.fadeStartTime[index] = 0;
            this.data[lodPtr] = ((targetLod & LOD_MASK) << 4) | (targetLod & LOD_MASK);
            out.current = targetLod;
            out.next = null;
            out.weight = 1;
            out.nextWeight = 0;
            return;
        }

        const packed = this.data[lodPtr];
        let current = (packed >> 4) & LOD_MASK;
        let storedTarget = packed & LOD_MASK;

        const storedTime = this.fadeStartTime[index];
        const isFading = storedTime > 0;

        if (!isFading) {

            if (current !== targetLod) {
                storedTarget = targetLod;
                this.data[lodPtr] = ((current & LOD_MASK) << 4) | (storedTarget & LOD_MASK);
                this.fadeStartTime[index] = time;
            }
            else {
                out.current = current;
                out.next = null;
                out.weight = 1;
                out.nextWeight = 0;
                return;
            }
        }
        else if (storedTarget !== targetLod) {
            storedTarget = targetLod;
            this.data[lodPtr] = ((current & LOD_MASK) << 4) | (storedTarget & LOD_MASK);
            this.fadeStartTime[index] = time;
        }

        const nowStoredTime = this.fadeStartTime[index];

        if (nowStoredTime > 0) {

            const t = Math.max(0, (time - nowStoredTime) / fadeTime);

            if (t >= 1) {
                this.fadeStartTime[index] = 0;
                this.data[lodPtr] = ((storedTarget & LOD_MASK) << 4) | (storedTarget & LOD_MASK);
                out.current = storedTarget;
                out.next = null;
                out.weight = 1;
                out.nextWeight = 0;
                return;
            }

            const w = t * t * (3 - 2 * t);
            out.current = current;
            out.next = storedTarget;
            out.weight = 1 - w;
            out.nextWeight = w;
            return;
        }

        out.current = current;
        out.next = null;
        out.weight = 1;
        out.nextWeight = 0;
    }
}