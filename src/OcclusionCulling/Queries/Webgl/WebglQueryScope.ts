import pc from "../../../engine";
import { OCCLUSION_ALGORITHM_TYPE, OCCLUSION_ALGORITHM_TYPE_CONSERVATIVE } from "../Types";

export class WebglQueryScope {

    public query: WebGLQuery | null = null;
    public box: pc.BoundingBox;
    public algorithmType: OCCLUSION_ALGORITHM_TYPE = OCCLUSION_ALGORITHM_TYPE_CONSERVATIVE;
    public checking: boolean = false;
    public visible: boolean = true;

    constructor(box: pc.BoundingBox, algorithmType: OCCLUSION_ALGORITHM_TYPE) {
        this.box = box;
        this.algorithmType = algorithmType;
    }
}