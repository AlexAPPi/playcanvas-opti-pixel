import pc from "../engine.js";

export function getCameraDepthTexture(camera: pc.Camera): pc.Texture | null {
    const depthGrabPass = camera.renderPassDepthGrab;
    return depthGrabPass?.depthRenderTarget?.depthBuffer ?? null as pc.Texture | null;
}