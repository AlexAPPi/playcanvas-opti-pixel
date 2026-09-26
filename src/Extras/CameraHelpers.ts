import pc from "../engine.js";

/**
 * Nonlinear device Z from {@link Camera.renderPassDepthGrab}.
 */
export const CAMERA_DEPTH_DEVICE = 0;

/**
 * View-space metres in `.r`. CameraFrame depth prepass (`R32F`).
 */
export const CAMERA_DEPTH_LINEAR = 1;

/**
 * View-space metres packed into RGBA8. CameraFrame prepass without a float render target.
 */
export const CAMERA_DEPTH_LINEAR_PACKED = 2;

/**
 * `1 / viewZ` in `.r`. CameraFrame scene-texture depth (TAA, DoF, fog, SSAO combine).
 */
export const CAMERA_DEPTH_RECIPROCAL = 3;

export function getCameraDepthTexture(camera: pc.Camera): pc.Texture | null {
    const depthGrabPass = camera.renderPassDepthGrab;
    return depthGrabPass?.depthRenderTarget?.depthBuffer ?? null as pc.Texture | null;
}

/**
 * Encoding of {@link Camera.sceneDepthMap}. The texture itself is `camera.sceneDepthMap`.
 */
export function getCameraSceneDepthMode(camera: pc.Camera): number {
    const params = camera.shaderParams;
    if (!params.sceneDepthMapLinear) { return CAMERA_DEPTH_DEVICE; }
    if (params.sceneDepthMapPacked) { return CAMERA_DEPTH_LINEAR_PACKED; }
    if (params.sceneDepthMapReciprocal) { return CAMERA_DEPTH_RECIPROCAL; }
    return CAMERA_DEPTH_LINEAR;
}

/**
 * Compile-time coverage depth variant. Device Z adds no defines.
 */
export function applyCameraDepthDefines(defines: Map<string, string>, mode: number) {
    if (mode === CAMERA_DEPTH_LINEAR) {
        defines.set("COVERAGE_DEPTH_LINEAR", "");
    }
    else if (mode === CAMERA_DEPTH_LINEAR_PACKED) {
        defines.set("COVERAGE_DEPTH_LINEAR_PACKED", "");
    }
    else if (mode === CAMERA_DEPTH_RECIPROCAL) {
        defines.set("COVERAGE_DEPTH_RECIPROCAL", "");
    }
    if (mode !== CAMERA_DEPTH_DEVICE) {
        defines.set("COVERAGE_DEPTH_VIEW", "");
    }
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