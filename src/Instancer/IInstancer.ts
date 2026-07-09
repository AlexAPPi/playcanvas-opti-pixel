import { SquareDataTexture } from "../Extras/SquareDataTexture";

export interface IInstancer {
    readonly capacity: number;
    readonly matricesTexture: SquareDataTexture<Float32Array>;
    getMatrixAt(id: number): pc.Mat4;
    computeMaxInstanceBoundingBox(): pc.BoundingBox;
}