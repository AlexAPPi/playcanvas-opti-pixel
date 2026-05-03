import pc from "../../engine.js";
import { IDebugInfo } from "./IHierarchicalZBufferTester.js";
import { IHierarchicalZBufferTester } from "./IHierarchicalZBufferTester.js";

const _boundingBox = [new pc.Vec4(), new pc.Vec4(), new pc.Vec4(), new pc.Vec4(), new pc.Vec4(), new pc.Vec4(), new pc.Vec4(), new pc.Vec4()];
const _hzbSize = new pc.Vec2();
const _minCoord = new pc.Vec2();
const _maxCoord = new pc.Vec2();

export function getDebugInfo(
    tester: IHierarchicalZBufferTester,
    matrix: pc.Mat4,
    boundingBox: pc.BoundingBox
): IDebugInfo {

    const bbCenter = boundingBox.center;
    const bbHalfExtends = boundingBox.halfExtents;

    _boundingBox[0].set(bbCenter.x +  bbHalfExtends.x, bbCenter.y +  bbHalfExtends.y, bbCenter.z +  bbHalfExtends.z, 1.0);
    _boundingBox[1].set(bbCenter.x + -bbHalfExtends.x, bbCenter.y +  bbHalfExtends.y, bbCenter.z +  bbHalfExtends.z, 1.0);
    _boundingBox[2].set(bbCenter.x +  bbHalfExtends.x, bbCenter.y + -bbHalfExtends.y, bbCenter.z +  bbHalfExtends.z, 1.0);
    _boundingBox[3].set(bbCenter.x + -bbHalfExtends.x, bbCenter.y + -bbHalfExtends.y, bbCenter.z +  bbHalfExtends.z, 1.0);
    _boundingBox[4].set(bbCenter.x +  bbHalfExtends.x, bbCenter.y +  bbHalfExtends.y, bbCenter.z + -bbHalfExtends.z, 1.0);
    _boundingBox[5].set(bbCenter.x + -bbHalfExtends.x, bbCenter.y +  bbHalfExtends.y, bbCenter.z + -bbHalfExtends.z, 1.0);
    _boundingBox[6].set(bbCenter.x +  bbHalfExtends.x, bbCenter.y + -bbHalfExtends.y, bbCenter.z + -bbHalfExtends.z, 1.0);
    _boundingBox[7].set(bbCenter.x + -bbHalfExtends.x, bbCenter.y + -bbHalfExtends.y, bbCenter.z + -bbHalfExtends.z, 1.0);

    let minCoordX = 1e6;
    let minCoordY = 1e6;
    let maxCoordX = -1e6;
    let maxCoordY = -1e6;
    let instanceMinDepth = 1e6;

    let outXPos = 0;
    let outXNeg = 0;
    let outYPos = 0;
    let outYNeg = 0;
    let outZPos = 0;
    let outZNeg = 0;

    for (let i = 0; i < 8; i++) {

        matrix.transformVec4(_boundingBox[i], _boundingBox[i]);

        const current = _boundingBox[i];

        if (current.x >  current.w) outXPos++;
        if (current.x < -current.w) outXNeg++;
        if (current.y >  current.w) outYPos++;
        if (current.y < -current.w) outYNeg++;
        if (current.z >  current.w) outZPos++;
        if (current.z < -current.w) outZNeg++;

        current.x /= current.w;
        current.y /= current.w;
        current.z /= current.w;

        minCoordX = Math.min(minCoordX, current.x);
        minCoordY = Math.min(minCoordY, current.y);
        maxCoordX = Math.max(maxCoordX, current.x);
        maxCoordY = Math.max(maxCoordY, current.y);

        instanceMinDepth = Math.min(instanceMinDepth, current.z);
    }

    const outsidePlanes = (outXPos > 0 || outXNeg > 0 ? 1 : 0) +
                          (outYPos > 0 || outYNeg > 0 ? 1 : 0) +
                          (outZPos > 0 || outZNeg > 0 ? 1 : 0);

    const inFrustum = !(outXPos === 8 || outXNeg === 8 || outYPos === 8 || outYNeg === 8 || outZPos === 8 || outZNeg === 8);
    const minCoord = _minCoord.set(minCoordX, minCoordY).mulScalar(0.5).addScalar(0.5);
    const maxCoord = _maxCoord.set(maxCoordX, maxCoordY).mulScalar(0.5).addScalar(0.5);

    minCoord.x = pc.math.clamp(minCoord.x, 0.0, 1.0);
    minCoord.y = pc.math.clamp(minCoord.y, 0.0, 1.0);

    maxCoord.x = pc.math.clamp(maxCoord.x, 0.0, 1.0);
    maxCoord.y = pc.math.clamp(maxCoord.y, 0.0, 1.0);

    const hzbSize = _hzbSize.set(
        tester.hzb.width,
        tester.hzb.height
    );

    const extent = maxCoord.clone().sub(minCoord);
    const viewSize = extent.clone().mul(hzbSize);
    const size = Math.max(viewSize.x, viewSize.y);
    const minMipLevel = 0;
    const maxMipLevel = tester.hzb.mipLevels - 1;
    const curMipLevel = Math.ceil(Math.log2(size));
    const lod = pc.math.clamp(curMipLevel, minMipLevel, maxMipLevel);

    return {
        inFrustum,
        outsidePlanes,
        lod,
        viewSize,
        boundingBox: {
            center: bbCenter,
            halfExtends: bbHalfExtends,
        },
        rectangle: {
            x: (minCoord.x + extent.x / 2) * 2 - 1,
            y: (minCoord.y + extent.y / 2) * 2 - 1,
            width: extent.x * 2,
            height: extent.y * 2,
        }
    }
}