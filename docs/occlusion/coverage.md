# Coverage buffer

Coverage downsamples the camera depth grab to a packed **view-space Z** map (metres, default 256×128), downloads it, and tests AABBs on a Web Worker. Occluders are whatever already wrote scene depth. You get a CPU `getOcclusionStatus` on WebGL2 and WebGPU.

`OcclusionCullingSystem` does **not** create this path. Instantiate a buffer plus `CoverageBufferTesterWorker` yourself.

GPU chain levels stay in device Z. The pack pass linearizes. The worker reprojects the last finished capture into the current camera, then tests queued AABBs against that map.

## Setup

Enable PlayCanvas depth grab on the camera, then pick the buffer that matches the device:

```ts
import {
    WebglCoverageBuffer,
    WebgpuCoverageBuffer,
    CoverageBufferTesterWorker,
    OCCLUSION_OCCLUDED,
} from "playcanvas-opti-pixel";

camera.camera.requestSceneDepthMap(true);

const coverage = device.isWebGPU
    ? new WebgpuCoverageBuffer(device)
    : new WebglCoverageBuffer(device);

const tester = new CoverageBufferTesterWorker(coverage); // AABB capacity 4096

const id = tester.lock(meshAabb, worldMatrix);

app.on("frameupdate", (dt) => {
    tester.frameUpdate(dt);
});

app.on("update", () => {
    tester.enqueue(id);
    tester.execute(camera.camera);

    if (tester.getOcclusionStatus(id) !== OCCLUSION_OCCLUDED) {
        // draw — treat OCCLUSION_UNKNOWN as visible
    }
});

app.on("postrender", () => {
    tester.updateGPUDepthBuffer(camera.camera);
});
```

`lock` / `unlock` / `enqueueAabbUpdate` live on the tester. Coverage owns a CPU AABB pool (`CoverageAABBStore`); it does not use the shared [`AABBStore`](../extras.md).

Call `tester.destroy()` and `coverage.destroy()` when done. `tester.resize(newCapacity)` grows the AABB pool. Canvas / depth-grab size changes: `coverage.resizeWithDelay()` (or `resize()`).

## Frame contract

The three calls are not interchangeable.

| Call | When | What it does |
| --- | --- | --- |
| `tester.frameUpdate(dt)` | Every frame, typically on `frameupdate`, **before** `enqueue` / `execute` | Harvest the newest finished GPU download into `coverage.cpuDepth` |
| `tester.enqueue` then `execute(camera)` | `update`, after harvest | Copy the last capture (if `cpuVersion` changed), transfer a job bus to the worker, clear the queue |
| `tester.updateGPUDepthBuffer(camera)` | After opaque depth (`postrender`) | Max-downsample the depth grab and pack view-space Z. Starts a new async readback. |

```mermaid
sequenceDiagram
    participant App
    participant Buffer as Coverage buffer
    participant Tester
    participant Worker

    App->>Tester: frameUpdate(dt)
    Tester->>Buffer: harvest newest ready slot
    App->>Tester: enqueue(id)
    App->>Tester: execute(camera)
    alt cpuReady, worker idle, bus on main
        Tester->>Worker: transferable bus plus write slot
        Worker->>Worker: reproject, AABB tests
        Worker-->>Tester: bus plus flags (published slot)
    else worker busy (bus in flight)
        Note over Tester: keep queue; last flags stay
    else not cpuReady / resizePending / disabled
        Note over Tester: flags UNKNOWN, queue cleared
    end
    App->>Tester: updateGPUDepthBuffer(camera)
    Tester->>Buffer: downsample plus pack plus beginRead
```

- Results belong to a **previous** completed job. The first frames return `OCCLUSION_UNKNOWN`.
- Treat `UNKNOWN` as visible. Only skip the draw on `OCCLUSION_OCCLUDED`.
- `enqueue` returns `-1` (`SOME_ENQUEUE_PROBLEM`) when the per-frame queue is already at AABB capacity.
- One in-flight worker job. If the bus is with the worker, `execute` returns without submitting; **enqueued ids are kept**. Do not enqueue the same id again while that queue is still held.
- After a completed job, ids that were **not** in that queue become `UNKNOWN` in the published flags.
- If the buffer is disabled, not `cpuReady`, or `resizePending`, `execute` fills `UNKNOWN` and **clears** the queue.
- `OcclusionCullingSystem` does not call coverage `frameUpdate`. You must.

`update` without a depth grab is a no-op (no `renderPassDepthGrab` texture). Enable `requestSceneDepthMap(true)` before the first pack.

## GPU downsample and pack

Both devices keep a 256∶128 aspect at every level (`stages = min(maxDownsampleStages, max(1+log2(src/cap)))`, default `maxDownsampleStages` 4). Each pass is a 4-tap **max**. The last level is packed to `maxWidth` × `maxHeight` (defaults 256×128) as float view-space Z.

| Device | Downsample | Pack | Download |
| --- | --- | --- | --- |
| WebGL2 (`WebglCoverageBuffer`) | Fullscreen quads | Transform feedback | `copyBufferSubData` into a STREAM_READ PBO, `fenceSync` |
| WebGPU (`WebgpuCoverageBuffer`) | Compute | Compute into a storage buffer | `StorageBuffer.read` (throwaway MAP_READ staging) |

Coverage harvests the **newest** ready capture and drops older ready slots. That is different from WebGL HZB, which stays FIFO because each HZB slot is a different AABB queue.

Do not harvest from `update` / `postrender`. `frameUpdate` is the poll.

On canvas resize the depth grab size changes; `update` calls `resize` when the grab texture size does not match `screenWidth` / `screenHeight`. `resizePending` (from `resizeWithDelay`) makes `updateGPUDepthBuffer` skip the chain until the timeout fires.

## Readback knobs

Shared by both buffers (defaults match WebGL HZB):

| Property | Default | Meaning |
| --- | --- | --- |
| `readbackSlots` | `4` | In-flight pack/download slots. WebGL clamps to at least **2**. |
| `minReadbackLag` | `2` | `frameUpdate` ticks to wait before polling a slot |

WebGL only:

| Property | Default | Meaning |
| --- | --- | --- |
| `readbackPeriod` | `1` | Submit a packed capture every N `updateGPUDepthBuffer` attempts. Harvest still polls every `frameUpdate`. The downsample chain is skipped on ticks that will not capture. On Android Chrome, `getBufferSubData` is an ordered GPU-process wait — set this to `3` (or higher) there. |

WebGL constructor: `new WebglCoverageBuffer(device, maxWidth?, maxHeight?, slotCount?, minReadbackLag?)`.

WebGPU constructor: `new WebgpuCoverageBuffer(device, maxWidth?, maxHeight?)`. Slot count and lag are still settable after construct. WebGPU has no `readbackPeriod`; `acquire` refuses a second submit in the same `frameUpdate` tick.

Do not call `gl.flush()` after the PBO fence. Leave pending copies alone — aborting them would rewrite a STREAM_READ buffer (WebGL) or a storage buffer (WebGPU) while a copy may still be in flight.

Typical latency is **~2+ frames**: pack, lag, harvest, then a worker job.

## Worker job

`CoverageBufferTesterWorker` owns:

- the AABB pool
- one transferable **job bus** (packed depth, AABBs, camera, queue)
- a two-slot ping-pong **output** ring (reprojected depth + flags)

`CoverageCpuBuffer` runs only inside the blob worker. Last flags stay in the published slot while the write slot is with the worker.

Each idle `execute` with `cpuReady`:

1. Flushes dirty AABBs into the bus (full copy after construct/resize, otherwise incremental `lock` / `enqueueAabbUpdate` ids).
2. Copies `coverage.cpuDepth` when `cpuVersion` changed, plus the capture view-projection and `camera_params`.
3. Writes the **current** view-projection, view matrix, camera position, `aabbExpand`, `rectPadPixels`, and queue ids.
4. Transfers the bus and the write slot. The queue is cleared.

The worker reprojects capture depth into the current camera (perspective only; orthographic leaves the map at far), fills scatter holes from a 3×3 neighbourhood, then tests each queued AABB:

- Camera inside the (expanded) box → visible
- Box behind far, or fully in front of the nearest coverage sample → visible
- Box farther than every coverage sample → occluded
- Else: project the box, pad the pixel rect, occlude only if **every** texel is nearer than the box’s nearest eye Z

Moving occludees: `tester.enqueueAabbUpdate(id, aabb, matrix?)`. Prefer that over poking the internal store.

## Conservativeness

| Property | Default | Meaning |
| --- | --- | --- |
| `tester.aabbExpand` | `0` | World AABB inflate as a fraction of camera-to-box distance. Written into the bus each job. |
| `tester.rectPadPixels` | `0` | Extra coverage pixels around the projected rect. |

The 256×128 max-downsample is coarse. Thin occluders, foliage, and objects smaller than a texel tend to stay visible. Objects that write depth **after** `updateGPUDepthBuffer` do not occlude this capture. Near-plane / first-person geometry in the grab can self-occlude; exclude it from the grab or from the test set.

Reprojection is always one capture behind the camera. Fast camera motion leaves holes; those fill to far (conservative: less occlusion).

## Debug overlay

`CoverageBufferDebugger` is a package export. Bind the tester so overlays can read packed CPU depth and the last reprojected map:

```ts
import { CoverageBufferDebugger } from "playcanvas-opti-pixel";

const debug = new CoverageBufferDebugger(app, tester);

app.on("update", () => {
    tester.enqueue(id);
    tester.execute(camera.camera);

    debug.drawDepth(0, 0, 0.35, 0.35);
    debug.drawReprojectedDepth(0.35, 0, 0.35, 0.35);
    debug.debugItem(id); // world AABB (green visible / red occluded) plus screen rect
});
```

- `drawDepth` — last harvested packed view-space Z (`coverage.cpuDepth`)
- `drawReprojectedDepth` — worker output (`tester.cpuViewer`)
- `debugItem(id, box?, rect?)` — uses `tester.getDebugInfo`

`CoverageCpuBufferViewer` (`tester.cpuViewer`) can also query min/max view-space Z over a UV or pixel rectangle of that reprojected map. Origin is bottom-left, same as the packed CPU layout.

Call `debug.destroy()` with the tester.

## Limitations

- Coarser than GPU HZB; not a shadow map or triangle-perfect visibility
- Always delayed: GPU readback lag plus one worker job
- One in-flight worker job; a slow test stalls new submits (queue is retained)
- Perspective cameras only for reprojection; ortho fills the map at far
- You must drive `frameUpdate` and `updateGPUDepthBuffer` yourself

For same-frame GPU indirect draws, use [WebGPU HZB](hzb.md). For explicit CPU occluders and no GPU readback, use [software occlusion](software.md).
