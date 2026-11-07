# Hierarchical Z-buffer (HZB)

HZB builds a mip chain from the camera depth buffer, then tests AABB screen rectangles against a conservative far-depth.

PlayCanvas device picks the implementation:

| Device | Depth pyramid | Tester | Result |
| --- | --- | --- | --- |
| WebGL2 | `WebglHierarchicalZBuffer` | `WebglHZBCPUFBTester` | CPU flags via transform feedback + readback |
| WebGPU | `WebgpuHierarchicalZBuffer` | `WebgpuHZBTester` | GPU writes indirect draw args |

`OcclusionCullingSystem` constructs the matching pair. You can also instantiate the concrete classes yourself if you need a custom frame graph.

`IHierarchicalZBuffer` is a texture/size view plus `update(camera)` and `updateSceneDepth(camera)`. A [coverage buffer](coverage.md) can pack one mip of that pyramid to a CPU view-space Z map after the pyramid is built.

## What `autoUpdate` actually does

When `system.autoUpdate` is true and `system.camera` is set, `OcclusionCullingSystem` on `frameend`:

1. Builds the pyramid: `hzb.update(camera)`, or `hzb.updateSceneDepth(camera)` when `system.useSceneDepthMap` is set
2. Calls `hzbTester.execute(camera)` **only** if the tester is a GPU→CPU readback tester (`isGPU2CPUReadbackOcclusionCullingTester`) — that is WebGL HZB, not WebGPU

You still `lock` / `enqueue` yourself. On WebGPU you must also call `execute` (and wire indirect draws).

## WebGL: readback

```ts
import {
    AABBStore,
    OcclusionCullingSystem,
    isGPU2CPUReadbackOcclusionCullingTester,
    OCCLUSION_OCCLUDED,
} from "playcanvas-opti-pixel";

const aabbs = new AABBStore(device, 4096);
const system = new OcclusionCullingSystem(app, aabbs);
system.camera = camera.camera;
system.autoUpdate = true;

const tester = system.hzbTester;
if (!isGPU2CPUReadbackOcclusionCullingTester(tester)) {
    throw new Error("Expected WebGL HZB readback tester");
}

const id = tester.lock(worldAabb);

app.on("update", () => {
    tester.enqueue(id);
    // execute runs on frameend when autoUpdate is on
    if (tester.getOcclusionStatus(id) !== OCCLUSION_OCCLUDED) {
        // draw
    }
});
```

When `autoUpdate` is false, call `update(camera)` or `updateSceneDepth(camera)` and `tester.execute(camera)` yourself after opaque depth is available. `OcclusionCullingSystem` still runs `tester.frameUpdate` on `frameupdate`. If you constructed the tester yourself (no system), call `frameUpdate` each frame so readbacks can complete.

WebGL HZB downloads with `copyBufferSubData` into a STREAM_READ PBO and `fenceSync`, then harvests FIFO, one slot per `frameUpdate`, no `gl.flush()`. Default **4** in-flight slots and **2** frames of `minReadbackLag`. Coverage uses the same PBO read, but harvests newest-first: its slots are interchangeable full-frame depth maps, while each HZB slot is a different AABB queue and must not be skipped. Its ring size is `readbackSlots` (default **5**). `enqueue` can return `-1` (`SOME_ENQUEUE_PROBLEM`) on a non-capture tick (`readbackPeriod`) or when every slot is busy — treat that like `OCCLUSION_UNKNOWN`.

Readback is **delayed** by at least one GPU frame. Treat `UNKNOWN` as visible.

| Property | Default | Meaning |
| --- | --- | --- |
| `readbackSlots` | `4` (clamped to at least **2**) | In-flight TF/download slots |
| `minReadbackLag` | `2` | `frameUpdate` ticks to wait before polling a slot |
| `readbackPeriod` | `1` | Reserve a fill slot / submit a capture every N `frameUpdate` ticks. Harvest still polls every `frameUpdate`. On Android Chrome, `getBufferSubData` is an ordered GPU-process wait — set this to `3` (or higher) there. |

Do not call `gl.flush()` after the PBO fence. `frameUpdate` must run **before** `enqueue` in the same tick (`OcclusionCullingSystem` already does that on `frameupdate`).

`HierarchicalZBufferDebugger` can overlay mips (`system.drawHZB = true`). `hzbDebugger.opacity` (0–1, default `1`) blends that overlay, including the screen rect from `debugItem`, over the scene.

## WebGPU: indirect draw

`WebgpuHZBTester.enqueue(id, slot, primitive, instanceCount, firstInstance, extra)` fills an indirect data buffer. The compute pass writes into `device.indirectDrawBuffer` so occluded draws get `instanceCount = 0`.

There is no `getOcclusionStatus`. `autoUpdate` builds the HZB; you still `enqueue` + `execute` yourself.

`OcclusionCullingSystem` already calls `hzbTester.frameUpdate` on `frameupdate`. For WebGPU that **clears** the indirect queue at the start of the frame, so `enqueue` in `app.on("update")` (after `frameupdate`), then `execute`.

```ts
const tester = system.hzbTester; // WebgpuHZBTester on WebGPU
if (!tester) return;

app.on("update", () => {
    // slot from device.getIndirectDrawSlot or your allocator
    tester.enqueue(id, slot, { base: 0, baseVertex: 0, count: indexCount, indexed: true }, 1, 0);
    tester.execute(camera.camera);
});
```

## Depth source

HZB is only as good as the depth you copy. Build it after opaque geometry, before you rely on the test.

`update(camera)` samples the PlayCanvas **depth grab** (`pc.Camera.renderPassDepthGrab`). Enable it with `CameraComponent.requestSceneDepthMap(true)`.

`updateSceneDepth(camera)` samples `camera.sceneDepthMap`. Use it with CameraFrame (`rendering.sceneDepthMap`, or a post effect that publishes scene depth). `requestSceneDepthMap` is ignored while `framePasses` is set. Linear, packed, and reciprocal encodings are decoded to device Z on the first pass, so later mips and the occlusion test stay in device Z. The call is a no-op until the map is published. Call it from `postrender` or `frameend` — in `update` the map is still the previous frame.

```ts
cameraFrame.rendering.sceneDepthMap = true;
cameraFrame.update();

system.useSceneDepthMap = true;
system.autoUpdate = true;
```

With `autoUpdate` off, call `hzb.updateSceneDepth(camera)` yourself where you would have called `update`.

On canvas resize, `OcclusionCullingSystem` rebuilds the pyramid automatically (WebGL uses `resizeWithDelay`). Call `system.resize()` after the **AABB store** grows so testers grow their queues — it does not rebuild the HZB.

## Limitations

- Small or thin occludees can be marked visible (conservative sampling)
- Objects that write depth after the HZB capture will not occlude this frame
- First-person weapons / near-plane geometry can self-occlude; exclude them from the pyramid or from the test set

For CPU tests on a packed 256×128 **view-space Z** map taken from one HZB mip (WebGL2 or WebGPU), see [coverage buffer](coverage.md).
