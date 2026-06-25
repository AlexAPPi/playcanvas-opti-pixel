import { SquareDataTexture } from "../Extras/SquareDataTexture";

export interface IInstancer {
    readonly instancesCount: number;
    readonly instancesArrayCount: number;
    readonly matricesTexture: SquareDataTexture<Float32Array>;
    getActiveAt(id: number): boolean;
    getMatrixAt(id: number): pc.Mat4;
    computeMaxInstanceBoundingBox(): pc.BoundingBox;
}