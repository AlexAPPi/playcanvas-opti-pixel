import type { IOcclusionCullingTester } from "../IOcclusionCullingTester";
import type { IHierarchicalZBuffer } from "./IHierarchicalZBuffer";

export interface IDebugInfo {
    inFrustum: boolean,
    outsidePlanes: number,
    lod: number,
    viewSize: pc.Vec2,
    boundingBox: {
        center: pc.Vec3,
        halfExtends: pc.Vec3,
    },
    rectangle: {
        x: number,
        y: number,
        width: number,
        height: number,
    }
}

export interface IHierarchicalZBufferTester extends IOcclusionCullingTester {

    hzb: IHierarchicalZBuffer;

    frameUpdate(): void;

    getDebugInfo(index: number): IDebugInfo;
}