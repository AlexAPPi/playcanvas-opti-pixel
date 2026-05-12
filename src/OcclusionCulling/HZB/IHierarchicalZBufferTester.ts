import type { IOcclusionCullingTester } from "../IOcclusionCullingTester";
import type { IHierarchicalZBuffer } from "./IHierarchicalZBuffer";

export interface IDebugRectangle {
    x: number,
    y: number,
    width: number,
    height: number,
}

export interface IDebugInfo {
    factor: pc.Vec2,
    inFrustum: boolean,
    //outsidePlanes: number,
    lod: number,
    viewSize: pc.Vec2,
    boundingBox: {
        center: pc.Vec3,
        halfExtents: pc.Vec3,
    },
    rectangleDepth: IDebugRectangle,
    rectangleScreen: IDebugRectangle,
}

export interface IHierarchicalZBufferTester extends IOcclusionCullingTester {

    hzb: IHierarchicalZBuffer;

    frameUpdate(): void;

    getDebugInfo(index: number): IDebugInfo;
}