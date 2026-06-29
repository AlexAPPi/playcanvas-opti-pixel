export interface ILodUpdateResult {
    current: number;
    next: number | null;
    weight: number;
    nextWeight: number;
}

const enum StateOffset {
    Flags = 0,
    CurrentLod = 1,
    TargetLod = 2,
    FadeT = 3,
}

const enum Flags {
    Active  = 1,
    Visible = 2,
    ActiveAndVisible = Active | Visible,
    LodStateFading = 1 << 2,
}

export class InstancesState {

    public readonly stride = 4;

    public data: Uint8Array;
    public count: number;

    constructor(count: number) {
        this.count = count;
        this.data = new Uint8Array(count * this.stride);
    }

    public resize(count: number): void {
        if (count === this.count) return;
        const safeLen = Math.min(this.data.length, count);
        const prevData = this.data.subarray(0, safeLen);
        this.count = count;
        this.data = new Uint8Array(count * this.stride);
        this.data.set(prevData);
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
        if (value) {
            this.data[offset] |= Flags.Active;
        }
        else {
            this.data[offset] &= ~Flags.Active
        }
    }

    public getVisibility(index: number): boolean {
        const flags = this.data[this._base(index) + StateOffset.Flags];
        return (flags & Flags.Visible) !== 0;
    }

    public setVisibility(index: number, value: boolean): void {
        const offset = this._base(index) + StateOffset.Flags;
        if (value) {
            this.data[offset] |= Flags.Visible;
        }
        else {
            this.data[offset] &= ~Flags.Visible;
        }
    }

    public getActiveAndVisibility(index: number): boolean {
        const flags = this.data[this._base(index) + StateOffset.Flags];
        return (flags & Flags.ActiveAndVisible) === Flags.ActiveAndVisible;
    }

    public setActiveAndVisibility(index: number, value: boolean): void {
        const offset = this._base(index) + StateOffset.Flags;
        if (value) {
            this.data[offset] |= Flags.ActiveAndVisible;
        }
        else {
            this.data[offset] &= ~Flags.ActiveAndVisible;
        }
    }

    public getCurrentLod(index: number): number {
        return this.data[this._base(index) + StateOffset.CurrentLod];
    }

    public setCurrentLod(index: number, value: number): void {
        this.data[this._base(index) + StateOffset.CurrentLod] = value;
    }

    public getTargetLod(index: number): number {
        return this.data[this._base(index) + StateOffset.TargetLod];
    }

    public setTargetLod(index: number, value: number): void {
        this.data[this._base(index) + StateOffset.TargetLod] = value;
    }

    public isFading(index: number): boolean {
        const flags = this.data[this._base(index) + StateOffset.Flags];
        return (flags & Flags.LodStateFading) !== 0;
    }

    public setFading(index: number, value: boolean): void {
        const i = this._base(index) + StateOffset.Flags;
        const flags = this.data[i];
        this.data[i] = value ? (flags | Flags.LodStateFading) : (flags & ~Flags.LodStateFading);
    }

    public getFadeValue(index: number): number {
        return this.data[this._base(index) + StateOffset.FadeT];
    }

    public setFadeValue(index: number, value: number): void {
        this.data[this._base(index) + StateOffset.FadeT] = value;
    }

    public reset(index: number, current: number): void {
        const b = this._base(index);
        this.data[b + StateOffset.Flags] = 0;
        this.data[b + StateOffset.CurrentLod] = current;
        this.data[b + StateOffset.TargetLod] = current;
        this.data[b + StateOffset.FadeT] = 0;
    }

    public updateLodState(index: number, targetLod: number, alpha: number, out: ILodUpdateResult): void {

        const b = this._base(index);

        let flags = this.data[b + StateOffset.Flags];
        let current = this.data[b + StateOffset.CurrentLod];
        let target = this.data[b + StateOffset.TargetLod];
        let fadeT = this.data[b + StateOffset.FadeT];

        const isFading = (flags & Flags.LodStateFading) !== 0;

        if (targetLod !== current) {

            if (!isFading || targetLod !== target) {
                target = targetLod;
                flags |= Flags.LodStateFading;
                fadeT = 0;

                this.data[b + StateOffset.TargetLod] = target;
                this.data[b + StateOffset.Flags] = flags;
                this.data[b + StateOffset.FadeT] = fadeT;
            }
        } else {

            if (isFading) {
                flags &= ~Flags.LodStateFading;
                fadeT = 0;

                this.data[b + StateOffset.Flags] = flags;
                this.data[b + StateOffset.FadeT] = fadeT;
            }
        }

        const nowFading = (flags & Flags.LodStateFading) !== 0;

        if (nowFading) {

            const step = Math.round(alpha * 255);
            fadeT = Math.min(255, fadeT + step);
            this.data[b + StateOffset.FadeT] = fadeT;

            if (fadeT >= 255) {

                current = target;
                flags &= ~Flags.LodStateFading;
                this.data[b + StateOffset.CurrentLod] = current;
                this.data[b + StateOffset.Flags] = flags;

                out.current = current;
                out.next = null;
                out.weight = 1;
                out.nextWeight = 0;
                return;
            }

            const x = fadeT / 255;
            const w = x * x * (3 - 2 * x);

            out.current = current;
            out.next = target;
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