import { OCCLUSION_ALGORITHM_TYPE, OCCLUSION_ALGORITHM_TYPE_CONSERVATIVE } from "../Types.js";

export class WebglQueryScope {

    public query: WebGLQuery | null = null;
    public algorithmType: OCCLUSION_ALGORITHM_TYPE = OCCLUSION_ALGORITHM_TYPE_CONSERVATIVE;
    public checking: boolean = false;
    public visible: boolean = true;

    constructor(algorithmType: OCCLUSION_ALGORITHM_TYPE) {
        this.algorithmType = algorithmType;
    }
}