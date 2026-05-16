import pc from "../../engine.js";

export interface IHierarchicalZBuffer {
    readonly buffers?: pc.Texture[] | undefined;
    readonly texture: pc.Texture | null;
    readonly screenWidth: number;
    readonly screenHeight: number;
    readonly width: number;
    readonly height: number;
    readonly mipLevels: number;
    uvFactor: [number, number];
    enabled: boolean;
    isFloat16(): boolean;
    isFloat32(): boolean;
    isColor(): boolean;
}