# Occlusion culling overview

An occlusion tester answers: **is this AABB hidden behind other geometry for this camera?**

All testers share `IOcclusionCullingTester`:

- `lock` / `lockMinMaxScalars` — register an AABB, get a stable id
- `unlock` — free the id

Readback testers (`IReadbackOcclusionCullingTester`) add:

- `enqueue(id)` — include in this frame’s batch
- `execute(camera)` — submit the batch
- `getOcclusionStatus(id)` → `OCCLUSION_UNKNOWN | VISIBLE | OCCLUDED`

CPU software also has `frameUpdate` and `occluders: OccluderStore`.

WebGPU HZB implements `IGPUIndirectDrawOcclusionCullingTester`: `enqueue` takes an indirect draw slot and primitive; the GPU writes the draw args. There is no CPU visibility bit.

## Result values

| Constant | Value | Meaning |
| --- | --- | --- |
| `OCCLUSION_UNKNOWN` | `-1` | No finished result (first frames, missed job) |
| `OCCLUSION_OCCLUDED` | `0` | Hidden — safe to skip the draw |
| `OCCLUSION_VISIBLE` | `1` | Not occluded |

`enqueue` returns `-1` (`SOME_ENQUEUE_PROBLEM`) when that tester cannot accept the item. Meaning depends on the backend (full AABB queue, `freeze` on queries, no HZB write slot yet). Keep showing last known visibility.

## Shared store

Construct testers with the same `AABBStore` if they should see the same occludees:

```ts
const aabbs = new AABBStore(device, 8192);
const software = new SoftwareOcclusionTester(aabbs);
const system = new OcclusionCullingSystem(app, aabbs);
```

`lock` on a tester writes into that store. Do not `lock` the same object twice on two testers unless you want two IDs.

## `OcclusionCullingSystem`

Helper that, given `app` + `AABBStore`:

- Creates `WebglHierarchicalZBuffer` + `WebglHZBCPUFBTester` on WebGL2
- Creates `WebgpuHierarchicalZBuffer` + `WebgpuHZBTester` on WebGPU
- Creates `WebglOcclusionQueriesTester` on WebGL2 only
- Optionally auto-updates HZB on `frameend` and queries on a named layer (`autoUpdate`, `camera`, `queriesLayerName`)

Software occlusion is **not** created by this system. Instantiate `SoftwareOcclusionTester` yourself.

Debuggers: `system.drawHZB` uses `HierarchicalZBufferDebugger`. Query AABBs: `system.queriesDebugger?.debugItem(id)` (`QueriesDebugger` is not exported from the package).

Pick a backend in [Choosing a backend](choosing-backend.md).
