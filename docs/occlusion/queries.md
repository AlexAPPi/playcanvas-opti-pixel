# Occlusion queries (WebGL2)

`WebglOcclusionQueriesTester` draws AABB proxies with WebGL2 occlusion queries (`ANY_SAMPLES_PASSED` / `ANY_SAMPLES_PASSED_CONSERVATIVE`) and reads results on later frames.

WebGPU: not implemented. Use [HZB](hzb.md).

## Setup

```ts
import {
    AABBStore,
    OcclusionCullingSystem,
    OCCLUSION_OCCLUDED,
    OCCLUSION_ALGORITHM_TYPE_CONSERVATIVE,
} from "playcanvas-opti-pixel";

const aabbs = new AABBStore(device, 2048);
const system = new OcclusionCullingSystem(app, aabbs);
system.camera = camera.camera;
system.queriesLayerName = "Immediate"; // layer that has already written depth
system.autoUpdate = true;

const tester = system.queriesTester;
if (!tester) {
    throw new Error("Occlusion queries require WebGL2");
}

const id = tester.lock(worldAabb);

app.on("update", () => {
    tester.enqueue(id, tester.algoritmType);
    if (tester.getOcclusionStatus(id) !== OCCLUSION_OCCLUDED) {
        // draw
    }
});
```

`enqueue` on this class takes the algorithm as the **second argument** (required). Passing `tester.algoritmType` uses the tester default.

With `autoUpdate`, `execute` runs on PlayCanvas `postrender:layer` for the **non-transparent** pass of `queriesLayerName`. Choose a layer that runs **after** occluders have written depth.

If you drive it manually: `enqueue` → `execute(camera)` after that layer, and `frameUpdate(dt)` each frame to harvest completed queries.

`enqueue` returns `-1` when `freeze` is true (`OcclusionCullingSystem` sets `freeze = !autoUpdate`).

## Conservative vs accurate

```ts
import {
    OCCLUSION_ALGORITHM_TYPE_CONSERVATIVE,
    OCCLUSION_ALGORITHM_TYPE_ACCURATE,
} from "playcanvas-opti-pixel";

tester.algoritmType = OCCLUSION_ALGORITHM_TYPE_CONSERVATIVE;
```

| Mode | GL target | Idea |
| --- | --- | --- |
| `CONSERVATIVE` | `ANY_SAMPLES_PASSED_CONSERVATIVE` | Prefer not to hide (fewer false occlusions) |
| `ACCURATE` | `ANY_SAMPLES_PASSED` | Tighter test; more risk of popping if results are late |

The property name is `algoritmType` — that spelling is part of the current API.

## Latency

Queries complete asynchronously. `frameUpdate` keeps a queue of in-flight frames and adopts the newest frame whose `resultAvailable()` is true, discarding older ones.

`system.queriesDebugger?.debugItem(id)` draws a wire AABB (green visible, red occluded). `QueriesDebugger` is not a package export; use the getter on `OcclusionCullingSystem`.

## When not to use

- Thousands of queries per frame (driver overhead)
- WebGPU
- You already have a good HZB path
