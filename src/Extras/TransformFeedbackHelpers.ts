import pc from "../engine.js";

const _outputBuffers: pc.VertexBuffer[] = [null!];
const _tmpPrimitive = {
    type: pc.PRIMITIVE_POINTS,
    base: 0,
    baseVertex: 0,
    count: 0,
    indexed: false
}

/**
 * @param renderTarget - Bound while rasterizer-discard is on (nothing is
 * drawn). Pass a tiny dummy target from coverage so the pack does not bind
 * the backbuffer mid-frame (a tile resolve/reload on Mali/Adreno). Omit to
 * keep the previous `null` / backbuffer behaviour (HZB).
 */
export function executeTransformFeedbackShader(
    shader: pc.Shader,
    numElements: number,
    vertexBuffer: pc.VertexBuffer,
    outputBuffer: pc.VertexBuffer,
    renderTarget?: pc.RenderTarget | null
) {
    const device = shader.device as unknown as pc.WebglGraphicsDevice;
    const oldRt = device.getRenderTarget();

    _outputBuffers[0] = outputBuffer;
    _tmpPrimitive.count = numElements;

    device.setRenderTarget(renderTarget ?? null);
    device.updateBegin();
    device.setVertexBuffer(vertexBuffer);
    device.setRaster(false);
    device.setTransformFeedbackBuffers(_outputBuffers);
    device.setShader(shader);

    // @ts-ignore
    device.draw(_tmpPrimitive);

    device.setTransformFeedbackBuffers(null);
    device.setRaster(true);
    device.updateEnd();
    device.setRenderTarget(oldRt);

    _outputBuffers[0] = null!;
}
