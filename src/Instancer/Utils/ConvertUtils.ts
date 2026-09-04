import pc from "../../engine.js";
import { FloatArray } from "../../BVH/BVHNode.js";

export function vec3ToArr(vec: pc.Vec3, out: FloatArray, offset: number = 0) {
    out[offset + 0] = vec.x;
    out[offset + 1] = vec.y;
    out[offset + 2] = vec.z;
    return out;
}

/**
 * Inverts the world transformation matrix to get the translation and rotation components.
 * @param world World transformation matrix.
 * @param out Output matrix (translation and rotation components).
 */
export function invertWorldTranslationRotation(world: pc.Mat4, out: pc.Mat4): void {

    const m = world.data;
    const r = out.data;

    let m0 = m[0], m1 = m[1], m2 = m[2];
    const m4 = m[4], m5 = m[5], m6 = m[6];
    const m8 = m[8], m9 = m[9], m10 = m[10];
    const tx = m[12], ty = m[13], tz = m[14];

    // Negative scale / reflection: match Quat.setFromMat4
    const det = m0 * (m5 * m10 - m6 * m9) - m1 * (m4 * m10 - m6 * m8) + m2 * (m4 * m9 - m5 * m8);
    if (det < 0) {
        m0 = -m0;
        m1 = -m1;
        m2 = -m2;
    }

    const lx = m0 * m0 + m1 * m1 + m2 * m2;
    const ly = m4 * m4 + m5 * m5 + m6 * m6;
    const lz = m8 * m8 + m9 * m9 + m10 * m10;
    const invLx = lx > 0 ? 1 / Math.sqrt(lx) : 0;
    const invLy = ly > 0 ? 1 / Math.sqrt(ly) : 0;
    const invLz = lz > 0 ? 1 / Math.sqrt(lz) : 0;

    const n0 = m0 * invLx, n1 = m1 * invLx, n2 = m2 * invLx;
    const n4 = m4 * invLy, n5 = m5 * invLy, n6 = m6 * invLy;
    const n8 = m8 * invLz, n9 = m9 * invLz, n10 = m10 * invLz;

    // inv(T*R) = [R^T | -R^T * t], scale stays in the later mul
    r[0] = n0; r[1] = n4; r[2] = n8; r[3] = 0;
    r[4] = n1; r[5] = n5; r[6] = n9; r[7] = 0;
    r[8] = n2; r[9] = n6; r[10] = n10; r[11] = 0;
    r[12] = -(n0 * tx + n1 * ty + n2 * tz);
    r[13] = -(n4 * tx + n5 * ty + n6 * tz);
    r[14] = -(n8 * tx + n9 * ty + n10 * tz);
    r[15] = 1;
}