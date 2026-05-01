import pc from "../engine.js";

export type TChannelSize = 1 | 2 | 4;
export type TTypedArrayBufferLike = Float32Array<ArrayBufferLike> | Uint32Array<ArrayBufferLike> | Uint16Array<ArrayBufferLike> | Uint8Array<ArrayBufferLike>;
export type TTypedArray = Float32Array | Uint32Array | Uint16Array | Uint8Array;
export type TTypedArrayConstructor<T extends TTypedArray> = new (count: number) => T;
export type TTypedArrayBufferLikeConstructor<T extends TTypedArrayBufferLike> = new (buffer: ArrayBufferLike) => T;

export interface IUpdateRowInfo {
    row: number;
    count: number;
};

export function getSquareTextureSize(capacity: number, pixelsPerInstance: number): number {
    return Math.max(pixelsPerInstance, Math.ceil(Math.sqrt(capacity / pixelsPerInstance)) * pixelsPerInstance);
}

export function getPixelFormatByArrayType(arrayType: TTypedArrayConstructor<TTypedArray>, channels: TChannelSize): number {

    if (arrayType.name === Float32Array.name) {
        if (channels === 1) return pc.PIXELFORMAT_R32F;
        if (channels === 2) throw new Error("Unsupported format");
        return pc.PIXELFORMAT_RGBA32F;
    }

    if (arrayType.name === Uint32Array.name) {
        if (channels === 1) return pc.PIXELFORMAT_R32U;
        if (channels === 2) return pc.PIXELFORMAT_RG32U;
        return pc.PIXELFORMAT_RGBA32U;
    }

    if (arrayType.name === Uint16Array.name) {
        if (channels === 1) return pc.PIXELFORMAT_R16U;
        if (channels === 2) return pc.PIXELFORMAT_RG16U;
        return pc.PIXELFORMAT_RGBA16U;
    }

    if (arrayType.name === Uint8Array.name) {
        if (channels === 1) return pc.PIXELFORMAT_R8U;
        if (channels === 2) return pc.PIXELFORMAT_RG8U;
        return pc.PIXELFORMAT_RGBA8U;
    }

    throw new Error("Unsupported format");
}

export function getSquareTextureInfo<TConstructor extends TTypedArrayConstructor<TTypedArray>>(
    arrayType: TConstructor,
    channels: TChannelSize,
    pixelsPerInstance: number,
    capacity: number
): {
    size: number,
    array: InstanceType<TConstructor>,
    pixelFormat: ReturnType<typeof getPixelFormatByArrayType>
} {
    const size = getSquareTextureSize(capacity, pixelsPerInstance);
    const array = new arrayType(size * size * channels) as unknown as InstanceType<TConstructor>;
    const pixelFormat = getPixelFormatByArrayType(arrayType, channels);

    return { array, size, pixelFormat };
}

export class SquareDataTexture<TTTypedArray extends TTypedArray> {

    /**
     * Whether to enable partial texture updates by row. If `false`, the entire texture will be updated.
     * @default true.
     */
    public partialUpdate = true;

    /**
     * The maximum number of update calls per frame.
     * @default Infinity
     */
    public maxUpdateCalls = Infinity;

    protected _arrayConstructor: TTypedArrayConstructor<TTTypedArray>;
    protected _device: pc.GraphicsDevice;
    protected _capacity: number;
    protected _texture: pc.Texture;
    protected _data: InstanceType<TTypedArrayConstructor<TTTypedArray>>;
    protected _stride: number;
    protected _channels: TChannelSize;
    protected _pixelsPerInstance: number;
    protected _rowToUpdate: boolean[];

    public get pixelsPerInstance() { return this._pixelsPerInstance; }
    public get channels() { return this._channels; }
    public get texture() { return this._texture; }
    public get data() { return this._data; }

    constructor(device: pc.GraphicsDevice, arrayConstructor: TTypedArrayConstructor<TTTypedArray>, channels: TChannelSize, pixelsPerInstance: number, capacity: number = 512) {
        this._device = device;
        this._channels = channels;
        this._arrayConstructor = arrayConstructor;
        this._pixelsPerInstance = pixelsPerInstance;
        this._stride = pixelsPerInstance * channels;
        this._createOrResizeTexture(capacity);
    }

    public destroy(): void {
        this._texture?.destroy();
    }

    private _createOrResizeTexture(count: number): void {

        this._capacity = count;

        if (this._texture) {

            const size = getSquareTextureSize(this._capacity, this._pixelsPerInstance);

            if (size === this._texture.width) {
                return;
            }

            const oldData = this._data;
            const newData = new this._arrayConstructor(size * size * this._channels);
            const minLength = Math.min(oldData.length, newData.length);
            const subData = oldData.subarray(0, minLength);

            newData.set(subData);

            this._data = newData as any;
            this._rowToUpdate.length = size;

            this._texture.resize(size, size);
            this._texture._levels[0] = newData;
            this._texture._levelsUpdated[0] = true;
            this._texture._needsUpload = true;
            this._texture._needsMipmapsUpload = false;
        }
        else {

            const { array, size, pixelFormat } = getSquareTextureInfo(
                this._arrayConstructor,
                this._channels,
                this._pixelsPerInstance,
                this._capacity
            );

            this._data = array;
            this._rowToUpdate = new Array(size);
            this._texture = new pc.Texture(this._device, {
                width: size,
                height: size,
                format: pixelFormat,
                mipmaps: false,
                minFilter: pc.FILTER_NEAREST,
                magFilter: pc.FILTER_NEAREST,
                addressU: pc.ADDRESS_CLAMP_TO_EDGE,
                addressV: pc.ADDRESS_CLAMP_TO_EDGE,
                numLevels: 1,
                levels: [array as any]
            });
        }
    }

    /**
     * Resizes the texture to accommodate a new number of instances.
     * @param count The new total number of instances.
     */
    public resize(count: number): void {
        this._createOrResizeTexture(count);
    }

    /**
     * Marks a row of the texture for update during the next render cycle.
     * This helps in optimizing texture updates by only modifying the rows that have changed.
     * @param index The index of the instance to update.
     */
    public enqueueUpdate(index: number): void {

        if (!this.partialUpdate) {
            this._texture?.dirtyAll();
            return;
        }

        const elementsPerRow = this._texture.width / this._pixelsPerInstance;
        const rowIndex = Math.floor(index / elementsPerRow);
        this._rowToUpdate[rowIndex] = true;
    }
    
    /**
     * Queues a data update for a specific instance in the texture buffer.
     * Unlike `enqueueUpdate`, this method allows providing the updated data directly,
     * enabling partial or full instance data replacement during the next GPU upload cycle.
     * @param index The index of the instance to update.
     * @param inData The new data to be written into the instance slot.
     * @param offset The byte offset within the instance data where the update begins. Default is 0.
     */
    public enqueueDataUpdate(index: number, inData: TTTypedArray, offset: number = 0): void {

        this.enqueueUpdate(index);

        const dataIndex = index * this._stride;

        let inIndex = offset;
        let tmpIndex = dataIndex;

        for (; inIndex < this._stride;) {
            this._data[tmpIndex++] = inData[inIndex++];
        }
    }

    protected _getUpdateRowsInfo(): IUpdateRowInfo[] {

        const rowsToUpdate = this._rowToUpdate;
        const result: IUpdateRowInfo[] = [];

        for (let i = 0, l = rowsToUpdate.length; i < l; i++) {

            if (rowsToUpdate[i]) {

                const row = i;

                for (; i < l; i++) {
                    if (!rowsToUpdate[i]) break;
                }
                
                result.push({ row, count: i - row });
            }
        }

        return result;
    }

    protected _updateRows(info: IUpdateRowInfo[]): void {

        const channels = this._channels;

        if (this._device.isWebGL2) {

            const device = this._device as pc.WebglGraphicsDevice;
            const gl = device.gl;
            const width = this._texture.width;
            const glFormat = this._texture.impl._glFormat;
            const glPixelType = this._texture.impl._glPixelType;

            device.setTexture(this._texture, 0);
            device.setUnpackFlipY(false);
            device.setUnpackPremultiplyAlpha(this._texture.premultiplyAlpha);

            for (const { count, row } of info) {
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, width, count, glFormat, glPixelType, this._data, row * width * channels);
            }
        }
        else if (this._device.isWebGPU) {

            const wgpu = (this._device as any).wgpu as GPUDevice;
            const wgpuTexture = this._texture.impl.gpuTexture as GPUTexture;
            const width = this._texture.width;
            const formatInfo = pc.pixelFormatInfo.get(this._texture.format);
            const bytesPerRowUnaligned = width * formatInfo!.size!;
            const bytesPerRow = Math.ceil(bytesPerRowUnaligned / 256) * 256;

            const proxy = new Uint8Array(this._data.buffer);

            let alignedData: Uint8Array<ArrayBuffer> | undefined;

            for (const { count, row } of info) {

                const requiredBufferSize = bytesPerRow * count;

                if (!alignedData || alignedData.length < requiredBufferSize) {
                    alignedData = new Uint8Array(requiredBufferSize);
                }
                
                for (let subRow = 0; subRow < count; subRow++) {
                    const srcStart = (row + subRow) * bytesPerRowUnaligned;
                    const srcEnd = srcStart + bytesPerRowUnaligned;
                    const destStart = subRow * bytesPerRow;
                    alignedData.set(proxy.subarray(srcStart, srcEnd), destStart);
                }

                wgpu.queue.writeTexture(
                    { texture: wgpuTexture, mipLevel: 0, origin: { x: 0, y: row, z: 0 } },
                    alignedData,
                    {
                        offset: 0,
                        bytesPerRow: bytesPerRow,
                        rowsPerImage: count
                    },
                    { width: width, height: count, depthOrArrayLayers: 1 }
                );
            }
        }
    }

    public upload() {
        this._texture.upload();
    }

    /**
     * Upload updated data to GPU
     */
    public update(): void {

        const rowsInfo = this._getUpdateRowsInfo();
        
        if (rowsInfo.length === 0) {
            return;
        }

        if (!this.partialUpdate ||
            rowsInfo.length > this.maxUpdateCalls) {
            this._texture.dirtyAll();
            return;
        }

        this._texture._needsUpload = false;
        this._texture._needsMipmapsUpload = false;
        this._texture._levelsUpdated[0] = false;
        this._texture._mipmapsUploaded  = true;

        this._updateRows(rowsInfo);
        this._rowToUpdate.fill(false);
    }
}