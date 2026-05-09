import pc from "../engine.js";

export function getCameraDepthTexture(camera: pc.Camera): pc.Texture | null {

    const depthGrabPass = camera.renderPassDepthGrab;

    if (depthGrabPass) {

        return depthGrabPass.depthRenderTarget.depthBuffer as pc.Texture;
    }

    return null;
}