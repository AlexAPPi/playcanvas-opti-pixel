/** One worker pass. Milliseconds. Visible AABBs are `aabbCount - occludedCount`. */
export interface ICoverageCpuJob {
    reprojectMs: number;
    mipMs: number;
    aabbTestMs: number;
    aabbCount: number;
    occludedCount: number;
}

export interface ICoverageCpuBuffer {
    readonly width: number;
    readonly height: number;
    readonly depth: Float32Array;
    readonly valid: boolean;
    readonly farClip: number;
    readonly job: ICoverageCpuJob;
    bind(bus: ArrayBuffer, out: ArrayBuffer): void;
    update(): void;
    test(): void;
}
