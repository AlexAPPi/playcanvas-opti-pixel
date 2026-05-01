import pc from "../../../engine";
import { BoxMesh } from "../BoxMesh";
import { OCCLUSION_ALGORITHM_TYPE_CONSERVATIVE } from "../Types";
import { WebglQueryScope } from "./WebglQueryScope";

const blendNoWrite = pc.BlendState.NOWRITE;
const depthTestNoWrite = new pc.DepthState(pc.FUNC_LESSEQUAL, false);

export class WebglOcclusionBoxMesh extends BoxMesh<pc.WebglGraphicsDevice> {

    public begin(camera: pc.Camera) {

        const device = this.device;

        device.setVertexBuffer(this.mesh.vertexBuffer);
        device.setCullMode(pc.CULLFACE_NONE);
        device.setBlendState(blendNoWrite);
        device.setDepthState(depthTestNoWrite);
        device.setAlphaToCoverage(false);
        device.setShader(this.shader);
        device.setTransformFeedbackBuffer(undefined!);
        device.setStencilState(null, null);
        device.activateShader();

        this.setPVMatrix(camera);
    }

    public makeQuery(scope: WebglQueryScope, first: boolean = true, last: boolean = true) {

        this.setMMatrix(scope.box);

        const device = this.device;
        const gl = device.gl;
        const indexBuffer = this.mesh.indexBuffer[0];
        const primitive = this.mesh.primitive[0];
        const target = scope.algorithmType === OCCLUSION_ALGORITHM_TYPE_CONSERVATIVE ?
            gl.ANY_SAMPLES_PASSED_CONSERVATIVE :
            gl.ANY_SAMPLES_PASSED;

        if (scope.query) {
            gl.beginQuery(target, scope.query!);
        }

        this.device.draw(primitive, indexBuffer, 0, undefined, first, last);

        if (scope.query) {
            gl.endQuery(target);
        }
    }

    public end() {

        const device = this.device;

        device.setBlendState(pc.BlendState.NOBLEND);
        device.setStencilState(null, null);
        device.setAlphaToCoverage(false);
    }
}