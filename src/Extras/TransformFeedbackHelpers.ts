import pc from "../engine.js";

export function executeTransformFeedbackShader(
    shader: pc.Shader,
    numElements: number,
    vertexBuffer: pc.VertexBuffer,
    outputBuffer: pc.VertexBuffer
) {
    const device = shader.device as unknown as pc.WebglGraphicsDevice;
    const oldRt = device.getRenderTarget();

    device.setRenderTarget(null);
    device.updateBegin();
    device.setVertexBuffer(vertexBuffer);
    device.setRaster(false);
    device.setTransformFeedbackBuffer(outputBuffer);
    device.setShader(shader);

    // @ts-ignore
    device.draw({
        type: pc.PRIMITIVE_POINTS,
        base: 0,
        baseVertex: 0,
        count: numElements,
        indexed: false
    });

    device.setTransformFeedbackBuffer(null!);
    device.setRaster(true);
    device.updateEnd();
    device.setRenderTarget(oldRt);
}