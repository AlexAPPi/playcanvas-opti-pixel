# Coverage buffer

`WebglCoverageBuffer` / `WebgpuCoverageBuffer` downsample the camera depth map with a 4-tap **max** chain that keeps **256×128** aspect at every level. GPU chain levels stay in **device Z**. The last level is packed as **view-space Z in metres** and copied to the CPU. `CoverageBufferTester` reprojects that capture and tests queued AABBs **on the CPU**. Both buffers implement `ICoverageBuffer` (package type export).

This tester is a GPU→CPU readback tester (`IGPU2CPUReadbackOcclusionCullingTester`). It is **not** an HZB tester: there is no `hzb` / `frameUpdate` on it (`coverage.frameUpdate` runs inside `execute`), and `OcclusionCullingSystem` does not construct this path.

| Device | Pack | Download |
| --- | --- | --- |
| WebGL2 | Transform feedback (`out_depth`) | `copyBufferSubData` → STREAM_READ PBO + `fenceSync` |
| WebGPU | Compute write to a storage buffer | `copyBufferToBuffer` → MAP_READ + `mapAsync` |

Packed `cpuDepth` is always in GL / NDC order (row 0 = NDC y = −1). WebGPU inverts Y in the pack pass so the CPU buffer matches WebGL.

## Setup

```ts
import {
    AABBStore,
    WebglCoverageBuffer,
    WebgpuCoverageBuffer,
    CoverageBufferTester,
    OCCLUSION_OCCLUDED,
} from "playcanvas-opti-pixel";

const aabbs = new AABBStore(app.graphicsDevice, 4096);
const coverage = app.graphicsDevice.isWebGPU
    ? new WebgpuCoverageBuffer(app.graphicsDevice)  // 256×128
    : new WebglCoverageBuffer(app.graphicsDevice);  // WebGL2, 256×128
const tester = new CoverageBufferTester(coverage, aabbs);

const id = tester.lock(worldAabb);

app.on("update", () => {
    tester.enqueue(id);
    tester.execute(camera.camera);
    if (tester.getOcclusionStatus(id) !== OCCLUSION_OCCLUDED) {
        // draw — treat UNKNOWN as visible
    }
});

// After opaque geometry has written depth
app.on("postrender", () => {
    tester.updateHZB(camera.camera);
});
```

`enqueue` returns `-1` (`SOME_ENQUEUE_PROBLEM`) when the per-frame queue is already at AABB-store capacity.

On canvas resize, `coverage.resize()` / `resizeWithDelay()` rebuilds GPU targets and sets `cpuReady` back to false. Call `tester.resize()` if the AABB store grew.

Call `coverage.destroy()` and `tester.destroy()` when done.

## Frame contract

`updateHZB` and `execute` are separate. `execute` never builds the downsample chain.

```mermaid
sequenceDiagram
    participant App
    participant Tester
    participant GPU

    App->>Tester: enqueue(id)
    App->>Tester: execute(camera)
    Note over Tester: frameUpdate: harvest readback (execute only)
    Note over Tester: reproject last capture, test queue
    Tester-->>App: getOcclusionStatus (previous capture)
    App->>App: skip draws that are OCCLUDED
    Note over App: opaque geometry writes depth
    App->>Tester: updateHZB(camera)
    Tester->>GPU: 4-tap max chain 256∶128, pack view Z, GPU→CPU copy
```

| Call | When | What it does |
| --- | --- | --- |
| `updateHZB(camera)` | After opaque depth (`postrender`) | Builds the GPU downsample chain and submits **one** readback for the current `execute` tick. Does **not** poll finished downloads. No-op while `coverage` is disabled or `resizePending`. |
| `execute(camera)` | Every frame, typically on `update` | Increments `coverage`’s frame id, harvests finished downloads, reprojects the last capture, tests the queue. Clears the queue. |

Call **both** every frame. Skipping `execute` freezes readback latency (`minReadbackLatency` is counted in those ticks). Skipping `updateHZB` means no new capture is submitted.

`execute` can run **earlier** in the frame than `updateHZB`. Tests always use the last **finished** download, never the chain that was just submitted. A second `updateHZB` in the same tick is ignored (`acquire` refuses another slot).

In a custom frame graph you can call `coverage.update(camera)` instead of `updateHZB`. You still need `execute` to poll and test.

Until the first download finishes (`coverage.cpuReady`), and again while the buffer is disabled, `resizePending`, the CPU test buffer is not `valid`, or not yet re-ready after a resize, `execute` drops the queue and fills `OCCLUSION_UNKNOWN`. Do not keep a stale `OCCLUDED`.

Results lag **at least one GPU frame** (typically two).

## Pipeline

```mermaid
flowchart LR
    depth[Camera depth] --> chain["GPU 4-tap max, 256∶128"]
    chain --> pack["Pack last level as view Z"]
    pack --> download["GPU→CPU copy"]
    download --> cpu["CPU reproject + hole fill"]
    cpu --> aabb["AABB rect test"]
```

1. `updateHZB` (or `coverage.update`) downsamples with a **max** of four taps at ±0.5 source texels. Stage count is `min(maxDownsampleStages, max(1+log2(src/cap)))`, at least 1; each dest size is `cap << (stages−i−1)` so every level keeps 256∶128 (`256<<n` × `128<<n` down to the CPU cap). Quad textures are the first `stages−1` levels; the last stage is the pack. If `stages === 1`, pack samples the camera depth directly. NDC −1..1 maps to the full target (the screen is stretched into 2∶1).
2. The last stage writes `width×height` **view-space Z** (metres). Device Z is max-downsampled on GPU, then linearized at pack: perspective `near*far / (far + z*(near-far))`, ortho `near + z*(far-near)` (`camera_params` = `(1/far, far, near, ortho)`). WebGL: transform feedback; WebGPU: compute storage buffer (Y inverted to GL order). Default **4** in-flight slots, **2** frames of minimum latency.
3. `execute` polls finished slots. If the capture view-projection matches the test camera, the CPU copies the buffer (no scatter). Otherwise it reprojects in **view-space Z**: scatter keeps the **closer** sample (`min` metres), empty pixels take the **farthest** real neighbor in 3×3 (remaining holes stay at far).
4. Each queued AABB is projected for a screen rect; the test depth is the AABB’s nearest **view-space Z** from the view matrix (center ± extents along camera forward), clamped to near. Occluded iff every pixel in the rectangle has view Z ≤ that nearest Z. `rectPadPixels` defaults to **0**. There is **no** world expand by default (`aabbExpand = 0`).

There is no CPU Hi-Z. A large screen-space AABB walks pixels on the 256×128 grid.

## Readback knobs

| Property | Default | Meaning |
| --- | --- | --- |
| `maxWidth` / `maxHeight` | `256` / `128` | CPU target size |
| `maxDownsampleStages` | `4` | Cap on downsample + pack stages. Setter rebuilds the chain. |
| `cpuReadback` | `true` (forced on by the tester) | Submit pack + download each `coverage.update` |
| `readbackSlots` | `4` | In-flight pack/download slots |
| `minReadbackLatency` | `2` | `execute` ticks to wait before polling a slot |
| `flushOnSubmit` | `false` (WebGL only) | `gl.flush()` after the PBO fence. Leave off on Android. |
| `tester.aabbExpand` | `0` | World AABB inflate × camera-to-box distance. Leave at 0 for far culls. |
| `tester.rectPadPixels` | `0` | Extra coverage pixels around the projected rect. Raise if motion pops far objects visible. |

The download is 256×128×4 bytes (~128 KB) at the default size. Packed values are **view-space Z in metres**, not device Z.

`coverage.cpuDepth` is the last packed buffer (view-space Z, not yet reprojected). `coverage.cpuCameraParams` is `(1/far, far, near, ortho)` for that capture. `coverage.cpuVersion` bumps on resize and each harvested capture so `execute` can skip a redundant `setSource`. `tester.cpuBuffer` is the **reprojected** test buffer (`CoverageCpuBuffer`, not a package export).

## How an AABB is tested

`CoverageCpuBuffer` uses the camera position and view matrix, then clips the AABB hull to the view frustum and projects the visible edges. The screen rectangle is padded by `rectPadPixels`. The nearest test depth is view-space Z in metres (not `z/w` device Z). The object stays **visible** when:

- the camera is inside the (optionally expanded) box
- it is fully at or past the far plane (`minEyeZ >= far`)
- its farthest view Z is closer than every sample (`maxEyeZ <` buffer min)
- the clipped hull is empty (fully outside the frustum or behind the camera)
- the projected rect is off-screen
- any pixel in its **on-screen** rectangle is farther than the AABB’s nearest view Z (`zBuffer > minEyeZ`)

It is **occluded** when:

- its nearest view Z is behind every sample (`minEyeZ >` buffer max), or
- every covered pixel is closer or equal (`zBuffer <= minEyeZ`)

AABBs that **straddle** the far plane are still tested: only the clipped hull is used. Unclipped corners past far used to force `VISIBLE` and killed far culls.

If the capture view-projection matches the test camera, the CPU copies the depth (no scatter). Otherwise it reprojects as above. Scatter holes stay far (white in the debug overlay); they do not grow occluders.

## Debug overlay

`CoverageBufferDebugger` is a package export. Bind the **tester** (not only the coverage buffer) so the strip includes the CPU-reprojected test buffer.

Draw the overlay **after** `execute` so `tester.cpuBuffer` is valid.

GPU chain thumbnails are still **device Z**. Packed and reprojected tiles are view-space Z (the overlay divides by `far` only for display).

```ts
import { CoverageBufferDebugger } from "playcanvas-opti-pixel";

const debug = new CoverageBufferDebugger(app, tester);

app.on("postrender", () => {
    tester.updateHZB(camera.camera);
});

app.on("update", () => {
    tester.execute(camera.camera);
    debug.debug();                 // chain + packed + reprojected
    debug.debugItem(id);           // wire AABB + screen rect
    // debug.debugPacked();        // fullscreen CPU target
    // debug.debugReprojected();   // fullscreen test buffer
    // debug.debugMipLevel(0);     // one GPU chain level
});
```

If you replace the coverage-buffer instance, set `debug.tester` again.

| Method | What it draws |
| --- | --- |
| `debug(count?, ...)` | Right-side strip: GPU chain, packed download, then reprojected CPU buffer. `count` `0` = every chain pass. |
| `debugBuffer(i, x, y, w, h)` | One GPU chain texture |
| `debugMipLevel(level)` | One chain level, fullscreen |
| `debugPacked(x?, y?, w?, h?)` | CPU download after pack readback. UV 0..1 = NDC |
| `debugReprojected(...)` | CPU test buffer after reprojection + hole fill |
| `debugItem(id, box?, rect?, packed?, reprojected?)` | Wire AABB (green visible / red occluded) and screen rect. `reprojected` overlays the test buffer; otherwise `packed` overlays the packed download |

## Compared with the other backends

| vs | Coverage difference |
| --- | --- |
| [HZB WebGL](hzb.md) | HZB keeps a full mip chain and tests on GPU (transform feedback), then reads **flags**. Coverage downsamples with a 4-tap max chain, then a pack pass writes **view-space Z** and tests on CPU. Coarser, and never uses the depth that was just submitted this frame. |
| [HZB WebGPU](hzb.md) | WebGPU HZB culls by writing indirect `instanceCount`. Coverage still gives a CPU `getOcclusionStatus` bit from a packed 256×128 download. |
| [Queries](queries.md) | Queries rasterize box proxies with `ANY_SAMPLES_PASSED`. Coverage uses the depth you already rendered and one small readback. No per-object query draws. WebGL2 only for queries. |
| [Software](software.md) | Software rasterizes **explicit** occluders on a worker. Coverage uses **scene depth**, so you do not maintain an occluder set — but you inherit GPU latency, reprojection, and 256×128. |

## Limitations

- Always a previous capture; fast camera motion leaves far holes (false visibles), not inflated occluders. Raise `rectPadPixels` if far objects pop visible while looking around; do not turn `aabbExpand` back on for that.
- 256×128 cannot represent thin occluders; this path is for large solids (buildings, terrain). Far objects behind a wall still need the wall to cover their (padded) rect — raise `coverage.maxWidth` / `maxHeight` if mixed sky/wall texels leak through.
- Large screen-space AABBs are O(pixels in the rect) on CPU
- First frames after construct / resize / context loss: `cpuReady` is false; that `execute` fills `UNKNOWN` and drops the queue
- You must call `updateHZB` yourself after opaque depth; nothing else builds the chain
