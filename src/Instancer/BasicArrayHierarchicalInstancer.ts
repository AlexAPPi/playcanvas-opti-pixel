import pc from "../engine.js";
import { ColorDataTextureArray } from "../Extras/ColorDataTexture.js";
import { Mat4DataTextureArray } from "../Extras/Mat4DataTexture.js";
import { BasicArrayHierarchicalInstancerLayer } from "./BasicArrayHierarchicalInstancerLayer.js";

/**
 * Parameters for configuring a `BasicArrayHierarchicalInstancer` instance.
 */
export interface IBasicArrayHierarchicalInstancerParams {

    /**
     * Maximum number of instances the shared texture arrays can hold.
     * Call {@link BasicArrayHierarchicalInstancer.resize} to grow; writing an instance does not expand capacity.
     * @default 1000
     */
    capacity?: number;

    /**
     * Number of logical layers (and texture-array depth for matrices/colors).
     * @default 1
     */
    layers?: number;
}

/**
 * Hierarchical instancer backed by `sampler2DArray` data textures.
 * Shared capacity / texture arrays; per-layer LODs and material/sort state via {@link getLayer}.
 *
 * @typeParam TLayer — layer view type returned by {@link getLayer}. Override {@link _createLayer}
 * to construct a specialized subclass.
 */
export class BasicArrayHierarchicalInstancer<
    TLayer extends BasicArrayHierarchicalInstancerLayer<any> = BasicArrayHierarchicalInstancerLayer<any>
> {

    protected _capacity: number;
    protected _layers: number;
    protected _layerList: TLayer[];

    /**
     * Instanced mesh graphics device
     */
    public readonly device: pc.GraphicsDevice;

    /**
     * Matrix texture array host (`sampler2DArray`).
     */
    public matricesTextureArray: Mat4DataTextureArray;

    /**
     * Color texture array host (`sampler2DArray`). Lazy-initialized.
     */
    public colorsTextureArray: ColorDataTextureArray = null!;

    public get capacity(): number { return this._capacity; }

    public get layers(): number { return this._layers; }

    public constructor(device: pc.GraphicsDevice, params: IBasicArrayHierarchicalInstancerParams = {}) {

        const {
            capacity = _defaultCapacity,
            layers = 1
        } = params;

        if (layers < 1) {
            throw new Error("BasicArrayHierarchicalInstancer: layers must be >= 1");
        }

        this.device = device;
        this._capacity = capacity;
        this._layers = layers;
        this._layerList = [];

        this._initMatricesTexture();
        this._syncLayers(layers);
    }

    public getLayer(layer: number): TLayer {

        if (layer < 0 || layer >= this._layerList.length) {
            throw new Error(`BasicArrayHierarchicalInstancer: layer ${layer} OOB (layers=${this._layers})`);
        }

        return this._layerList[layer];
    }

    /**
     * Factory for layer views. Override to supply a specialized layer subclass.
     */
    protected _createLayer(layer: number): TLayer {
        return new BasicArrayHierarchicalInstancerLayer(this, layer) as TLayer;
    }

    protected _syncLayers(layers: number): void {

        const list = this._layerList;

        while (list.length > layers) {
            const removed = list.pop()!;
            removed._destroy();
        }

        while (list.length < layers) {
            list.push(this._createLayer(list.length));
        }

        for (let i = 0; i < list.length; i++) {
            list[i]._rebindTextureProxies();
        }

        this._layers = layers;
    }

    protected _initMatricesTexture(): void {
        this.matricesTextureArray?.destroy();
        this.matricesTextureArray = new Mat4DataTextureArray(this.device, {
            capacity: this.capacity,
            layers: this._layers
        });
    }

    /** @internal — called from layer when colors are first used. */
    public _initColorsTexture(): void {
        this.colorsTextureArray?.destroy();
        this.colorsTextureArray = new ColorDataTextureArray(this.device, {
            capacity: this.capacity,
            layers: this._layers
        });
        for (let i = 0; i < this._layerList.length; i++) {
            this._layerList[i]._bindColorProxy();
        }
    }

    public updateTextures(): void {
        this.matricesTextureArray?.update();
        this.colorsTextureArray?.update();
    }

    /**
     * Release layers, LOD GPU resources and data textures.
     * The instance must not be used after this call.
     */
    public destroy(): void {

        const list = this._layerList;
        while (list.length > 0) {
            list.pop()?._destroy();
        }
        this._layers = 0;

        this.matricesTextureArray?.destroy();
        this.matricesTextureArray = null!;

        this.colorsTextureArray?.destroy();
        this.colorsTextureArray = null!;
    }

    public resize(newCapacity: number) {

        if (this._capacity === newCapacity) {
            return;
        }

        this._capacity = newCapacity;
        this.matricesTextureArray?.resize(newCapacity);
        this.colorsTextureArray?.resize(newCapacity);

        for (let i = 0; i < this._layerList.length; i++) {
            const layer = this._layerList[i];
            layer._onHostCapacityChanged();
            layer._markNeedUpdateMaterials();
        }
    }

    /**
     * Resize logical / texture-array layer count. Recreates GPU textures — materials rebound.
     */
    public resizeLayers(layers: number): void {

        if (layers < 1) {
            throw new Error("BasicArrayHierarchicalInstancer: layers must be >= 1");
        }

        if (layers === this._layers) {
            return;
        }

        this._layers = layers;
        this.matricesTextureArray.resizeLayers(layers);
        this.colorsTextureArray?.resizeLayers(layers);
        this._syncLayers(layers);
    }

    protected _beforeUpdateRenders(dt: number) {

        this.updateTextures();

        const list = this._layerList;
        for (let i = 0; i < list.length; i++) {
            list[i]._beforeUpdateRenders(dt);
        }
    }

    protected _afterUpdateRenders(dt: number) {

        const list = this._layerList;
        for (let i = 0; i < list.length; i++) {
            list[i]._afterUpdateRenders(dt);
        }
    }
}

export default BasicArrayHierarchicalInstancer;

const _defaultCapacity = 1000;
