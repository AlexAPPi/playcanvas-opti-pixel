# Hierarchical Z-buffer (HZB)

HZB builds a mip chain from the camera depth buffer, then tests AABB screen rectangles against a conservative far-depth.

PlayCanvas device picks the implementation:

| Device | Depth pyramid | Tester | Result |
| --- | --- | --- | --- |
| WebGL2 | `WebglHierarchicalZBuffer` | `WebglHZBCPUFBTester` | CPU flags via transform feedback + readback |
| WebGPU | `WebgpuHierarchicalZBuffer` | `WebgpuHZBTester` | GPU writes indirect draw args |

`OcclusionCullingSystem` constructs the matching pair. You can also instantiate the concrete classes yourself if you need a custom frame graph.

`IHierarchicalZBuffer` is a texture/size view. `update(camera)` exists on `WebglHierarchicalZBuffer` and `WebgpuHierarchicalZBuffer`, not on the interface.

## What `autoUpdate` actually does

When `system.autoUpdate` is true and `system.camera` is set, `OcclusionCullingSystem` on `frameend`:

1. Calls `hzb.update(camera)` (builds the pyramid)
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

When `autoUpdate` is false, call `WebglHierarchicalZBuffer.update(camera)` and `tester.execute(camera)` yourself after opaque depth is available. `OcclusionCullingSystem` still runs `tester.frameUpdate` on `frameupdate`. If you constructed the tester yourself (no system), call `frameUpdate` each frame so readbacks can complete.

The first `enqueue` can return `-1` until `execute` has allocated a write slot. Treat that like `OCCLUSION_UNKNOWN`.

Readback is **delayed** by at least one GPU frame. Treat `UNKNOWN` as visible.

`HierarchicalZBufferDebugger` can overlay mips (`system.drawHZB = true`).

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

On canvas resize, `OcclusionCullingSystem` rebuilds the pyramid automatically (WebGL uses `resizeWithDelay`). Call `system.resize()` after the **AABB store** grows so testers grow their queues — it does not rebuild the HZB.

## Limitations

- Small or thin occludees can be marked visible (conservative sampling)
- Objects that write depth after the HZB capture will not occlude this frame
- First-person weapons / near-plane geometry can self-occlude; exclude them from the pyramid or from the test set

For WebGL2 CPU tests on a packed downsample **without** transform feedback, see [coverage buffer](coverage.md).
