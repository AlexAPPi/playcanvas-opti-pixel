export type TTypedArrayBufferLike = Float32Array<ArrayBufferLike> | Uint32Array<ArrayBufferLike> | Uint16Array<ArrayBufferLike> | Uint8Array<ArrayBufferLike>;
export type TTypedArray = Float32Array | Uint32Array | Uint16Array | Uint8Array;
export type TTypedArrayConstructor<T extends TTypedArray> = new (count: number) => T;
export type TTypedArrayBufferLikeConstructor<T extends TTypedArrayBufferLike> = new (buffer: ArrayBufferLike) => T;