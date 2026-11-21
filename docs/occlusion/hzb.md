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

When `autoUpdate` is false, call `update(camera)` or `updateSceneDepth(camera)` and `tester.execute(camera)` yourself after opaque depth is available. `OcclusionCullingSystem` runs `tester.frameUpdate` on `frameupdate`, `tester.frameRender` on `framerender`, and `tester.frameEnd` at the end of its `frameend` handler. If you constructed the tester yourself (no system), call those three each frame so readbacks can complete.

WebGL HZB downloads with `copyBufferSubData` into a STREAM_READ PBO, then publishes FIFO, one slot per `frameRender`. Default **3** in-flight slots and **1** frame of `minReadbackLag`. Coverage uses the same PBO read, but publishes newest-first: its slots are interchangeable full-frame depth maps, while each HZB slot is a different AABB queue and must not be skipped. `enqueue` can return `-1` (`SOME_ENQUEUE_PROBLEM`) on a non-capture tick (`readbackPeriod`) or when every slot is busy — treat that like `OCCLUSION_UNKNOWN`.

Readback is **delayed** by the frame fence: two frames in Chromium, one where that fence signals sooner. Treat `UNKNOWN` as visible.

| Property | Default | Meaning |
| --- | --- | --- |
| `readbackSlots` | `3` (clamped to at least **2**) | In-flight TF/download slots. The fill slot is reserved on `frameUpdate`, before `frameRender` frees one, and Chromium holds a capture for two frames, so two slots skip every third capture. More than three keep capturing through a hitch; FIFO then publishes that backlog in order and the answers get older |
| `minReadbackLag` | `1` | Frames from a capture to its earliest copy, clamped to at least `1`. The frame fence has to have signaled as well; Chromium does that two frames after the capture |
| `maxResultAge` | `10` | Frames, counted from the capture, a published answer stays valid. Past that every id is `OCCLUSION_UNKNOWN` |
| `readbackPeriod` | `1` | Reserve a fill slot / submit a capture every N `frameUpdate` ticks. `frameRender` still publishes every frame. On Android Chrome, `getBufferSubData` is an ordered GPU-process wait — set this to `3` (or higher) there. |

Do not call `gl.flush()` or `clientWaitSync`. `frameUpdate` must run **before** `enqueue` in the same tick, since it reserves the fill slot (`OcclusionCullingSystem` already does that on `frameupdate`).

On ANGLE `getBufferSubData` waits for every command recorded so far, not only the copy it reads, so the copy runs only once a fence inserted after that capture has signaled. `frameEnd` inserts that fence in a microtask after the rest of `frameend` (no `gl.flush()`), and the fence is kept until then. Chromium does not signal it on the next frame: the commands flush with the following frame, and `SYNC_STATUS` comes back a frame after that. `frameRender` — after scripts, before the GPU timer — polls the oldest open fence once and publishes the slot that fence covers. A slot newer than the newest signaled fence stays pending. Nothing forces a copy. Answers whose fence never signals age out after `maxResultAge` frames and read as `UNKNOWN`.

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

`updateSceneDepth(camera)` samples `camera.sceneDepthMapHandle.texture`. Use it with CameraFrame (`rendering.sceneDepthMap`, or a post effect that publishes scene depth). `requestSceneDepthMap` is ignored while `framePasses` is set. The handle's `linear`, `packed`, and `reciprocal` flags select metres, packed RGBA8, or `1 / viewZ`; those are decoded to device Z on the first pass, so later mips and the occlusion test stay in device Z. The call is a no-op until the map is published. Call it from `postrender` or `frameend` — in `update` the map is still the previous frame.

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
