import type { IOcclusionCullingTester } from "../IOcclusionCullingTester";
import type { IHierarchicalZBuffer } from "./IHierarchicalZBuffer";

export interface IDebugRectangle {
    x: number,
    y: number,
    width: number,
    height: number,
}

export interface IDebugInfo {
    inFrustum: boolean,
    lod: number,
    viewSize: pc.Vec2,
    boundingBox: {
        center: pc.Vec3,
        halfExtents: pc.Vec3,
    },
    rectangleScreen: IDebugRectangle,
}

export interface IHierarchicalZBufferTester extends IOcclusionCullingTester {

    hzb: IHierarchicalZBuffer;

    frameUpdate(): void;

    getDebugInfo(index: number): IDebugInfo;
}