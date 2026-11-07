import type { IHierarchicalZBuffer } from "../HZB/IHierarchicalZBuffer.js";
import { selectCoverageMip, type ICoverageMip } from "./CoverageMath.js";

/**
 * Last {@link selectCoverageMip} for one coverage buffer.
 * Pyramid size, mip count, the pack cap, and `uvFactor` change when the
 * pyramid or the cap is resized, not on each capture.
 */
export class CoverageMipCache {

    private _hzbWidth = 0;
    private _hzbHeight = 0;
    private _mipLevels = 0;
    private _maxWidth = 0;
    private _maxHeight = 0;
    private _uvX = 0;
    private _uvY = 0;
    private _mip: ICoverageMip | null = null;

    select(hzb: IHierarchicalZBuffer, maxWidth: number, maxHeight: number): ICoverageMip {

        const uv = hzb.uvFactor;
        const uvX = uv[0];
        const uvY = uv[1];
        const hzbWidth = hzb.width;
        const hzbHeight = hzb.height;
        const mipLevels = hzb.mipLevels;

        const mip = this._mip;
        if (mip &&
            this._hzbWidth === hzbWidth &&
            this._hzbHeight === hzbHeight &&
            this._mipLevels === mipLevels &&
            this._maxWidth === maxWidth &&
            this._maxHeight === maxHeight &&
            this._uvX === uvX &&
            this._uvY === uvY) {
            return mip;
        }

        this._hzbWidth = hzbWidth;
        this._hzbHeight = hzbHeight;
        this._mipLevels = mipLevels;
        this._maxWidth = maxWidth;
        this._maxHeight = maxHeight;
        this._uvX = uvX;
        this._uvY = uvY;
        this._mip = selectCoverageMip(
            hzbWidth,
            hzbHeight,
            mipLevels,
            maxWidth,
            maxHeight,
            uvX,
            uvY
        );
        return this._mip;
    }
}
