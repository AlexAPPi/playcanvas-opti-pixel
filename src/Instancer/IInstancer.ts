import { Mat4DataTexture } from "../Extras/Mat4DataTexture.js";

export interface IInstancer {
    readonly capacity: number;
    readonly matricesTexture: Mat4DataTexture;
    getMatrixAt(id: number): pc.Mat4;
    computeMaxInstanceBoundingBox(): pc.BoundingBox;
}
