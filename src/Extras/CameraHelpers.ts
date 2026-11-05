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
 * Defines `screenDepthPS` already understands. Device Z adds none.
 * `SCENE_DEPTHMAP_LINEAR` covers metres, packed RGBA8, and `1 / viewZ`.
 */
export function applySceneDepthDefines(defines: Map<string, string>, mode: number) {

    if (mode === CAMERA_DEPTH_DEVICE) {
        return;
    }

    defines.set("SCENE_DEPTHMAP_LINEAR", "");

    if (mode === CAMERA_DEPTH_LINEAR_PACKED) {
        defines.set("SCENE_DEPTHMAP_PACKED", "");
    }
    else if (mode === CAMERA_DEPTH_RECIPROCAL) {
        defines.set("SCENE_DEPTHMAP_RECIPROCAL", "");
    }
}

/**
 * Coverage-buffer names plus {@link applySceneDepthDefines}.
 * `CAMERA_DEPTH_VIEW` means the value is already view-space metres.
 */
export function applyCameraDepthDefines(defines: Map<string, string>, mode: number) {

    applySceneDepthDefines(defines, mode);

    if (mode === CAMERA_DEPTH_LINEAR) {
        defines.set("CAMERA_DEPTH_LINEAR", "");
    }
    else if (mode === CAMERA_DEPTH_LINEAR_PACKED) {
        defines.set("CAMERA_DEPTH_LINEAR_PACKED", "");
    }
    else if (mode === CAMERA_DEPTH_RECIPROCAL) {
        defines.set("CAMERA_DEPTH_RECIPROCAL", "");
    }
    if (mode !== CAMERA_DEPTH_DEVICE) {
        defines.set("CAMERA_DEPTH_VIEW", "");
    }
}