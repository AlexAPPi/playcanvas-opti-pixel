/**
 * Main-thread depth queries over a view-space Z map (metres).
 * Not used inside the coverage worker blob.
 */
export class CoverageCpuBufferViewer {

    private _depth: Float32Array = new Float32Array(0);
    private _width = 0;
    private _height = 0;

    public farClip = 1e10;

    public get depth() { return this._depth; }
    public get width() { return this._width; }
    public get height() { return this._height; }
    public get valid() {
        return (
            this._width > 0 &&
            this._height > 0 &&
            this._depth.length >= this._width * this._height
        );
    }

    public constructor();
    public constructor(depth: Float32Array, width: number, height: number);
    public constructor(depth?: Float32Array, width: number = 0, height: number = 0) {
        if (depth) {
            this.set(depth, width, height);
        }
    }

    public set(depth: Float32Array, width: number, height: number): void {
        this._depth = depth;
        this._width = width | 0;
        this._height = height | 0;
    }

    /**
     * Nearest view-space Z (metres) over a UV rectangle in 0..1, origin bottom-left
     * (GL / packed CPU). Omit `u1`/`v1` for a single texel. The range is the same
     * coverage map as AABB tests (`[u0,u1)` in texel space). Fully off-screen and
     * an unbound map return {@link farClip}.
     */
    public getMinDepthUv(u0: number, v0: number, u1: number = u0, v1: number = v0): number {
        return this._depthUv(u0, v0, u1, v1, false);
    }

    /** Farthest view-space Z over a UV rectangle. Same coordinates as {@link getMinDepthUv}. */
    public getMaxDepthUv(u0: number, v0: number, u1: number = u0, v1: number = v0): number {
        return this._depthUv(u0, v0, u1, v1, true);
    }

    /**
     * Nearest view-space Z over an inclusive pixel rectangle, origin bottom-left.
     * Omit `x1`/`y1` for a single pixel. Fully off-screen and an unbound map
     * return {@link farClip}.
     */
    public getMinDepthPixels(x0: number, y0: number, x1: number = x0, y1: number = y0): number {
        return this._depthPixels(x0, y0, x1, y1, false);
    }

    /** Farthest view-space Z over an inclusive pixel rectangle. Same coordinates as {@link getMinDepthPixels}. */
    public getMaxDepthPixels(x0: number, y0: number, x1: number = x0, y1: number = y0): number {
        return this._depthPixels(x0, y0, x1, y1, true);
    }

    private _depthUv(u0: number, v0: number, u1: number, v1: number, wantMax: boolean): number {

        if (!this.valid) {
            return this.farClip;
        }

        if (u1 < u0) {
            const t = u0; u0 = u1; u1 = t;
        }

        if (v1 < v0) {
            const t = v0; v0 = v1; v1 = t;
        }

        if (u1 < 0 || v1 < 0 || u0 > 1 || v0 > 1) {
            return this.farClip;
        }

        if (u0 < 0) u0 = 0;
        if (v0 < 0) v0 = 0;
        if (u1 > 1) u1 = 1;
        if (v1 > 1) v1 = 1;

        const w = this._width;
        const h = this._height;
        return this._rectDepth(
            unitToPixel(u0, w),
            unitToPixel(v0, h),
            unitToPixelEnd(u1, w),
            unitToPixelEnd(v1, h),
            wantMax
        );
    }

    private _depthPixels(x0: number, y0: number, x1: number, y1: number, wantMax: boolean): number {

        if (!this.valid) {
            return this.farClip;
        }

        x0 = x0 | 0;
        y0 = y0 | 0;
        x1 = x1 | 0;
        y1 = y1 | 0;

        if (x1 < x0) {
            const t = x0; x0 = x1; x1 = t;
        }
        if (y1 < y0) {
            const t = y0; y0 = y1; y1 = t;
        }

        const lastX = this._width - 1;
        const lastY = this._height - 1;
        if (x1 < 0 || y1 < 0 || x0 > lastX || y0 > lastY) {
            return this.farClip;
        }

        return this._rectDepth(x0, y0, x1, y1, wantMax);
    }

    /** Inclusive walk. Degenerate UV (`x1 < x0`) collapses to start. */
    private _rectDepth(x0: number, y0: number, x1: number, y1: number, wantMax: boolean): number {

        const w = this._width;
        const lastX = w - 1;
        const lastY = this._height - 1;

        if (x0 > lastX) x0 = lastX;
        if (y0 > lastY) y0 = lastY;
        if (x1 > lastX) x1 = lastX;
        if (y1 > lastY) y1 = lastY;
        if (x1 < x0) x1 = x0;
        if (y1 < y0) y1 = y0;
        if (x0 < 0) x0 = 0;
        if (y0 < 0) y0 = 0;
        if (x1 < 0) x1 = 0;
        if (y1 < 0) y1 = 0;

        const data = this._depth;
        let m = data[y0 * w + x0];
        if (wantMax) {
            for (let y = y0; y <= y1; y++) {
                let index = y * w + x0;
                const end = index + (x1 - x0);
                for (; index <= end; index++) {
                    const d = data[index];
                    if (d > m) {
                        m = d;
                    }
                }
            }
        }
        else {
            for (let y = y0; y <= y1; y++) {
                let index = y * w + x0;
                const end = index + (x1 - x0);
                for (; index <= end; index++) {
                    const d = data[index];
                    if (d < m) {
                        m = d;
                    }
                }
            }
        }
        return m;
    }
}

function unitToPixel(u: number, size: number) {
    if (u < 0) u = 0;
    else if (u > 1) u = 1;
    return (u * size) | 0;
}

function unitToPixelEnd(u: number, size: number) {
    if (u < 0) u = 0;
    else if (u > 1) u = 1;
    const r = u * size;
    const i = r | 0;
    return (i === r ? i : i + 1) - 1;
}
