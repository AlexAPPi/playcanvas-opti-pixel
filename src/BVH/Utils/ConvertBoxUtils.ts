import { BoxType, TypedArrayConstructor, TypedArrayType } from "../BVHNode";

export type TBoxConverter<B extends TypedArrayType> = (box: BoxType, targetType: TypedArrayConstructor<B>, out?: B) => B;

export function convertIntBox<B extends TypedArrayType>(box: BoxType, targetType: TypedArrayConstructor<B>, out?: B): B {
    const outBox = out ?? new targetType(6);
    outBox[0] = Math.floor(box[0]);
    outBox[1] = Math.ceil(box[1]);
    outBox[2] = Math.floor(box[2]);
    outBox[3] = Math.ceil(box[3]);
    outBox[4] = Math.floor(box[4]);
    outBox[5] = Math.ceil(box[5]);
    return outBox;
}

export function convertFloatBox<B extends TypedArrayType>(box: BoxType, targetType: TypedArrayConstructor<B>, out?: B): B {
    const outBox = out ?? new targetType(6);
    outBox[0] = box[0];
    outBox[1] = box[1];
    outBox[2] = box[2];
    outBox[3] = box[3];
    outBox[4] = box[4];
    outBox[5] = box[5];
    return outBox;
}

export function convertBoxToArray(box: pc.BoundingBox, target: BoxType) {
    // TODO: add support integer formats
    const min = box.getMin();
    const max = box.getMax();
    target[0] = min.x;
    target[1] = max.x;
    target[2] = min.y;
    target[3] = max.y;
    target[4] = min.z;
    target[5] = max.z;
}