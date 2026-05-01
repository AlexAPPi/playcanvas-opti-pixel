import pc from "../../../engine";

export class WebgpuQueryScope {

    public checking: boolean = false;
    public visible: boolean = true;

    constructor(
        public readonly index: number,
        public readonly box: pc.BoundingBox
    ) {
    }
}