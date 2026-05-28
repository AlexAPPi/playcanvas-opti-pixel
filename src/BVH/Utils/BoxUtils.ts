import { BoxType, FloatArray } from "../BVHNode.js";

export function unionBox(A: BoxType, B: BoxType, target: BoxType): void {
    target[0] = A[0] > B[0] ? B[0] : A[0];
    target[1] = A[1] < B[1] ? B[1] : A[1];
    target[2] = A[2] > B[2] ? B[2] : A[2];
    target[3] = A[3] < B[3] ? B[3] : A[3];
    target[4] = A[4] > B[4] ? B[4] : A[4];
    target[5] = A[5] < B[5] ? B[5] : A[5];
}

export function unionBoxChanged(A: BoxType, B: BoxType, target: BoxType): boolean {
    let changed = false;
    const t0 = A[0] > B[0] ? B[0] : A[0];
    const t1 = A[1] < B[1] ? B[1] : A[1];
    const t2 = A[2] > B[2] ? B[2] : A[2];
    const t3 = A[3] < B[3] ? B[3] : A[3];
    const t4 = A[4] > B[4] ? B[4] : A[4];
    const t5 = A[5] < B[5] ? B[5] : A[5];

    if (target[0] > t0) {
        target[0] = t0;
        changed = true;
    }

    if (target[1] < t1) {
        target[1] = t1;
        changed = true;
    }

    if (target[2] > t2) {
        target[2] = t2;
        changed = true;
    }

    if (target[3] < t3) {
        target[3] = t3;
        changed = true;
    }

    if (target[4] > t4) {
        target[4] = t4;
        changed = true;
    }

    if (target[5] < t5) {
        target[5] = t5;
        changed = true;
    }

    return changed;
}

export function isBoxInsideBox(innerBox: BoxType, outerBox: BoxType): boolean {
    if (outerBox[0] > innerBox[0]) return false;
    if (outerBox[1] < innerBox[1]) return false;
    if (outerBox[2] > innerBox[2]) return false;
    if (outerBox[3] < innerBox[3]) return false;
    if (outerBox[4] > innerBox[4]) return false;
    if (outerBox[5] < innerBox[5]) return false;
    return true;
}

export function isExpanded(A: BoxType, target: BoxType): boolean {
    let expanded = false;

    if (target[0] > A[0]) {
        target[0] = A[0];
        expanded = true;
    }

    if (target[1] < A[1]) {
        target[1] = A[1];
        expanded = true;
    }

    if (target[2] > A[2]) {
        target[2] = A[2];
        expanded = true;
    }

    if (target[3] < A[3]) {
        target[3] = A[3];
        expanded = true;
    }

    if (target[4] > A[4]) {
        target[4] = A[4];
        expanded = true;
    }

    if (target[5] < A[5]) {
        target[5] = A[5];
        expanded = true;
    }

    return expanded;
}

export function expandBox(A: BoxType, target: BoxType): void {
    if (target[0] > A[0]) target[0] = A[0];
    if (target[1] < A[1]) target[1] = A[1];
    if (target[2] > A[2]) target[2] = A[2];
    if (target[3] < A[3]) target[3] = A[3];
    if (target[4] > A[4]) target[4] = A[4];
    if (target[5] < A[5]) target[5] = A[5];
}

export function expandBoxByMargin(target: BoxType, margin: number): void {
    target[0] -= margin;
    target[1] += margin;
    target[2] -= margin;
    target[3] += margin;
    target[4] -= margin;
    target[5] += margin;
}

export function areaBox(box: BoxType): number {
    const d0 = box[1] - box[0];
    const d1 = box[3] - box[2];
    const d2 = box[5] - box[4];

    return 2 * (d0 * d1 + d1 * d2 + d2 * d0);
}

export function areaFromTwoBoxes(A: BoxType, B: BoxType): number {
    const minX = A[0] > B[0] ? B[0] : A[0];
    const maxX = A[1] < B[1] ? B[1] : A[1];
    const minY = A[2] > B[2] ? B[2] : A[2];
    const maxY = A[3] < B[3] ? B[3] : A[3];
    const minZ = A[4] > B[4] ? B[4] : A[4];
    const maxZ = A[5] < B[5] ? B[5] : A[5];

    const d0 = maxX - minX;
    const d1 = maxY - minY;
    const d2 = maxZ - minZ;

    return 2 * (d0 * d1 + d1 * d2 + d2 * d0);
}

export function getLongestAxis(box: BoxType): number {
    const xSize = box[1] - box[0];
    const ySize = box[3] - box[2];
    const zSize = box[5] - box[4];

    if (xSize > ySize) return xSize > zSize ? 0 : 2;
    return ySize > zSize ? 1 : 2;
}

export function minDistanceSqPointToBox(box: BoxType, point: FloatArray): number {

    const xMin = box[0] - point[0];
    const xMax = point[0] - box[1];
    let dx = xMin > xMax ? xMin : xMax;
    if (dx < 0) dx = 0;

    const yMin = box[2] - point[1];
    const yMax = point[1] - box[3];
    let dy = yMin > yMax ? yMin : yMax;
    if (dy < 0) dy = 0;

    const zMin = box[4] - point[2];
    const zMax = point[2] - box[5];
    let dz = zMin > zMax ? zMin : zMax;
    if (dz < 0) dz = 0;

    return dx * dx + dy * dy + dz * dz;
}

export function minDistancePointToBox(box: BoxType, point: FloatArray): number {
    return Math.sqrt(minDistanceSqPointToBox(box, point));
}

export const _tmp = { min: 0, max: 0 };

export function minMaxDistanceSqPointToBox(box: BoxType, point: FloatArray, out: { min: number; max: number } = _tmp) {
    let dXmin, dXmax, dYmin, dYmax, dZmin, dZmax;

    const xMin = box[0] - point[0];
    const xMax = point[0] - box[1];

    if (xMin > xMax) {
        dXmin = xMin;
        dXmax = xMax;
    } else {
        dXmin = xMax;
        dXmax = xMin;
    }

    if (dXmin < 0) dXmin = 0;

    const yMin = box[2] - point[1];
    const yMax = point[1] - box[3];

    if (yMin > yMax) {
        dYmin = yMin;
        dYmax = yMax;
    } else {
        dYmin = yMax;
        dYmax = yMin;
    }

    if (dYmin < 0) dYmin = 0;

    const zMin = box[4] - point[2];
    const zMax = point[2] - box[5];

    if (zMin > zMax) {
        dZmin = zMin;
        dZmax = zMax;
    } else {
        dZmin = zMax;
        dZmax = zMin;
    }

    if (dZmin < 0) dZmin = 0;

    out.min = dXmin * dXmin + dYmin * dYmin + dZmin * dZmin;
    out.max = dXmax * dXmax + dYmax * dYmax + dZmax * dZmax;

    return out;
}

export function minMaxDistancePointToBox(box: BoxType, point: FloatArray, out: { min: number; max: number } = _tmp): { min: number; max: number } {
    const result = minMaxDistanceSqPointToBox(box, point, out);
    result.min = Math.sqrt(result.min);
    result.max = Math.sqrt(result.max);
    return result;
}