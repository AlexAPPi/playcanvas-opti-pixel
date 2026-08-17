import pc from "../engine.js";
import { BitSet } from "./BitSet.js";
import { type TypedArrayType, type TypedArrayConstructorType } from "./TypedArray.js";

export type TChannelSize = 1 | 2 | 4;

export interface IUpdateRowInfo {
    row: number;
    count: number;
}

/** Mutable scratch for `GPUQueue.writeTexture` destination. */
export interface IGpuTextureWriteDest {
    texture: GPUTexture;
    mipLevel: number;
    origin: { x: number; y: number; z: number };
}

/** Mutable scratch for `GPUQueue.writeTexture` data layout. */
export interface IGpuTextureWriteLayout {
    offset: number;
    bytesPerRow: number;
    rowsPerImage: number;
}

/** Mutable scratch for `GPUQueue.writeTexture` copy size. */
export interface IGpuTextureWriteSize {
    width: number;
    height: number;
    depthOrArrayLayers: number;
}

export function createGpuTextureWriteScratch(): {
    dest: IGpuTextureWriteDest;
    layout: IGpuTextureWriteLayout;
    size: IGpuTextureWriteSize;
} {
    return {
        dest: { texture: null!, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
        layout: { offset: 0, bytesPerRow: 0, rowsPerImage: 0 },
        size: { width: 0, height: 0, depthOrArrayLayers: 1 }
    };
}

export function getSquareTextureSize(capacity: number, pixelsPerInstance: number): number {
    return Math.max(pixelsPerInstance, Math.ceil(Math.sqrt(capacity / pixelsPerInstance)) * pixelsPerInstance);
}

export function getPixelFormatByArrayType(arrayType: TypedArrayConstructorType<TypedArrayType>, channels: TChannelSize): number {

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

export function getSquareTextureInfo<TConstructor extends TypedArrayConstructorType<TypedArrayType>>(
    arrayType: TConstructor,
    channels: TChannelSize,
    pixelsPerInstance: number,
    capacity: number,
    layers: number = 1
): {
    size: number,
    array: InstanceType<TConstructor>,
    pixelFormat: ReturnType<typeof getPixelFormatByArrayType>
} {
    const size = getSquareTextureSize(capacity, pixelsPerInstance);
    const array = new arrayType(size * size * channels * layers) as unknown as InstanceType<TConstructor>;
    const pixelFormat = getPixelFormatByArrayType(arrayType, channels);

    return { array, size, pixelFormat };
}

/** Data + dirty queue + GPU sync. No exclusive ownership of the Texture. */
export interface ISquareDataTextureWriter<TArray extends TypedArrayType> {
    partialUpdate: boolean;
    maxUpdateCalls: number;
    readonly pixelsPerInstance: number;
    readonly channels: TChannelSize;
    readonly texture: pc.Texture;
    readonly data: InstanceType<TypedArrayConstructorType<TArray>>;
    enqueueUpdate(index: number): void;
    enqueueDataUpdate(index: number, inData: TArray, offset?: number): void;
    upload(): void;
    update(): void;
}

/** Owns capacity + GPU resource lifetime (Host). */
export interface ISquareDataTexture<TArray extends TypedArrayType>
    extends ISquareDataTextureWriter<TArray> {
    readonly capacity: number;
    readonly hasTexture: boolean;
    resize(count: number): void;
    destroy(): void;
}

export interface ISquareDataTextureParams<TArray extends TypedArrayType> {
    arrayConstructor: TypedArrayConstructorType<TArray>,
    channels: TChannelSize,
    pixelsPerInstance: number,
    capacity?: number,
    pixelFormat?: number,
    defaultPixelValue?: number,
    name?: string
}

/**
 * Square data texture Host (`sampler2D`).
 * Owns CPU buffer + optional GPU texture; writers use {@link ISquareDataTextureWriter}.
 * CPU reads/writes (`data`, enqueue, resize) never create a GPU texture.
 * Access {@link texture} or {@link upload} to create it. `device` may be null
 * for CPU-only stores.
 */
export class SquareDataTexture<TArray extends TypedArrayType> implements ISquareDataTexture<TArray> {

    public partialUpdate = true;
    public maxUpdateCalls = Infinity;

    protected _arrayConstructor: TypedArrayConstructorType<TArray>;
    protected _device: pc.GraphicsDevice | null;
    protected _capacity: number;
    protected _size: number;
    protected _name: string;
    protected _texture: pc.Texture | null;
    protected _destroyed: boolean;
    protected _data: InstanceType<TypedArrayConstructorType<TArray>>;
    protected _stride: number;
    protected _channels: TChannelSize;
    protected _pixelsPerInstance: number;
    protected _pixelFormat: number | undefined;
    protected _defaultPixelValue: number | undefined;
    protected _rowBitSet: BitSet;
    protected _rowsUpdateCount: number;
    protected _fullUploadPending: boolean;
    protected _rowsInfo: IUpdateRowInfo[];
    protected _rowsInfoCount: number;
    protected _u8Proxy: Uint8Array;
    protected _alignedUpload: Uint8Array<ArrayBuffer>;
    protected _writeDest: IGpuTextureWriteDest;
    protected _writeLayout: IGpuTextureWriteLayout;
    protected _writeSize: IGpuTextureWriteSize;

    public get pixelsPerInstance() { return this._pixelsPerInstance; }
    public get channels() { return this._channels; }
    public get capacity() { return this._capacity; }
    public get hasTexture() { return this._texture !== null; }
    public get texture(): pc.Texture {
        this._ensureGpuTexture();
        return this._texture!;
    }
    public get data() { return this._data; }

    constructor(device: pc.GraphicsDevice | null, params: ISquareDataTextureParams<TArray>) {

        const {
            arrayConstructor, channels, pixelsPerInstance,
            capacity = 512, pixelFormat, defaultPixelValue,
            name = "SquareDataTexture"
        } = params;

        this._device = device;
        this._channels = channels;
        this._arrayConstructor = arrayConstructor;
        this._pixelsPerInstance = pixelsPerInstance;
        this._pixelFormat = pixelFormat;
        this._defaultPixelValue = defaultPixelValue;
        this._stride = pixelsPerInstance * channels;
        this._size = 0;
        this._capacity = 0;
        this._name = name;
        this._texture = null;
        this._destroyed = false;
        this._rowsUpdateCount = 0;
        this._fullUploadPending = false;
        this._rowsInfoCount = 0;
        this._rowsInfo = [];
        this._rowBitSet = null!;
        this._u8Proxy = new Uint8Array(0);
        this._alignedUpload = new Uint8Array(0);

        const writeScratch = createGpuTextureWriteScratch();
        this._writeDest = writeScratch.dest;
        this._writeLayout = writeScratch.layout;
        this._writeSize = writeScratch.size;

        this._ensureCpuStorage(capacity);
    }

    public destroy(): void {
        this._texture?.destroy();
        this._texture = null;
        this._destroyed = true;
    }

    private _assertNotDestroyed(): void {
        if (this._destroyed) {
            throw new Error("SquareDataTexture is destroyed");
        }
    }

    private _initScratchForSize(size: number): void {

        this._size = size;
        this._rowBitSet = new BitSet(size);

        const rowsInfo = this._rowsInfo;

        if (rowsInfo.length < size) {
            for (let i = rowsInfo.length; i < size; i++) {
                rowsInfo[i] = { row: 0, count: 0 };
            }
        }

        this._u8Proxy = new Uint8Array(this._data.buffer, this._data.byteOffset, this._data.byteLength);
        this._clearDirty();
    }

    private _clearDirty(): void {
        this._rowBitSet.clear();
        this._rowsUpdateCount = 0;
        this._fullUploadPending = false;
        this._rowsInfoCount = 0;
    }

    private _suppressEngineUpload(): void {
        if (this._texture) {
            this._texture._needsUpload = false;
            this._texture._needsMipmapsUpload = false;
        }
    }

    private _ensureCpuStorage(count: number): void {

        this._capacity = count;

        const size = getSquareTextureSize(this._capacity, this._pixelsPerInstance);

        if (this._data && size === this._size) {
            return;
        }

        const newData = new this._arrayConstructor(size * size * this._channels);

        if (this._defaultPixelValue !== undefined) {
            newData.fill(this._defaultPixelValue);
        }

        if (this._data) {
            const copyCount = Math.min(this._data.length, newData.length);
            newData.set(this._data.subarray(0, copyCount));
        }

        this._data = newData;
        this._initScratchForSize(size);
    }

    private _ensureGpuTexture(): void {

        if (this._texture) {
            return;
        }

        this._assertNotDestroyed();

        const device = this._device;
        if (!device) {
            throw new Error("SquareDataTexture: graphics device is required to create a GPU texture");
        }

        const pixelFormat = this._pixelFormat ?? getPixelFormatByArrayType(
            this._arrayConstructor,
            this._channels
        );

        this._texture = new pc.Texture(device, {
            name: this._name,
            width: this._size,
            height: this._size,
            format: pixelFormat,
            mipmaps: false,
            minFilter: pc.FILTER_NEAREST,
            magFilter: pc.FILTER_NEAREST,
            addressU: pc.ADDRESS_CLAMP_TO_EDGE,
            addressV: pc.ADDRESS_CLAMP_TO_EDGE,
            storage: true
        });

        this._attachLevelsAndUpload();
        this._clearDirty();
    }

    /**
     * WebGPU: own upload (engine path skips 256-byte bytesPerRow).
     * WebGL2: engine upload.
     */
    private _attachLevelsAndUpload(): void {

        const device = this._device;
        const texture = this._texture;
        if (!device || !texture) {
            return;
        }

        texture._levels[0] = this._data as any;

        if (device.isWebGPU) {
            this._suppressEngineUpload();
            this._uploadAll();
            this._suppressEngineUpload();
        }
        else {
            texture.upload();
            this._suppressEngineUpload();
        }
    }

    public resize(count: number): void {

        this._ensureCpuStorage(count);

        if (!this._texture) {
            return;
        }

        if (this._texture.width === this._size) {
            return;
        }

        this._texture._levels[0] = this._data as any;
        this._texture.resize(this._size, this._size);
        this._attachLevelsAndUpload();
    }

    public enqueueUpdate(index: number): void {

        if (!this.partialUpdate) {
            this._fullUploadPending = true;
            return;
        }

        const size = this._size;
        const elementsPerRow = size / this._pixelsPerInstance;
        const rowIndex = (index / elementsPerRow) | 0;

        if (this._rowBitSet.exchange(rowIndex, true) === false) {
            this._rowsUpdateCount++;
        }
    }

    public enqueueDataUpdate(index: number, inData: TArray, offset: number = 0): void {

        this.enqueueUpdate(index);

        const dataIndex = index * this._stride;
        const data = this._data;
        const stride = this._stride;

        let inIndex = offset;
        let tmpIndex = dataIndex;

        for (; inIndex < stride;) {
            data[tmpIndex++] = inData[inIndex++];
        }
    }

    protected _fillRowsInfo(): void {

        const bitSet = this._rowBitSet;
        const rowsInfo = this._rowsInfo;

        let infoCount = 0;
        let regionRow = -1;
        let regionCount = 0;

        bitSet.forEachFilter(true, (row) => {

            if (regionCount === 0) {
                regionRow = row;
                regionCount = 1;
                return;
            }

            if (row === regionRow + regionCount) {
                regionCount++;
                return;
            }

            const info = rowsInfo[infoCount++];
            info.row = regionRow;
            info.count = regionCount;

            regionRow = row;
            regionCount = 1;
        });

        if (regionCount > 0) {
            const info = rowsInfo[infoCount++];
            info.row = regionRow;
            info.count = regionCount;
        }

        this._rowsInfoCount = infoCount;
    }

    protected _uploadAll(): void {

        const info = this._rowsInfo[0];
        info.row = 0;
        info.count = this._size;

        this._updateRows(this._rowsInfo, 1);
    }

    protected _updateRows(info: IUpdateRowInfo[], count: number): void {

        const texture = this._texture;
        const device = this._device;
        if (!texture || !device) {
            return;
        }

        const channels = this._channels;

        if (device.isWebGL2) {

            const glDevice = device as pc.WebglGraphicsDevice;

            this._suppressEngineUpload();
            glDevice.setTexture(texture, 0);
            glDevice.setUnpackFlipY(false);
            glDevice.setUnpackPremultiplyAlpha(texture.premultiplyAlpha);
            glDevice.setUnpackAlignment(1);

            const gl = glDevice.gl;
            const width = this._size;
            const glFormat = texture.impl._glFormat;
            const glPixelType = texture.impl._glPixelType;
            const data = this._data;

            for (let i = 0; i < count; i++) {
                const region = info[i];
                const row = region.row;
                const rowCount = region.count;

                gl.texSubImage2D(
                    gl.TEXTURE_2D,
                    0,
                    0,
                    row,
                    width,
                    rowCount,
                    glFormat,
                    glPixelType,
                    data,
                    row * width * channels
                );
            }

            this._suppressEngineUpload();
        }
        else if (device.isWebGPU) {

            const wgpu = (device as any).wgpu as GPUDevice;
            const wgpuTexture = texture.impl.gpuTexture as GPUTexture;
            const width = this._size;
            const formatInfo = pc.pixelFormatInfo.get(texture.format);
            const bytesPerPixel = formatInfo!.size!;
            const bytesPerRowUnaligned = width * bytesPerPixel;
            const bytesPerRow = Math.ceil(bytesPerRowUnaligned / 256) * 256;

            const proxy = this._u8Proxy;
            const dest = this._writeDest;
            const origin = dest.origin;
            const layout = this._writeLayout;
            const writeSize = this._writeSize;

            dest.texture = wgpuTexture;
            dest.mipLevel = 0;
            layout.offset = 0;
            layout.bytesPerRow = bytesPerRow;
            writeSize.width = width;
            writeSize.depthOrArrayLayers = 1;
            origin.x = 0;
            origin.z = 0;

            for (let i = 0; i < count; i++) {
                const region = info[i];
                const row = region.row;
                const rowCount = region.count;
                const requiredBufferSize = bytesPerRow * rowCount;

                if (this._alignedUpload.length < requiredBufferSize) {
                    this._alignedUpload = new Uint8Array(requiredBufferSize);
                }

                const alignedData = this._alignedUpload;

                for (let subRow = 0; subRow < rowCount; subRow++) {
                    const srcStart = (row + subRow) * bytesPerRowUnaligned;
                    const destStart = subRow * bytesPerRow;

                    for (let b = 0; b < bytesPerRowUnaligned; b++) {
                        alignedData[destStart + b] = proxy[srcStart + b];
                    }
                }

                origin.y = row;
                layout.rowsPerImage = rowCount;
                writeSize.height = rowCount;

                wgpu.queue.writeTexture(dest, alignedData, layout, writeSize);
            }

            this._suppressEngineUpload();
        }
    }

    public upload(): void {
        this._ensureGpuTexture();
        this._uploadAll();
        this._suppressEngineUpload();
        this._clearDirty();
    }

    public update(): void {

        if (!this._texture) {
            return;
        }

        if (this._fullUploadPending) {
            this._uploadAll();
        }
        else if (this._rowsUpdateCount < 1) {
            return;
        }
        else {
            this._fillRowsInfo();

            if (this._rowsInfoCount > this.maxUpdateCalls) {
                this._uploadAll();
            }
            else {
                this._updateRows(this._rowsInfo, this._rowsInfoCount);
            }
        }

        this._suppressEngineUpload();
        this._clearDirty();
    }
}
