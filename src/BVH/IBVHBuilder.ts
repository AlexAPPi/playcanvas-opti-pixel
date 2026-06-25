import { BoxType, BVHNode, FloatArray, TypedArrayConstructor } from "./BVHNode.js";
import { TBoxConverter } from "./Utils/ConvertBoxUtils.js";

export type onLeafCreationCallback<N, L, B extends BoxType> = (node: BVHNode<N, L, B>) => void;

export interface IBVHBuilder<N, L, B extends BoxType> {
    root: BVHNode<N, L, B>;
    typeArray: TypedArrayConstructor<B>;
    boxConverter: TBoxConverter<B>;
    createFromArray(objects: ArrayLike<L>, boxes: FloatArray[], onLeafCreation?: onLeafCreationCallback<N, L, B>, margin?: number): void;
    insert(object: L, box: FloatArray, margin: number): BVHNode<N, L, B>;
    insertRange(objects: ArrayLike<L>, boxes: FloatArray[], margins?: number | FloatArray | number[], onLeafCreation?: onLeafCreationCallback<N, L, B>): void;
    move(node: BVHNode<N, L, B>, margin: number): void;
    delete(node: BVHNode<N, L, B>): BVHNode<N, L, B>;
    clear(): void;
    readonly highPrecision: boolean;
}