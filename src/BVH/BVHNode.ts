export type FloatArray = Float32Array | Float64Array;
export type FloatArrayType = typeof Float32Array | typeof Float64Array;

export type TypedArrayType = FloatArray | Int32Array | Int16Array | Int8Array;
export type TypedArrayConstructor<T extends TypedArrayType> = new (count: number) => T;

export type Nullable = { toString: never };
export type BoxOfObj = {
    /** minX */ 0: number,
    /** maxX */ 1: number,
    /** minY */ 2: number,
    /** maxY */ 3: number,
    /** minZ */ 4: number,
    /** maxZ */ 5: number
}

export type BoxType = TypedArrayType;
export type BVHNode<NodeData, LeafData, TBox extends BoxType> = {
    box: TBox; // [minX, maxX, minY, maxY, minZ, maxZ]
    parent: BVHNode<NodeData, LeafData, TBox>;
    left: BVHNode<NodeData, LeafData, TBox>;
    right: BVHNode<NodeData, LeafData, TBox>;
    object: LeafData;
} & NodeData;