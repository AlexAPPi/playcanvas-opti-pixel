/**
 * Coverage bus + output-slot layout. Used on the main thread by
 * {@link CoverageBufferTesterWorker}. The worker reads the same layout through
 * float/uint offsets in {@link defineCoverageCpuBuffer} — keep HEADER_BYTES in sync.
 *
 * Job bus (one ArrayBuffer):
 * ```
 * 0:   uint32 capacity
 * 4:   uint32 width
 * 8:   uint32 height
 * 12:  uint32 queueCount
 * 16:  uint32 rectPadPixels
 * 20:  float32 camX
 * 24:  float32 camY
 * 28:  float32 camZ
 * 32:  float32 aabbExpand
 * 36:  float32 srcParams[4] // camera_params: 1 / far, far, near, ortho
 * 52:  float32 dstParams[4]
 * 68:  float32 srcVP[16]
 * 132: float32 dstVP[16]
 * 196: float32 view[16]
 * 260: float32 srcDepth[width * height]
 * then float32 aabbCenters[capacity * 4]
 * then float32 aabbHalves[capacity * 4]
 * then uint32  queue[capacity]
 * ```
 *
 * Output slot (ping-pong, separate from the bus):
 * ```
 * 0:   uint32 n0
 * 4:   uint32 capacity
 * 8:   uint32 width
 * 12:  uint32 height
 * 16:  float32 reprojected[n0]
 * then int8 flags[capacity]
 * ```
 *
 * Header indices (Uint32Array on bytes 0..19 of the bus):
 * `[capacity, width, height, queueCount, rectPadPixels]`
 */
export interface ICoverageBusViews {
    buffer: ArrayBuffer;
    header: Uint32Array;
    capacity: number;
    width: number;
    height: number;
    queueCount: number;
    rectPadPixels: number;
    n0: number;
    cam: Float32Array;
    aabbExpand: Float32Array;
    srcParams: Float32Array;
    dstParams: Float32Array;
    srcVP: Float32Array;
    dstVP: Float32Array;
    view: Float32Array;
    srcDepth: Float32Array;
    centers: Float32Array;
    halves: Float32Array;
    queue: Uint32Array;
}

export interface ICoverageOutputViews {
    buffer: ArrayBuffer;
    n0: number;
    capacity: number;
    width: number;
    height: number;
    reprojected: Float32Array;
    flags: Int8Array;
}

export interface ICoverageBusApi {
    readonly HEADER_BYTES: number;
    readonly OUTPUT_HEADER_BYTES: number;
    byteLength(width: number, height: number, capacity: number): number;
    alloc(width: number, height: number, capacity: number): ICoverageBusViews;
    wrap(buffer: ArrayBuffer): ICoverageBusViews;
    outputByteLength(width: number, height: number, capacity: number): number;
    allocOutput(width: number, height: number, capacity: number): ICoverageOutputViews;
    wrapOutput(buffer: ArrayBuffer): ICoverageOutputViews;
    copyAabbSlot(
        srcCenters: Float32Array,
        srcHalves: Float32Array,
        dst: ICoverageBusViews,
        id: number
    ): void;
    copyAabbFromStore(
        centers: Float32Array,
        halves: Float32Array,
        dst: ICoverageBusViews,
        ids: Iterable<number> | null
    ): void;
}

export function defineCoverageBufferBus(): ICoverageBusApi {

    const HEADER_BYTES = 260;
    const OUTPUT_HEADER_BYTES = 16;
    const OCCLUSION_UNKNOWN = -1;

    function byteLength(width: number, height: number, capacity: number): number {
        const n0 = (width | 0) * (height | 0);
        const cap = capacity | 0;
        return HEADER_BYTES + n0 * 4 + cap * 32 + cap * 4;
    }

    function wrap(buffer: ArrayBuffer): ICoverageBusViews {
        const header = new Uint32Array(buffer, 0, 5);
        const capacity = header[0];
        const width = header[1];
        const height = header[2];
        const queueCount = header[3];
        const rectPadPixels = header[4];
        const n0 = width * height;
        const srcOff = HEADER_BYTES;
        const aabbOff = HEADER_BYTES + n0 * 4;
        const queueOff = aabbOff + capacity * 32;
        return {
            buffer,
            header,
            capacity,
            width,
            height,
            n0,
            queueCount,
            rectPadPixels,
            cam: new Float32Array(buffer, 20, 3),
            aabbExpand: new Float32Array(buffer, 32, 1),
            srcParams: new Float32Array(buffer, 36, 4),
            dstParams: new Float32Array(buffer, 52, 4),
            srcVP: new Float32Array(buffer, 68, 16),
            dstVP: new Float32Array(buffer, 132, 16),
            view: new Float32Array(buffer, 196, 16),
            srcDepth: new Float32Array(buffer, srcOff, n0),
            centers: new Float32Array(buffer, aabbOff, capacity * 4),
            halves: new Float32Array(buffer, aabbOff + capacity * 16, capacity * 4),
            queue: new Uint32Array(buffer, queueOff, capacity)
        };
    }

    function alloc(width: number, height: number, capacity: number): ICoverageBusViews {
        const w = width | 0;
        const h = height | 0;
        const cap = capacity | 0;
        const buffer = new ArrayBuffer(byteLength(w, h, cap));
        const header = new Uint32Array(buffer, 0, 5);
        header[0] = cap;
        header[1] = w;
        header[2] = h;
        return wrap(buffer);
    }

    function outputByteLength(width: number, height: number, capacity: number): number {
        const n0 = (width | 0) * (height | 0);
        const cap = capacity | 0;
        return OUTPUT_HEADER_BYTES + n0 * 4 + cap;
    }

    function wrapOutput(buffer: ArrayBuffer): ICoverageOutputViews {
        const header = new Uint32Array(buffer, 0, 4);
        const n0 = header[0];
        const capacity = header[1];
        const width = header[2];
        const height = header[3];
        const reproOff = OUTPUT_HEADER_BYTES;
        const flagsOff = OUTPUT_HEADER_BYTES + n0 * 4;
        return {
            buffer,
            n0,
            capacity,
            width,
            height,
            reprojected: new Float32Array(buffer, reproOff, n0),
            flags: new Int8Array(buffer, flagsOff, capacity)
        };
    }

    function allocOutput(width: number, height: number, capacity: number): ICoverageOutputViews {
        const w = Math.max(1, width | 0);
        const h = Math.max(1, height | 0);
        const cap = Math.max(1, capacity | 0);
        const n0 = w * h;
        const buffer = new ArrayBuffer(outputByteLength(w, h, cap));
        const header = new Uint32Array(buffer, 0, 4);
        header[0] = n0;
        header[1] = cap;
        header[2] = w;
        header[3] = h;
        const views = wrapOutput(buffer);
        views.flags.fill(OCCLUSION_UNKNOWN);
        return views;
    }

    function copyAabbSlot(
        srcCenters: Float32Array,
        srcHalves: Float32Array,
        dst: ICoverageBusViews,
        id: number
    ): void {
        const i = id << 2;
        const centers = dst.centers;
        const halves = dst.halves;
        centers[i] = srcCenters[i];
        centers[i + 1] = srcCenters[i + 1];
        centers[i + 2] = srcCenters[i + 2];
        centers[i + 3] = srcCenters[i + 3];
        halves[i] = srcHalves[i];
        halves[i + 1] = srcHalves[i + 1];
        halves[i + 2] = srcHalves[i + 2];
        halves[i + 3] = srcHalves[i + 3];
    }

    function copyAabbFromStore(
        centers: Float32Array,
        halves: Float32Array,
        dst: ICoverageBusViews,
        ids: Iterable<number> | null
    ): void {
        if (ids === null) {
            const n = Math.min(centers.length, dst.centers.length);
            dst.centers.set(centers.subarray(0, n));
            dst.halves.set(halves.subarray(0, Math.min(halves.length, dst.halves.length)));
            return;
        }
        for (const id of ids) {
            copyAabbSlot(centers, halves, dst, id);
        }
    }

    return {
        HEADER_BYTES,
        OUTPUT_HEADER_BYTES,
        byteLength,
        alloc,
        wrap,
        outputByteLength,
        allocOutput,
        wrapOutput,
        copyAabbSlot,
        copyAabbFromStore
    };
}

export type CoverageBusApi = ICoverageBusApi;
export const CoverageBusApi: ICoverageBusApi = defineCoverageBufferBus();
