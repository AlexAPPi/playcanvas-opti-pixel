import pc from "../../../engine.js";
import { TFState } from "../../../GPUReadback/Webgl/TFState.js";

/**
 * Coverage transform-feedback slot: the shared PBO/fence readback in
 * {@link TFState}, plus the view-projection and camera params that were
 * current when this depth map was packed. CPU tests reproject with that
 * snapshot, not with the camera of the frame that finally reads the PBO.
 */
export class CoverageTFState extends TFState {

    public vp = new Float32Array(16);
    public cameraParams = new Float32Array(4);
    /** Packed map width for this capture. Row stride of the downloaded prefix. */
    public width = 0;
    /** Packed map height for this capture. */
    public height = 0;

    constructor(device: pc.WebglGraphicsDevice, elementCount: number) {
        super(device, elementCount, "float32");
    }
}
