export type TypedArrayBufferLikeType = Float32Array<ArrayBufferLike> | Uint32Array<ArrayBufferLike> | Uint16Array<ArrayBufferLike> | Uint8Array<ArrayBufferLike>;
export type TypedArrayType = Float32Array | Uint32Array | Uint16Array | Uint8Array;
export type TypedArrayConstructorType<T extends TypedArrayType> = new (count: number) => T;
export type TypedArrayBufferLikeConstructorType<T extends TypedArrayBufferLikeType> = new (buffer: ArrayBufferLike) => T;