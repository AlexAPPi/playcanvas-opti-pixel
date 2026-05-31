import pc from "../../engine.js";
import { FloatArray } from "../../BVH/BVHNode.js";

export function vec3ToArr(vec: pc.Vec3, out: FloatArray, offset: number = 0) {
    out[offset + 0] = vec.x;
    out[offset + 1] = vec.y;
    out[offset + 2] = vec.z;
    return out;
}