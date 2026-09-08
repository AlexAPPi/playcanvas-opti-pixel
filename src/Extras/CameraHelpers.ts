import pc from "../engine.js";

export function getCameraDepthTexture(camera: pc.Camera): pc.Texture | null {
    const depthGrabPass = camera.renderPassDepthGrab;
    return depthGrabPass?.depthRenderTarget?.depthBuffer ?? null as pc.Texture | null;
}

/** PlayCanvas `camera_params`: (1/far, far, near, ortho). */
export function writeCameraParams(out: Float32Array, camera: pc.Camera) {
    const far = camera.farClip;
    const near = camera.nearClip;
    out[0] = far > 0 ? 1 / far : 0;
    out[1] = far;
    out[2] = near;
    out[3] = camera.projection === pc.PROJECTION_ORTHOGRAPHIC ? 1 : 0;
}