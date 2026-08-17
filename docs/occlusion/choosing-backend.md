# Choosing an occlusion backend

There is no single best tester. Choose by API (CPU bit vs indirect draw), latency, and device.

| Backend | Device | How you read the result | Typical latency | Occluders |
| --- | --- | --- | --- | --- |
| [Software](software.md) | Any (CPU worker) | `getOcclusionStatus` | 1 job (often 1 frame) | Explicit: box, sphere, cone, cylinder, plane, mesh |
| [HZB WebGL](hzb.md) | WebGL2 | `getOcclusionStatus` (readback / transform feedback) | ~1+ frames | Scene depth → Hi-Z |
| [HZB WebGPU](hzb.md) | WebGPU | Indirect draw (`instanceCount`) | Same frame on GPU | Scene depth → Hi-Z |
| [Queries](queries.md) | WebGL2 only | `getOcclusionStatus` | 1–N frames | Hardware occlusion queries on box proxies |

WebGPU does not get the queries tester (`OcclusionCullingSystem` leaves it `null`). Use HZB there.

## Decision sketch

```mermaid
flowchart TD
    start[Need occlusion?]
    cpu{Need a CPU visible/occluded bit?}
    gpu{WebGL2 or WebGPU?}
    occluders{Can you mark large occluders?}

    start --> cpu
    cpu -->|yes| occluders
    occluders -->|yes, and you want no GPU readback| sw[SoftwareOcclusionTester]
    occluders -->|no, use the framebuffer| gpu
    cpu -->|no, cull draws on GPU| webgpu[WebgpuHZBTester indirect]
    gpu -->|WebGL2| hzbgl[WebglHZBCPUFBTester]
    gpu -->|WebGPU| webgpu
    gpu -->|WebGL2, prefer API queries| q[WebglOcclusionQueriesTester]
```

## When to pick software

- You can list **coarse occluders** (buildings, terrain chunks, proxy boxes)
- You want **no GPU readback** and a worker-thread Hi-Z
- You need the same path on WebGL and WebGPU
- A frame of delay is acceptable

Raster resolution defaults to 256×128. That is conservative and cheap; it is not a shadow map.

## When to pick HZB

- Occluders are whatever already wrote depth (the real scene)
- WebGL: you can live with GPU readback delay (the tester pipelines transform-feedback results across frames)
- WebGPU: you can issue **indirect draws** and do not need a CPU bit

HZB quality depends on the depth buffer you feed it. Transparent and first-person near geometry need extra care (see [HZB](hzb.md)).

## When to pick queries

- WebGL2 only
- You want hardware `ANY_SAMPLES_PASSED` (or conservative vs accurate modes)
- Object counts stay modest; each query has GPU overhead
- You can wait one or more frames for `resultAvailable`

`OCCLUSION_ALGORITHM_TYPE_CONSERVATIVE` vs `ACCURATE` trades false visibility for tighter tests ([queries](queries.md)).

## Combining with instancing

Use software or WebGL HZB/queries to **skip CPU enqueue** into an instancer. Use WebGPU HZB to **zero indirect instance counts** without reading back.

Do not run two readback testers on the same objects every frame unless you are comparing them. Pick one production path.

## `UNKNOWN` policy

For every CPU-status backend:

```ts
if (tester.getOcclusionStatus(id) !== OCCLUSION_OCCLUDED) {
    draw();
}
```

Never hide on `UNKNOWN`. That is the conservative default and avoids pop-in on the first frames and when a job is dropped.
