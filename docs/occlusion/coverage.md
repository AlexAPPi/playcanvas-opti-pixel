# Coverage buffer

Coverage reads one mip of an already-built hierarchical Z-buffer, packs it to a **view-space Z** map (metres, at most the default 256×128), downloads it, and tests AABBs on a Web Worker. Occluders are whatever the HZB already reduced. You get a CPU `getOcclusionStatus` on WebGL2 and WebGPU.

`OcclusionCullingSystem` does **not** create this path. Instantiate a buffer plus `CoverageBufferTesterWorker` yourself, and pass the same HZB you update.

Build the pyramid first (`hzb.update` or `hzb.updateSceneDepth`). Coverage does not read the depth grab. It picks the stored mip nearest to `maxWidth` × `maxHeight`, packs that mip so pixel `i` covers screen UV `[i / width, (i + 1) / width]`, takes the max device Z of the HZB texels under that slice, and linearizes that to view-space metres. The worker reprojects the last finished capture into the current camera, then tests queued AABBs against that map.

## Setup

Enable PlayCanvas depth grab on the camera, then pick the buffer that matches the device:

```ts
import {
    WebglHierarchicalZBuffer,
    WebgpuHierarchicalZBuffer,
    WebglCoverageBuffer,
    WebgpuCoverageBuffer,
    CoverageBufferTesterWorker,
    OCCLUSION_OCCLUDED,
} from "playcanvas-opti-pixel";

camera.camera.requestSceneDepthMap(true);

const hzb = device.isWebGPU
    ? new WebgpuHierarchicalZBuffer(device)
    : new WebglHierarchicalZBuffer(device);

const coverage = device.isWebGPU
    ? new WebgpuCoverageBuffer(device)
    : new WebglCoverageBuffer(device);

const tester = new CoverageBufferTesterWorker(coverage); // AABB capacity 4096

const id = tester.lock(meshAabb, worldMatrix);

app.on("frameupdate", (dt) => {
    tester.frameUpdate(dt);
});

app.on("framerender", () => {
    tester.frameRender();
});

app.on("frameend", () => {
    tester.frameEnd();
});

app.on("update", () => {
    tester.enqueue(id);
    tester.execute(camera.camera);

    if (tester.getOcclusionStatus(id) !== OCCLUSION_OCCLUDED) {
        // draw — treat OCCLUSION_UNKNOWN as visible
    }
});

app.on("postrender", () => {
    hzb.update(camera.camera);
    tester.updateGPUDepthBuffer(hzb, camera.camera);
});
```

`CameraFrame` does not create a depth grab. Enable its scene depth and build the pyramid from that. `requestSceneDepthMap` is ignored while `framePasses` is set.

```ts
cameraFrame.rendering.sceneDepthMap = true;
cameraFrame.update();

app.on("postrender", () => {
    hzb.updateSceneDepth(camera.camera);
    tester.updateGPUDepthBuffer(hzb, camera.camera);
});
```

`rendering.sceneDepthMap` forces the linear prepass. TAA, DoF, volumetric fog, or SSAO combine can publish scene depth on their own (sometimes as `1 / viewZ`). `hzb.updateSceneDepth` decodes that into device Z; coverage linearizes the chosen mip back to view-space metres. Call both from `postrender` — in `update` the map is still the previous frame while the stored view-projection is this frame's.

`lock` / `unlock` / `enqueueAabbUpdate` live on the tester. Coverage owns a CPU AABB pool (`CoverageAABBStore`); it does not use the shared [`AABBStore`](../extras.md).

Call `tester.destroy()` and `coverage.destroy()` when done. `tester.resize(newCapacity)` grows the AABB pool. The HZB owns canvas resize. `coverage.resize(maxWidth, maxHeight)` changes only the packed map.

## Frame contract

These calls are not interchangeable.

| Call | When | What it does |
| --- | --- | --- |
| `tester.frameUpdate(dt)` | Every frame, on `frameupdate`, **before** `enqueue` / `execute` | Advance the readback frame counter. WebGPU also starts `mapAsync` for a copy the previous `frameEnd` could not map yet |
| `tester.frameRender()` | Every frame, on `framerender` | Copy the newest finished download into `coverage.cpuDepth` and drop the older ones. WebGL copies only after that capture's frame fence has signaled; `getBufferSubData` can still wait for newer commands already recorded. WebGPU copies a map `mapAsync` has already finished |
| `tester.frameEnd()` | Every frame, on `frameend`, after the capture | Close the frame: WebGL fences everything it recorded, WebGPU starts `mapAsync` for its copy |
| `tester.enqueue` then `execute(camera)` | `update` | Copy the last published capture (if `cpuVersion` changed). When the worker is idle, transfer the job bus and clear the queue. A busy worker keeps the queue |
| `hzb.update` or `hzb.updateSceneDepth`, then `tester.updateGPUDepthBuffer(hzb, camera)` | After opaque depth (`postrender`) | Build the pyramid, then pack its chosen mip to view-space Z and start an async readback on a free slot. The pack is skipped when every slot is busy, or on a tick that `readbackPeriod` skips. |

```mermaid
sequenceDiagram
    participant App
    participant HZB
    participant Buffer as Coverage buffer
    participant Tester
    participant Worker

    App->>Tester: frameUpdate(dt)
    App->>Tester: enqueue(id)
    App->>Tester: execute(camera)
    alt cpuReady, worker idle, bus on main
        Tester->>Worker: transferable bus plus write slot
        Worker->>Worker: reproject, AABB tests
        Worker-->>Tester: bus plus flags (published slot)
    else worker busy (bus in flight)
        Note over Tester: keep queue, last flags stay
    else not cpuReady / disabled
        Note over Tester: flags UNKNOWN, queue cleared
    end
    App->>Tester: frameRender()
    alt WebGL fence covers that capture, or the WebGPU map is ready
        Tester->>Buffer: publish the newest finished download
    else still running
        Note over Buffer: keep it for a later frame
    end
    App->>HZB: update or updateSceneDepth
    App->>Tester: updateGPUDepthBuffer(hzb, camera)
    alt a readback slot is free
        Tester->>Buffer: pack the chosen mip and beginRead
    else every slot busy, or this tick is skipped
        Note over Buffer: skip pack and readback
    end
    App->>Tester: frameEnd()
    Tester->>Buffer: WebGL frame fence / WebGPU mapAsync
```

- Results belong to a **previous** completed job. The first frames return `OCCLUSION_UNKNOWN`.
- Treat `UNKNOWN` as visible. Only skip the draw on `OCCLUSION_OCCLUDED`.
- `enqueue` returns `-1` (`SOME_ENQUEUE_PROBLEM`) when the per-frame queue is already at AABB capacity.
- One in-flight worker job. If the bus is with the worker, `execute` returns without submitting; **enqueued ids are kept**. Do not enqueue the same id again while that queue is still held.
- After a completed job, ids that were **not** in that queue become `UNKNOWN` in the published flags.
- If the buffer is disabled or not `cpuReady`, `execute` fills `UNKNOWN` and **clears** the queue.
- `OcclusionCullingSystem` does not call coverage `frameUpdate`, `frameRender`, or `frameEnd`. You must.

`capture` without a pyramid texture is a no-op. Enable `requestSceneDepthMap(true)` (or CameraFrame scene depth) before `hzb.update` / `hzb.updateSceneDepth`, and call that before `updateGPUDepthBuffer`.

## Pack from an HZB mip

`maxWidth` × `maxHeight` (defaults 256×128) is the cap, not the map. Each axis picks the stored mip nearest to that cap; the coarser of the two is packed. The downloaded map is the screen footprint rounded to whole texels, and never larger than the cap. Pixel `i` covers screen UV `[i / cpuWidth, (i + 1) / cpuWidth]` and reads the HZB texel under the centre of that slice. A fractional footprint is rounded rather than ceiled, so the leftover does not become its own cell and shift the map. A slice wider than one and a half texels maxes every texel it overlaps. If that would still cover three or more source texels per packed pixel, the next coarser mip is used. WebGL HZB does not store levels finer than its `maxSize` (default 256), so those are not available to coverage. `uvFactor` is the HZB's own screen-to-mip scale, so padding outside the screen is not packed as full NDC.

`cpuWidth` × `cpuHeight` is the harvested footprint in texels. Until the first harvest, and after `resize` changes the packed pixel count, those report the cap. Pixel `i` covers `[i / cpuWidth, (i + 1) / cpuWidth]` (and the same on Y). Each packed texel is the device Z of the HZB texel under that cell (the max, when the cell covers more than one), then linearized to float view-space Z. Row 0 of the download is the bottom of the screen.

| Device | Pack | Download |
| --- | --- | --- |
| WebGL2 (`WebglCoverageBuffer`) | Transform feedback, `texelFetch` of the mip | Ring of `readbackSlots` `STREAM_READ` PBOs (default 2). `copyBufferSubData`, one fence per frame kept until it signals. At most one `getBufferSubData` per `frameRender` |
| WebGPU (`WebgpuCoverageBuffer`) | Compute, `textureLoad` of the mip, into one storage buffer | Ring of `readbackSlots` persistent `MAP_READ` staging buffers (default 5). `copyBufferToBuffer`, then `mapAsync` from `frameEnd`, retried on the next `frameUpdate` |

Up to `readbackSlots` packed downloads stay in flight. A new pack starts on a capture tick whenever a slot is free, so call it from every `postrender` after the HZB update. A frame with no free slot, and a tick that `readbackPeriod` skips, does no GPU work.

`frameRender` publishes the **newest** eligible slot and retires the older ones unread. Coverage is not FIFO (HZB readback is): every capture replaces the whole depth map, so an older one is only staler. Draining FIFO would pin the latency at `readbackSlots` — once the ring filled, each tick would free exactly one slot and the next capture would refill it, so the oldest would never get younger.

Do not harvest from `capture` / `postrender`. On ANGLE `getBufferSubData` waits for every command recorded so far, not only the copy it reads, so the copy runs only once a fence inserted after that capture has signaled. `frameEnd` inserts that fence in a microtask after the rest of `frameend` (no `gl.flush()`), and the fence is kept until then. Chromium does not signal it on the next frame: the commands flush with the following frame, and `SYNC_STATUS` comes back a frame after that. `frameRender` polls the oldest open fence once and publishes the newest slot that fence covers. A slot newer than the newest signaled fence stays pending; age does not drop it. Nothing forces a copy. The last published map stops counting after `maxResultAge` frames: `cpuReady` goes false and the tester returns `UNKNOWN`.

WebGPU follows the same schedule without a fence. `mapAsync` never blocks. `frameEnd` starts it after the frame's submit, and the next `frameUpdate` retries a copy that was still on the open encoder. `frameRender` publishes the newest map that has finished mapping and whose lag has elapsed, and leaves the rest.

The readback ring is allocated for `maxWidth` × `maxHeight` pixels. A window resize changes the HZB and therefore the footprint (`cpuWidth` / `cpuHeight` on the next harvest), not this ring, so in-flight captures and the last published one survive — coverage keeps culling while the window is being dragged. Changing `maxWidth` / `maxHeight` rebuilds the ring only when that pixel count changes, and the rebuild clears `cpuReady` until the next capture lands. A same-count change keeps the ring, in-flight captures, and the published map.

## Readback knobs

Shared by both coverage buffers. WebGL HZB uses the same lag, age, and period; its ring defaults to 3.

| Property | Default | Meaning |
| --- | --- | --- |
| `readbackSlots` | `2` WebGL, `5` WebGPU | In-flight download slots, clamped to at least `2`. Coverage acquires after `frameRender` publishes, and a newer map drops the older ones, so two WebGL slots are enough. A dropped WebGPU slot stays busy until its `mapAsync` settles, hence the larger ring. Changing it drops downloads that have not landed. `cpuDepth` from the last finished slot stays. |
| `minReadbackLag` | `1` | Frames from a capture to its earliest copy into `cpuDepth`, clamped to at least `1`. On WebGL the frame fence also has to have signaled; Chromium does that two frames after the capture. On WebGPU the map also has to have finished. A larger value only adds latency. |
| `maxResultAge` | `10` | Frames, counted from the capture, a published map stays valid. Past that `cpuReady` is false. Never shorter than `minReadbackLag + readbackPeriod`. |
| `readbackPeriod` | `1` | While a slot is free, submit a packed capture every N `updateGPUDepthBuffer` attempts. A busy ring does not advance the counter. `frameRender` still publishes every frame. On Android Chrome WebGL, `getBufferSubData` is an ordered GPU-process wait — set this to `3` (or higher) there. |

WebGL constructor: `new WebglCoverageBuffer(device, maxWidth?, maxHeight?, minReadbackLag?)`.

WebGPU constructor: `new WebgpuCoverageBuffer(device, maxWidth?, maxHeight?)`. Lag, `readbackSlots`, `maxResultAge`, and `readbackPeriod` are settable after construct. Both skip the pack when every slot is busy, and on a tick `readbackPeriod` skips.

Do not call `gl.flush()` or `clientWaitSync`. Leave a slot's PBO or staging buffer alone until that slot has been read.

On WebGL in Chromium the frame fence signals on the `frameRender` two frames after the capture, and `execute` on the following `update` consumes it, then a worker job. Where that fence signals sooner, latency is `minReadbackLag` frames. On WebGPU the same lag applies once `mapAsync` has finished.

## Worker job

`CoverageBufferTesterWorker` owns:

- the AABB pool
- one transferable **job bus** (packed depth, AABBs, camera, queue)
- a two-slot ping-pong **output** ring (reprojected depth + flags)

`CoverageCpuBuffer` runs only inside the blob worker. Last flags stay in the published slot while the write slot is with the worker.

Each idle `execute` with `cpuReady`:

1. Flushes dirty AABBs into the bus (full copy after construct/resize, otherwise incremental `lock` / `enqueueAabbUpdate` ids).
2. Copies `coverage.cpuDepth` when `cpuVersion` changed, plus the capture view-projection and `camera_params`.
3. Writes the **current** view-projection, view matrix, camera position, `aabbExpand`, `rectPadPixels`, `depthBias`, and queue ids.
4. Transfers the bus and the write slot. The queue is cleared.

The worker reprojects capture depth into the current camera (perspective only; orthographic leaves the map at far):

1. Every capture sample is scattered into the current camera. When several land on one pixel, the nearest wins. Sky samples (within 5% of the capture far) and samples past the current far land as far, so they never occlude.
2. A pixel no sample landed on takes the **farthest** sample of its 3×3 neighbours. With no neighbour it stays at far.
3. `depthBias` moves every occluder away from the camera. Far stays far.

It then tests each queued AABB:

- Camera inside the (expanded) box → visible
- Box behind far, or fully in front of the nearest coverage sample → visible
- Box farther than every coverage sample → occluded
- Else: rasterize only the faces that look at the camera. Each face is two triangles. When every corner is in front of the near plane the corners are projected once; otherwise each triangle is clipped to the near plane. A box entirely in front of near is visible. A texel of a triangle occludes when its depth is nearer than the nearest eye Z of that triangle. The box is occluded only when every texel those faces actually cover is occluding. Empty corners of the screen AABB are not tested, so an oblique box is not kept visible by background beside its faces. A face that misses the map does not cull the box. `rectPadPixels` grows each triangle's bounds; texels in that pad use the same nearest eye Z

Moving occludees: `tester.enqueueAabbUpdate(id, aabb, matrix?)`. Prefer that over poking the internal store.

## Conservativeness

| Property | Default | Meaning |
| --- | --- | --- |
| `tester.aabbExpand` | `0` | World AABB inflate as a fraction of camera-to-box distance. Written into the bus each job. |
| `tester.rectPadPixels` | `0` | Extra coverage pixels around the projected rect. |
| `tester.depthBias` | `0` | Moves reprojected occluders away from the camera. `b > 0`: `z * (1 + b) + b`. `b < 0`: `z + abs(b)` metres. Written into the bus each job. |

The packed map is coarse. Thin occluders, foliage, and objects smaller than a texel tend to stay visible. Objects that write depth **after** the HZB update do not occlude this capture. Near-plane / first-person geometry in the pyramid can self-occlude; exclude it from the pyramid or from the test set.

Reprojection uses the last harvested capture, a few frames behind the camera. Each sample is the pixel centre, so motion toward a surface leaves one-pixel cracks. The 3×3 fill closes them with the farthest neighbour, so a crack at a silhouette takes the background, not the occluder. Wider gaps and the band at the screen edge the previous frame never saw stay at far. Raise `depthBias` when reprojected occluders hide objects just behind them.

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
- `opacity` — overlay alpha from 0 to 1 (default `1`). Depth maps and the screen rect use it

`CoverageCpuBufferViewer` (`tester.cpuViewer`) can also query min/max view-space Z over a UV or pixel rectangle of that reprojected map. Origin is bottom-left, same as the packed CPU layout.

Call `debug.destroy()` with the tester.

## Timings

Times are milliseconds. A skipped capture leaves `coverage.stats` as it was. A busy worker leaves `tester.stats` as it was. They are separate jobs: the published read is a few frames behind the pack.

`coverage.stats` — the GPU read:

| Field | Meaning |
| --- | --- |
| `packMs` | CPU time to issue the pack and start the readback. The GPU pack finishes later |
| `readMs` | CPU time of the copy into `cpuDepth`. WebGL is `getBufferSubData`. WebGPU is the copy out of the mapped range |
| `latencyMs` | Wall time from that readback submit until the copy finished, including `readMs` |
| `latencyFrames` | Frames between that submit and the publish. At least `minReadbackLag`. On WebGL in Chromium it is two, because that is when the frame fence signals. A larger number means the copy waited longer |

`tester.stats` — the last completed worker job. Visible AABBs are `aabbCount - occludedCount`.

| Field | Meaning |
| --- | --- |
| `copyMs` | Main-thread copy of `cpuDepth` into the job bus |
| `reprojectMs` | Reprojection into the current camera |
| `mipMs` | Max-depth pyramid |
| `aabbTestMs` | AABB tests |
| `workerMs` | Worker total (bind + those three) |
| `waitMs` | Main-thread time from `postMessage` until the result. Includes `workerMs` |
| `aabbCount` / `occludedCount` | AABBs in that job, and how many were occluded |

## Limitations

- Coarser than GPU HZB; not a shadow map or triangle-perfect visibility
- WebGL in Chromium waits two frames for the frame fence, then one worker job. WebGPU waits until `mapAsync` finishes, at least `minReadbackLag` frames, then one worker job
- A published map older than `maxResultAge` reads as not ready, so tests return `UNKNOWN`. A download that has not finished stays in its slot and is not dropped for age
- One in-flight worker job; a slow test stalls new submits (queue is retained)
- Perspective cameras only for reprojection; ortho fills the map at far
- You must build the HZB, then drive `frameUpdate`, `frameRender`, `frameEnd`, and `updateGPUDepthBuffer(hzb, camera)` yourself

For same-frame GPU indirect draws, use [WebGPU HZB](hzb.md). For explicit CPU occluders and no GPU readback, use [software occlusion](software.md).
