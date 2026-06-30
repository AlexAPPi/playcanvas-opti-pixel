const enum Flags {
    Active  = 1,
    Visible = 2,
    ActiveAndVisible = Active | Visible
}

export class InstancesFlags {

    public data: Uint8Array;

    constructor(count: number) {
        this.data = new Uint8Array(count);
    }

    public resize(count: number): void {

        if (count === this.data.length) return;

        const safeDataLen = Math.min(this.data.length, count);
        const prevData = this.data.subarray(0, safeDataLen);

        this.data = new Uint8Array(count);
        this.data.set(prevData);
    }

    public getActive(index: number): boolean {
        const flags = this.data[index];
        return (flags & Flags.Active) !== 0;
    }

    public setActive(index: number, value: boolean): void {
        if (value) this.data[index] |= Flags.Active;
        else       this.data[index] &= ~Flags.Active
    }

    public getVisibility(index: number): boolean {
        const flags = this.data[index];
        return (flags & Flags.Visible) !== 0;
    }

    public setVisibility(index: number, value: boolean): void {
        if (value) this.data[index] |= Flags.Visible;
        else       this.data[index] &= ~Flags.Visible;
    }

    public getActiveAndVisibility(index: number): boolean {
        const flags = this.data[index];
        return (flags & Flags.ActiveAndVisible) === Flags.ActiveAndVisible;
    }

    public setActiveAndVisibility(index: number, value: boolean): void {
        if (value) this.data[index] |= Flags.ActiveAndVisible;
        else       this.data[index] &= ~Flags.ActiveAndVisible;
    }
}