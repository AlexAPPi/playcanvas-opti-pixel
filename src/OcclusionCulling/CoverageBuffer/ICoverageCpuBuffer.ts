export interface ICoverageCpuBuffer {
    readonly width: number;
    readonly height: number;
    readonly depth: Float32Array;
    readonly valid: boolean;
    readonly farClip: number;
    bind(bus: ArrayBuffer, out: ArrayBuffer): void;
    update(): void;
    test(): void;
}
