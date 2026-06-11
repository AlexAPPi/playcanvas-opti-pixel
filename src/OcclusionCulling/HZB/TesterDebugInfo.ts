import pc from "../../engine.js";
import { IDebugInfo } from "./IHierarchicalZBufferTester.js";
import { IHierarchicalZBufferTester } from "./IHierarchicalZBufferTester.js";

const _hzbSize = new pc.Vec2();
const _rectMin = new pc.Vec3();
const _rectMax = new pc.Vec3();
const _boundsMin = new pc.Vec3();
const _boundsMax = new pc.Vec3();
const _bounds    = [_boundsMin, _boundsMax];
const _pointSrc = new pc.Vec4();
const _pointClip = new pc.Vec4();
const _pointScreen = new pc.Vec3();

const _rectMin2 = new pc.Vec2();
const _rectMax2 = new pc.Vec2();

export function min3(vec1: pc.Vec3, vec2: pc.Vec3) {
    vec1.x = Math.min(vec1.x, vec2.x);
    vec1.y = Math.min(vec1.y, vec2.y);
    vec1.z = Math.min(vec1.z, vec2.z);
    return vec1;
}

export function max3(vec1: pc.Vec3, vec2: pc.Vec3) {
    vec1.x = Math.max(vec1.x, vec2.x);
    vec1.y = Math.max(vec1.y, vec2.y);
    vec1.z = Math.max(vec1.z, vec2.z);
    return vec1;
}

export function ceil2(vec1: pc.Vec2) {
    vec1.x = Math.ceil(vec1.x);
    vec1.y = Math.ceil(vec1.y);
    return vec1;
}

export function floor2(vec1: pc.Vec2) {
    vec1.x = Math.floor(vec1.x);
    vec1.y = Math.floor(vec1.y);
    return vec1;
}

export function getDebugInfo(
    tester: IHierarchicalZBufferTester,
    matrix: pc.Mat4,
    box: pc.BoundingBox
): IDebugInfo {

    const minMipLevel = 0;

    _rectMin.set( 1.0,  1.0,  1.0);
    _rectMax.set(-1.0, -1.0, -1.0);

    _boundsMin.copy(box.center).sub(box.halfExtents);
    _boundsMax.copy(box.center).add(box.halfExtents);

    for (var i = 0; i < 8; i++) {

        _pointSrc.set(
            _bounds[(i >> 0) & 1].x,
            _bounds[(i >> 1) & 1].y,
            _bounds[(i >> 2) & 1].z,
            1.0
        );

        matrix.transformVec4(_pointSrc, _pointClip);

        _pointScreen.set(
            _pointClip.x / _pointClip.w,
            _pointClip.y / _pointClip.w,
            _pointClip.z / _pointClip.w,
        );

        min3(_rectMin, _pointScreen);
        max3(_rectMax, _pointScreen);
    }

    _rectMin2.set(_rectMin.x, _rectMin.y).mulScalar(0.5).addScalar(0.5);
    _rectMax2.set(_rectMax.x, _rectMax.y).mulScalar(0.5).addScalar(0.5);

    _rectMin2.x = pc.math.clamp(_rectMin2.x, 0.0, 1.0);
    _rectMin2.y = pc.math.clamp(_rectMin2.y, 0.0, 1.0);

    _rectMax2.x = pc.math.clamp(_rectMax2.x, 0.0, 1.0);
    _rectMax2.y = pc.math.clamp(_rectMax2.y, 0.0, 1.0);

    const hzbSize = _hzbSize.set(
        tester.hzb.width,
        tester.hzb.height
    );

    const rectPixelsMin = _rectMin2.clone().mul(hzbSize);
    const rectPixelsMax = _rectMax2.clone().mul(hzbSize);
    const rectSize = rectPixelsMax.clone().sub(rectPixelsMin).mulScalar(0.5);

    let level = Math.max(Math.ceil(Math.log2(Math.max(rectSize.x, rectSize.y))), minMipLevel);

    const levelLower = Math.max(level - 1, 0);
    const levelLowerC = Math.pow(2, -levelLower);
    const lowerRectMin = rectPixelsMin.clone().mulScalar(levelLowerC);
    const lowerRectMax = rectPixelsMax.clone().mulScalar(levelLowerC);
    const lowerRectSize = ceil2(lowerRectMax).sub(floor2(lowerRectMin));

    if (lowerRectSize.x <= 4.0 &&
        lowerRectSize.y <= 4.0) {
        level = levelLower;
    }

    const extent = new pc.Vec2().sub2(_rectMax2, _rectMin2);
    const viewSize = new pc.Vec2().mul2(extent, hzbSize);

    return {
        inFrustum: _rectMax.z < 1,
        lod: level,
        viewSize,
        boundingBox: {
            center: box.center,
            halfExtents: box.halfExtents,
        },
        rectangleScreen: {
            x: (_rectMin2.x + extent.x / 2) * 2 - 1,
            y: (_rectMin2.y + extent.y / 2) * 2 - 1,
            width: extent.x * 2,
            height: extent.y * 2,
        }
    }
}