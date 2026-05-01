import pc from "../../../engine";
import { BoxMesh } from "../BoxMesh";
import { WebgpuQueryScope } from "./WebgpuQueryScope";

const blendNoWrite = pc.BlendState.NOWRITE;
const depthTestNoWrite = new pc.DepthState(pc.FUNC_LESSEQUAL, false);

export class WebgpuOcclusionBoxMesh extends BoxMesh<pc.WebgpuGraphicsDevice> {

    public begin(camera: pc.Camera) {

        const device = this.device;

        device.setVertexBuffer(this.mesh.vertexBuffer);
        device.setCullMode(pc.CULLFACE_NONE);
        device.setBlendState(blendNoWrite);
        device.setDepthState(depthTestNoWrite);
        device.setAlphaToCoverage(false);
        device.setShader(this.shader);
        device.setStencilState(null, null);

        this.setPVMatrix(camera);
    }

    public makeQuery(encoder: GPURenderPassEncoder, scope: WebgpuQueryScope, first: boolean = true, last: boolean = true) {

        this.setMMatrix(scope.box);
        
        const indexBuffer = this.mesh.indexBuffer[0];
        const primitive = this.mesh.primitive[0];

        encoder.beginOcclusionQuery(scope.index);

        this.device.draw(primitive, indexBuffer, 1, undefined, first, last);

        encoder.endOcclusionQuery();
    }

    public end() {

        const device = this.device;

        device.setBlendState(pc.BlendState.NOBLEND);
        device.setStencilState(null, null);
        device.setAlphaToCoverage(false);
    }
}
