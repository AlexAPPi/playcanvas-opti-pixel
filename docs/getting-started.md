# Getting started

## Requirements

- PlayCanvas 2.x application with a `GraphicsDevice`
- WebGL2 or WebGPU, depending on the occlusion backend you pick
- ES modules or the published CJS/ESM builds from `dist/`

```bash
npm install playcanvas-opti-pixel playcanvas
```

```ts
import { HierarchicalInstancer } from "playcanvas-opti-pixel";
```

## Mental model

Almost every system in this library uses **stable integer IDs**:

| You call | Meaning |
| --- | --- |
| `lock(...)` | Allocate an ID and store data (AABB, occluder, …) |
| `enqueue(id)` | Mark that ID for this frame’s test or draw |
| `unlock(id)` | Free the ID when the object is gone |

Instancers use the same idea with instance indices: `0 .. capacity-1`. Matrices live in a data texture, not on individual `MeshInstance` nodes.

Occlusion testers share an [`AABBStore`](extras.md). `tester.lock(...)` is usually a pass-through to that store, so one store can feed several testers.

## First instancer

`HierarchicalInstancer` is the usual default: GPU instancing, time-based LOD fade, optional BVH.

```ts
import { HierarchicalInstancer } from "playcanvas-opti-pixel";

const instancer = new HierarchicalInstancer(app.graphicsDevice, {
    capacity: 1024,
    lodFadeTime: 0.25,
});

// distance is in world units; internally it is stored squared
instancer.addLOD(highDetailMeshes, rootEntity, 0);
instancer.addLOD(lowDetailMeshes, rootEntity, 50);

for (let i = 0; i < count; i++) {
    instancer.setMatrixAt(i, worldMatrix);
    // slots start inactive and invisible
    instancer.setActiveAndVisibilityAt(i, true);
}

// After matrices are filled
instancer.computeBVH();

app.on("update", (dt) => {
    instancer.update(dt, camera.camera, camera.getPosition());
});
```

`addLOD` patches the mesh materials with instancing shader chunks. Keep those `MeshInstance` objects in the scene graph as you would for a normal render; the instancer drives per-instance transforms.

Slots start with **Active** and **Visible** both false. `computeBVH()` only inserts Active instances; `SimpleHierarchicalInstancer.update` (and `HierarchicalInstancer` without a BVH) requires both flags. Hide later with `setVisibilityAt(id, false)`.

If you do not need BVH, use `SimpleHierarchicalInstancer` instead. See [Choosing an instancer](instancing/choosing-instancer.md).

## First occlusion tester

Software occlusion is the simplest path to a CPU `getOcclusionStatus` result. It does not depend on HZB or occlusion queries.

```ts
import {
    AABBStore,
    SoftwareOcclusionTester,
    OCCLUSION_OCCLUDED,
} from "playcanvas-opti-pixel";

const aabbs = new AABBStore(app.graphicsDevice, 4096);
const tester = new SoftwareOcclusionTester(aabbs, {
    width: 256,
    height: 128,
});

const id = tester.lock(entity.render.meshInstances[0].aabb);

// Large occluders: boxes, spheres, or snapped meshes
tester.occluders.lockBox(occluder.getWorldTransform());

app.on("update", () => {
    tester.enqueue(id);
    tester.execute(camera.camera);

    const status = tester.getOcclusionStatus(id);
    entity.enabled = status !== OCCLUSION_OCCLUDED;
});
```

Rules that apply to every readback tester:

1. `enqueue` every object you care about **this frame**, then `execute`.
2. Results belong to a **previous** completed job. The first frames return `OCCLUSION_UNKNOWN`.
3. Treat `UNKNOWN` as visible. Only skip the draw on `OCCLUSION_OCCLUDED`.
4. `enqueue` returning `-1` (`SOME_ENQUEUE_PROBLEM`) means that item was not queued. For software occlusion that is a full AABB queue, not a busy worker (a busy worker **keeps** the queue and skips `execute` until idle). Software has no `frameUpdate`; completed jobs arrive on the worker message callback.

In the snippets, `camera` is a PlayCanvas `CameraComponent` (`camera.camera` is `pc.Camera`).

GPU backends (HZB, coverage, queries) follow the same `lock` / `enqueue` / `execute` contract, but WebGPU HZB culls via **indirect draw** instead of a CPU status. Coverage also needs `updateHZB(camera)` after opaque depth — `execute` does not build that chain. WebGL HZB and queries need `frameUpdate` if you constructed the tester yourself; `OcclusionCullingSystem` already runs it on `frameupdate`. See [Choosing a backend](occlusion/choosing-backend.md).

## Next

- [Architecture](architecture.md) — how instancing, BVH, and occlusion connect
- [Choosing an instancer](instancing/choosing-instancer.md)
- [Choosing an occlusion backend](occlusion/choosing-backend.md)
