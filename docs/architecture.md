# Architecture

The library is three public systems plus a shared extras layer. You can use instancing without occlusion, and occlusion without instancing.

```mermaid
flowchart TB
    app["PlayCanvas app"]

    subgraph instancing [Instancing]
        instancer["HierarchicalInstancer / Simple / Basic / Array"]
        lod["LOD levels + fade"]
        bvhInst["InstancedMeshBVH (HierarchicalInstancer only)"]
        instancer --> lod
        instancer --> bvhInst
    end

    subgraph occlusion [Occlusion]
        store["AABBStore"]
        testers["HZB / queries / software"]
        coverage["Coverage testers"]
        store --> testers
        testers --> sw["SoftwareOcclusionTester"]
        testers --> hzb["HZB WebGL readback / WebGPU indirect"]
        testers --> queries["WebGL occlusion queries"]
    end

    subgraph extras [Extras]
        tex["Mat4 / color / AABB data textures"]
        queues["Index and GPU queues"]
    end

    app --> instancer
    app --> store
    app --> coverage
    instancer --> tex
    testers --> queues
```

## Shared AABB store

[`AABBStore`](extras.md) holds packed centers and half-extents, optionally as GPU textures. HZB, queries, and software testers lock IDs on that store. Coverage testers own a CPU AABB pool: `lock` / `unlock` / `enqueueAabbUpdate` on the tester.

`OcclusionCullingSystem` takes an `AABBStore` and constructs the GPU testers that match the current device (WebGL2 HZB + queries, or WebGPU HZB). Software occlusion and the coverage buffer are constructed separately: `new SoftwareOcclusionTester(aabbStore, params)`, `new WebglCoverageBuffer(device)` or `new WebgpuCoverageBuffer(device)` + `new CoverageBufferTesterWorker(coverage)`.

## Frame order

A typical frame that uses both instancing and a readback occlusion tester:

```mermaid
sequenceDiagram
    participant App
    participant Instancer
    participant Tester
    participant GPU as GPU / worker

    App->>Instancer: update(dt, camera, cameraPos)
    Note over Instancer: frustum + LOD, enqueue visible instances
    App->>Tester: enqueue(id) for candidates
    App->>Tester: execute(camera)
    Tester->>GPU: submit job / draw queries / HZB tests
    Note over Tester: HZB / queries: frame hooks via OcclusionCullingSystem
    Note over Tester: Coverage: frameUpdate / frameRender / frameEnd yourself
    Tester-->>App: getOcclusionStatus (previous job)
    App->>App: skip draws that are OCCLUDED
```

Submit work early, consume results from the last **finished** job. Do not wait for the GPU or worker on the same frame unless you accept a stall.

Frame hooks are not universal: software has none; queries harvest in `frameUpdate`. Coverage and WebGL HZB read back on a three-step contract: `frameUpdate` on `frameupdate`, `frameRender` on `framerender` (the only place they copy GPU data, after scripts and before the GPU timer), and `frameEnd` on `frameend` after the capture. `OcclusionCullingSystem` drives HZB and queries, but **not** coverage — call all three on the coverage tester yourself.

A coverage tester publishes in `frameRender`. Call the three hooks every frame, `execute` after enqueue (often in `update`), and `updateGPUDepthBuffer(hzb, camera)` after the HZB is built (`postrender`) so tests use the last finished capture.

For **WebGPU HZB**, `execute` writes `instanceCount` into an indirect draw buffer. There is no `getOcclusionStatus` on that path.

## What stays internal

These are implementation details, not a public API:

- `SoftwareOcclusionWorker` (blob worker, Hi-Z only on the worker; owns occluder/mesh state)
- `CoverageCpuBuffer` (JS reproject + AABB tests; lives only inside the coverage worker blob)
- `CoverageAABBStore` (coverage AABB pool owned by the tester)
- HZB, coverage, and query shaders

Change them in source; do not document them for application code.
