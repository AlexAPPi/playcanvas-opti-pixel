import { LODRender } from "./LODRender";

export interface ILODLevel {

    /**
     * The name of lod level
     */
    name?: string;

    /**
     * The squared distance at which this LOD level becomes active.
     */
    distance: number;

    /**
     * Hysteresis value to prevent LOD flickering when transitioning.
     */
    hysteresis: number;

    /**
     * The entities for renderer
     */
    render?: LODRender;
}