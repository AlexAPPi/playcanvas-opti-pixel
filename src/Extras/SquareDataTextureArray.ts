import pc from "../engine.js";
import { BitSet } from "./BitSet.js";
import { type TypedArrayType, type TypedArrayConstructorType } from "./TypedArray.js";
import {
    createGpuTextureWriteScratch,
    getPixelFormatByArrayType,
    getSquareTextureSize,
    type IGpuTextureWriteDest,
    type IGpuTextureWriteLayout,
    type IGpuTextureWriteSize,
    type ISquareDataTextureParams,
    type IUpdateRowInfo,
    type TChannelSize
} from "./SquareDataTexture.js";
import {
    SquareDataTextureLayerProxy,
    type ISquareDataTextureArrayLayerHost
} from "./SquareDataTextureLayerProxy.js";

export interface IUpdateLayerRowInfo extends IUpdateRowInfo {
    layer: number;
}

export interface ISquareDataTextureArrayParams<TArray extends TypedArrayType> extends ISquareDataTextureParams<TArray> {
    layers: number;
}

/**
 * Square data texture backed by a 2D texture array (`sampler2DArray`).
 * Each layer has the same square layout / capacity as {@link SquareDataTexture}.
 * Per-layer writer access: {@link getLayer} / {@link layerProxies}.
 *
 * @typeParam TArray - CPU buffer element type
 * @typeParam TLayerProxy - per-layer writer proxy (defaults to {@link SquareDataTextureLayerProxy})
 */
export class SquareDataTextureArray<
    TArray extends TypedArrayType,
    TLayerProxy extends SquareDataTextureLayerProxy<TArray> = SquareDataTextureLayerProxy<TArray>
> implements ISquareDataTextureArrayLayerHost<TArray> {

    public partialUpdate = true;
    public maxUpdateCalls = Infinity;

    protected _arrayConstructor: TypedArrayConstructorType<TArray>;
    protected _device: pc.GraphicsDevice;
    protected _capacity: number;
    protected _layers: number;
    protected _size: number;
    protected _texture: pc.Texture;
    protected _data: InstanceType<TypedArrayConstructorType<TArray>>;
    protected _layerViews: InstanceType<TypedArrayConstructorType<TArray>>[];
    protected _layerProxies: TLayerProxy[];
    protected _layerStride: number;
    protected _stride: number;
    protected _channels: TChannelSize;
    protected _pixelsPerInstance: number;
    protected _pixelFormat: number | undefined;
    protected _defaultPixelValue: number | undefined;
    protected _rowBitSet: BitSet;
    protected _rowsUpdateCount: number;
    protected _fullUploadPending: boolean;
    protected _rowsInfo: IUpdateLayerRowInfo[];
    protected _rowsInfoCount: number;
    protected _u8Proxy: Uint8Array<ArrayBufferLike>;
    protected _alignedUpload: Uint8Array<ArrayBuffer>;
    protected _writeDest: IGpuTextureWriteDest;
    protected _writeLayout: IGpuTextureWriteLayout;
    protected _writeSize: IGpuTextureWriteSize;

    public get pixelsPerInstance() { return this._pixelsPerInstance; }
    public get channels() { return this._channels; }
    public get layers() { return this._layers; }
    public get capacity() { return this._capacity; }
    public get texture() { return this._texture; }
    public get data() { return this._data; }
    public get layerViews() { return this._layerViews; }
    public get layerProxies(): TLayerProxy[] { return this._layerProxies; }

    constructor(device: pc.GraphicsDevice, params: ISquareDataTextureArrayParams<TArray>) {

        const {
            arrayConstructor, channels, pixelsPerInstance, layers,
            capacity = 512, pixelFormat, defaultPixelValue,
            name = "SquareDataTextureArray"
        } = params;

        if (layers < 1) {
            throw new Error("SquareDataTextureArray: layers must be >= 1");
        }

        this._device = device;
        this._channels = channels;
        this._arrayConstructor = arrayConstructor;
        this._pixelsPerInstance = pixelsPerInstance;
        this._layers = layers;
        this._pixelFormat = pixelFormat;
        this._defaultPixelValue = defaultPixelValue;
        this._stride = pixelsPerInstance * channels;
        this._size = 0;
        this._rowsUpdateCount = 0;
        this._fullUploadPending = false;
        this._rowsInfoCount = 0;
        this._rowsInfo = [];
        this._rowBitSet = null!;
        this._layerViews = null!;
        this._layerProxies = [];
        this._layerStride = 0;
        this._u8Proxy = new Uint8Array(0);
        this._alignedUpload = new Uint8Array(0);

        const writeScratch = createGpuTextureWriteScratch();
        this._writeDest = writeScratch.dest;
        this._writeLayout = writeScratch.layout;
        this._writeSize = writeScratch.size;

        this._createOrResizeTexture(capacity, layers, name);
    }

    /** Override in typed subclasses to construct {@link TLayerProxy}. */
    protected _createLayerProxy(layer: number): TLayerProxy {
        return new SquareDataTextureLayerProxy(this, layer) as TLayerProxy;
    }

    public destroy(): void {
        this._texture?.destroy();
    }

    public getLayerData(layer: number): InstanceType<TypedArrayConstructorType<TArray>> {
        if (layer < 0 || layer >= this._layers) {
            throw new Error(`SquareDataTextureArray: layer ${layer} is out of range [0, ${this._layers})`);
        }
        return this._layerViews[layer];
    }

    public getLayer(layer: number): TLayerProxy {
        if (layer < 0 || layer >= this._layers) {
            throw new Error(`SquareDataTextureArray: layer ${layer} is out of range [0, ${this._layers})`);
        }
        return this._layerProxies[layer];
    }

    private _createLayerViews(
        data: InstanceType<TypedArrayConstructorType<TArray>>,
        size: number,
        layers: number
    ): InstanceType<TypedArrayConstructorType<TArray>>[] {

        this._layerStride = size * size * this._channels;

        const views: InstanceType<TypedArrayConstructorType<TArray>>[] = new Array(layers);

        for (let layer = 0; layer < layers; layer++) {
            const start = layer * this._layerStride;
            views[layer] = data.subarray(start, start + this._layerStride) as InstanceType<TypedArrayConstructorType<TArray>>;
        }

        return views;
    }

    private _syncLayerProxies(layers: number): void {

        const proxies = this._layerProxies;
        const reuse = Math.min(proxies.length, layers);

        if (proxies.length !== layers) {
            proxies.length = layers;
        }

        for (let layer = reuse; layer < layers; layer++) {
            proxies[layer] = this._createLayerProxy(layer);
        }
    }

    private _copyLayersData(
        oldData: InstanceType<TypedArrayConstructorType<TArray>>,
        newData: InstanceType<TypedArrayConstructorType<TArray>>,
        oldLayers: number,
        newLayers: number,
        oldLayerStride: number,
        newLayerStride: number
    ): void {

        const copyLayers = Math.min(oldLayers, newLayers);
        const copyCount = Math.min(oldLayerStride, newLayerStride);

        for (let layer = 0; layer < copyLayers; layer++) {
            newData.set(
                oldData.subarray(layer * oldLayerStride, layer * oldLayerStride + copyCount),
                layer * newLayerStride
            );
        }
    }

    private _initScratchForSize(size: number, layers: number): void {

        this._size = size;
        this._rowBitSet = new BitSet(layers * size);

        const infoCapacity = layers * size;
        const rowsInfo = this._rowsInfo;

        if (rowsInfo.length < infoCapacity) {
            for (let i = rowsInfo.length; i < infoCapacity; i++) {
                rowsInfo[i] = { layer: 0, row: 0, count: 0 };
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
        this._texture._needsUpload = false;
        this._texture._needsMipmapsUpload = false;
    }

    private _createGpuTexture(size: number, layers: number, name?: string, format?: number): void {

        const pixelFormat = format ?? this._pixelFormat ?? getPixelFormatByArrayType(
            this._arrayConstructor,
            this._channels
        );

        this._texture = new pc.Texture(this._device, {
            name: name ?? "SquareDataTextureArray",
            width: size,
            height: size,
            format: pixelFormat,
            mipmaps: false,
            minFilter: pc.FILTER_NEAREST,
            magFilter: pc.FILTER_NEAREST,
            addressU: pc.ADDRESS_CLAMP_TO_EDGE,
            addressV: pc.ADDRESS_CLAMP_TO_EDGE,
            addressW: pc.ADDRESS_CLAMP_TO_EDGE,
            arrayLength: layers,
            storage: true
        });
    }

    private _createOrResizeTexture(count: number, layers: number = this._layers, name?: string): void {

        if (!(count >= 0) || (count | 0) !== count) {
            throw new Error("SquareDataTextureArray: capacity must be a non-negative integer");
        }

        if (!(layers >= 1) || (layers | 0) !== layers) {
            throw new Error("SquareDataTextureArray: layers must be an integer >= 1");
        }

        const size = getSquareTextureSize(count, this._pixelsPerInstance);
        const oldLayers = this._layers;
        const oldLayerStride = this._layerStride;
        const oldData = this._data;
        const hadTexture = !!this._texture;
        const sizeChanged = !hadTexture || size !== this._texture.width;
        const layersChanged = !hadTexture || layers !== oldLayers;

        // Capacity can grow/shrink within the same square size without realloc.
        this._capacity = count;

        if (hadTexture && !sizeChanged && !layersChanged) {
            return;
        }

        const newLayerStride = size * size * this._channels;
        const newData = new this._arrayConstructor(newLayerStride * layers);

        if (this._defaultPixelValue !== undefined) {
            newData.fill(this._defaultPixelValue);
        }

        if (hadTexture && oldData && oldLayerStride > 0) {
            this._copyLayersData(oldData, newData, oldLayers, layers, oldLayerStride, newLayerStride);
        }

        this._layers = layers;
        this._data = newData;
        this._layerViews = this._createLayerViews(newData, size, layers);
        this._syncLayerProxies(layers);
        this._initScratchForSize(size, layers);

        if (!hadTexture) {
            this._createGpuTexture(size, layers, name, this._pixelFormat);
            this._attachLevelsAndUpload();
            return;
        }

        if (layersChanged) {
            // arrayLength is immutable — recreate GPU texture (identity changes).
            const textureName = this._texture.name;
            const textureFormat = this._texture.format;
            this._texture.destroy();
            this._createGpuTexture(size, layers, textureName, textureFormat);
            this._attachLevelsAndUpload();
            return;
        }

        // Capacity/size change only — keep the same Texture object.
        // resize() recreates the GPU impl and clears levels; attach restores them.
        this._texture.resize(size, size);
        this._attachLevelsAndUpload();
    }

    /**
     * Keep engine levels in sync for resize/debug, but always upload pixels ourselves.
     * WebGPU: engine array upload skips 256-byte bytesPerRow.
     * WebGL2: engine upload is bypassed — we own texStorage3D + texSubImage3D.
     */
    private _attachLevelsAndUpload(): void {

        this._texture._levels[0] = this._layerViews as any;
        this._suppressEngineUpload();
        this._uploadAllLayers();
        this._suppressEngineUpload();
    }

    /**
     * Ensure the GL texture exists, parameters are applied, and texStorage3D has run.
     * Must run before any texSubImage3D — otherwise ANGLE validates against the default
     * unsized RGBA image and FLOAT uploads fail with format/type/internalFormat.
     */
    private _ensureWebglArrayStorage(device: pc.WebglGraphicsDevice): void {

        const texture = this._texture;
        const impl = texture.impl;
        const gl = device.gl;

        // Never let setTexture/engine flush pull stale _levels through its upload path.
        this._suppressEngineUpload();

        if (!impl._glTexture) {
            impl.initialize(device, texture);
        }

        device.activeTexture(0);
        device.bindTexture(texture);

        if (impl.dirtyParameterFlags) {
            device.setTextureParameters(texture);
            impl.dirtyParameterFlags = 0;
        }

        if (!impl._glCreated) {
            gl.texStorage3D(
                impl._glTarget,
                texture.numLevels,
                impl._glInternalFormat,
                texture.width,
                texture.height,
                texture.arrayLength
            );
            impl._glCreated = true;
        }

        this._suppressEngineUpload();
    }

    /**
     * Resize instance capacity. Optionally change layer count in the same call.
     * Changing layers recreates the GPU texture (`arrayLength` is immutable).
     */
    public resize(count: number, layers: number = this._layers): void {
        this._createOrResizeTexture(count, layers);
    }

    /**
     * Resize texture-array depth (`sampler2DArray` layers).
     * Recreates the GPU texture; existing layer proxies for kept indices are reused.
     */
    public resizeLayers(layers: number): void {
        this._createOrResizeTexture(this._capacity, layers);
    }

    public enqueueUpdate(index: number): void {
        this.enqueueUpdateLayer(0, index);
    }

    public enqueueDataUpdate(index: number, inData: TArray, offset: number = 0): void {
        this.enqueueDataUpdateLayer(0, index, inData, offset);
    }

    public enqueueUpdateLayer(layer: number, index: number): void {

        if (!this.partialUpdate) {
            this._fullUploadPending = true;
            return;
        }

        const size = this._size;
        const elementsPerRow = size / this._pixelsPerInstance;
        const rowIndex = (index / elementsPerRow) | 0;

        if (this._rowBitSet.exchange(layer * size + rowIndex, true) === false) {
            this._rowsUpdateCount++;
        }
    }

    public enqueueDataUpdateLayer(layer: number, index: number, inData: TArray, offset: number = 0): void {

        this.enqueueUpdateLayer(layer, index);

        const dataIndex = layer * this._layerStride + index * this._stride;
        const data = this._data;
        const stride = this._stride;

        let inIndex = offset;
        let tmpIndex = dataIndex;

        for (; inIndex < stride;) {
            data[tmpIndex++] = inData[inIndex++];
        }
    }

    protected _fillRowsInfo(): void {

        const size = this._size;
        const bitSet = this._rowBitSet;
        const rowsInfo = this._rowsInfo;

        let infoCount = 0;
        let regionLayer = -1;
        let regionRow = -1;
        let regionCount = 0;

        bitSet.forEachFilter(true, (flat) => {

            const layer = (flat / size) | 0;
            const row = flat - layer * size;

            if (regionCount === 0) {
                regionLayer = layer;
                regionRow = row;
                regionCount = 1;
                return;
            }

            if (layer === regionLayer && row === regionRow + regionCount) {
                regionCount++;
                return;
            }

            const info = rowsInfo[infoCount++];
            info.layer = regionLayer;
            info.row = regionRow;
            info.count = regionCount;

            regionLayer = layer;
            regionRow = row;
            regionCount = 1;
        });

        if (regionCount > 0) {
            const info = rowsInfo[infoCount++];
            info.layer = regionLayer;
            info.row = regionRow;
            info.count = regionCount;
        }

        this._rowsInfoCount = infoCount;
    }

    protected _uploadAllLayers(): void {

        const size = this._size;
        const layers = this._layers;
        const rowsInfo = this._rowsInfo;

        // Need one full-layer region descriptor per layer
        // (rowsInfo is sized to layers * size).
        for (let layer = 0; layer < layers; layer++) {
            const info = rowsInfo[layer];
            info.layer = layer;
            info.row = 0;
            info.count = size;
        }

        this._updateRows(rowsInfo, layers);
    }

    protected _updateRows(info: IUpdateLayerRowInfo[], count: number): void {

        const channels = this._channels;

        if (this._device.isWebGL2) {

            const device = this._device as pc.WebglGraphicsDevice;
            this._ensureWebglArrayStorage(device);

            device.setUnpackFlipY(false);
            device.setUnpackPremultiplyAlpha(this._texture.premultiplyAlpha);
            device.setUnpackAlignment(1);

            const gl = device.gl;
            const impl = this._texture.impl;
            const width = this._size;
            const glFormat = impl._glFormat;
            const glPixelType = impl._glPixelType;
            const glTarget = impl._glTarget;
            const layerViews = this._layerViews;
            const elementsPerRow = width * channels;

            for (let i = 0; i < count; i++) {
                const region = info[i];
                const layer = region.layer;
                const row = region.row;
                const rowCount = region.count;

                gl.texSubImage3D(
                    glTarget,
                    0,
                    0,
                    row,
                    layer,
                    width,
                    rowCount,
                    1,
                    glFormat,
                    glPixelType,
                    layerViews[layer],
                    row * elementsPerRow
                );
            }

            this._suppressEngineUpload();
        }
        else if (this._device.isWebGPU) {

            const wgpu = (this._device as any).wgpu as GPUDevice;
            const wgpuTexture = this._texture.impl.gpuTexture as GPUTexture;
            const width = this._size;
            const formatInfo = pc.pixelFormatInfo.get(this._texture.format);
            const bytesPerPixel = formatInfo!.size!;
            const bytesPerRowUnaligned = width * bytesPerPixel;
            const bytesPerRow = Math.ceil(bytesPerRowUnaligned / 256) * 256;
            const layerBytes = width * width * bytesPerPixel;

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

            for (let i = 0; i < count; i++) {
                const region = info[i];
                const layer = region.layer;
                const row = region.row;
                const rowCount = region.count;
                const requiredBufferSize = bytesPerRow * rowCount;

                if (this._alignedUpload.length < requiredBufferSize) {
                    this._alignedUpload = new Uint8Array(requiredBufferSize);
                }

                const alignedData = this._alignedUpload;
                const layerByteOffset = layer * layerBytes;

                for (let subRow = 0; subRow < rowCount; subRow++) {
                    const srcStart = layerByteOffset + (row + subRow) * bytesPerRowUnaligned;
                    const destStart = subRow * bytesPerRow;

                    for (let b = 0; b < bytesPerRowUnaligned; b++) {
                        alignedData[destStart + b] = proxy[srcStart + b];
                    }
                }

                origin.y = row;
                origin.z = layer;
                layout.rowsPerImage = rowCount;
                writeSize.height = rowCount;

                wgpu.queue.writeTexture(dest, alignedData, layout, writeSize);
            }

            this._suppressEngineUpload();
        }
    }

    public upload(): void {
        this._uploadAllLayers();
        this._suppressEngineUpload();
        this._clearDirty();
    }

    public update(): void {

        if (this._fullUploadPending) {
            this._uploadAllLayers();
        }
        else if (this._rowsUpdateCount < 1) {
            return;
        }
        else {
            this._fillRowsInfo();

            if (this._rowsInfoCount > this.maxUpdateCalls) {
                this._uploadAllLayers();
            }
            else {
                this._updateRows(this._rowsInfo, this._rowsInfoCount);
            }
        }

        this._suppressEngineUpload();
        this._clearDirty();
    }
}
