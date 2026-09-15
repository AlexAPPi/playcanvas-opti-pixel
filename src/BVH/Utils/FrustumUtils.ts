import { BoxType } from "../BVHNode.js";

export function intersectsBoxMask(frustum: pc.Frustum, box: BoxType, mask: number) {

    const planeData = frustum.planeData;

    for (let i = 0; i < 6; i++) {

        const bit = 0b100000 >> i;

        if ((mask & bit) === 0) continue;

        const pi = i * 4;
        const px = planeData[pi];
        const py = planeData[pi + 1];
        const pz = planeData[pi + 2];
        const planeConstant = planeData[pi + 3];

        const ix = px > 0 ? 1 : 0;
        const iy = py > 0 ? 3 : 2;
        const iz = pz > 0 ? 5 : 4;

        const xMin = box[ix];
        const xMax = box[ix ^ 1];
        const yMin = box[iy];
        const yMax = box[iy ^ 1];
        const zMin = box[iz];
        const zMax = box[iz ^ 1];

        const minDot = (px * xMin) + (py * yMin) + (pz * zMin);
        if (minDot < -planeConstant) {
            return -1;
        }

        const maxDot = (px * xMax) + (py * yMax) + (pz * zMax);
        if (maxDot > -planeConstant) {
            mask ^= bit;
        }
    }
    return mask;
}

export function isIntersected(frustum: pc.Frustum, box: BoxType, mask: number): boolean {

    const planeData = frustum.planeData;

    for (let i = 0; i < 6; i++) {

        const bit = 0b100000 >> i;

        if ((mask & bit) === 0) continue;

        const pi = i * 4;
        const px = planeData[pi];
        const py = planeData[pi + 1];
        const pz = planeData[pi + 2];
        const planeConstant = planeData[pi + 3];

        const xMin = px > 0 ? box[1] : box[0];
        const yMin = py > 0 ? box[3] : box[2];
        const zMin = pz > 0 ? box[5] : box[4];

        const minDot = (px * xMin) + (py * yMin) + (pz * zMin);
        if (minDot < -planeConstant) {
            return false;
        }
    }
    return true;
}

export function isIntersectedMargin(frustum: pc.Frustum, box: BoxType, mask: number, margin: number): boolean {

    if (mask === 0) {
        return true;
    }

    const planeData = frustum.planeData;

    for (let i = 0; i < 6; i++) {

        const bit = 0b100000 >> i;

        if ((mask & bit) === 0) continue;

        const pi = i * 4;
        const px = planeData[pi];
        const py = planeData[pi + 1];
        const pz = planeData[pi + 2];
        const planeConstant = planeData[pi + 3];

        const xMin = px > 0 ? box[1] - margin : box[0] + margin;
        const yMin = py > 0 ? box[3] - margin : box[2] + margin;
        const zMin = pz > 0 ? box[5] - margin : box[4] + margin;

        const minDot = (px * xMin) + (py * yMin) + (pz * zMin);
        if (minDot < -planeConstant) {
            return false;
        }
    }
    return true;
}