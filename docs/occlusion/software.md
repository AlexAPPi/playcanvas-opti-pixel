# CPU software occlusion

`SoftwareOcclusionTester` rasterizes **explicit occluders** on a Web Worker, builds Hi-Z only inside that worker, and tests queued AABBs. The main thread never owns the depth pyramid.

Works on WebGL2 and WebGPU. Requires you to register occluders; the framebuffer is not sampled.

## Setup

```ts
import {
    AABBStore,
    SoftwareOcclusionTester,
    OCCLUSION_OCCLUDED,
} from "playcanvas-opti-pixel";

const aabbs = new AABBStore(device, 4096);
const tester = new SoftwareOcclusionTester(aabbs, {
    width: 256,  // rounded up to a power of two
    height: 128, // rounded up to a power of two
});

const occludeeId = tester.lock(meshAabb, worldMatrix);

const occluderId = tester.occluders.lockBox(building.getWorldTransform());
// or: lockSphere, lockCylinder, lockCone, lockPlane
// or: lockMesh(meshInstance), lockMeshData(positions, indices, matrix)

app.on("update", (dt) => {
    tester.enqueue(occludeeId);
    tester.execute(camera.camera);
    tester.frameUpdate(dt);

    const visible = tester.getOcclusionStatus(occludeeId) !== OCCLUSION_OCCLUDED;
});
```

Call `destroy()` when done. Call `resize()` if the AABB store capacity grew (grows host queue / result arrays).

## Frame contract

```mermaid
sequenceDiagram
    participant Main
    participant Worker

    Main->>Main: enqueue AABBs
    Main->>Main: execute(camera)
    alt worker idle and queue non-empty
        Main->>Worker: frame patches plus job
        Note over Main,Worker: dirty occluder/mesh ops if any
        Note over Main,Worker: vp and queueIds
        Worker->>Worker: apply patches, clear, raster, Hi-Z, AABB tests
        Worker-->>Main: compact flags plus stats
        Main->>Main: snapshot flags for getOcclusionStatus
    else worker busy
        Main->>Main: retain queue for next idle execute
    else no occluders
        Main->>Main: mark queued visible; flush pending removes if any
    end
```

- Worker **owns** occluder types, matrices, and mesh geometry. Main keeps `OccluderStore` as the app-facing source of truth and sends **dirty commands** when it changes.
- `execute` submits if the worker is idle and there is a non-empty queue **or** pending occluder/mesh patches. Patch-only frames skip raster/AABB tests on the worker.
- If the worker is busy, `execute` returns without submitting; **enqueued ids are kept** for the next idle frame. Last flags stay. Pending occluder edits still accumulate on main. The tester does not dedup — do not enqueue the same id again while the queue is still held.
- `enqueue` returns `-1` (`SOME_ENQUEUE_PROBLEM`) only when the per-frame queue is already at AABB-store capacity.
- If there are **zero occluders**, queued AABBs are marked visible immediately.
- `frameUpdate` is a no-op kept for the CPU-tester API. Completed jobs arrive on the worker `message` callback.

`ready` is false until the worker starts. `stats` holds timings in **milliseconds** from the last completed job (`rasterMs`, `hizBuildMs`, `aabbTestMs`, `workerMs`, counts, …). `occluderCount` is how many occluders were rasterized (in-frustum), not the live store size.

## Occluder store

`tester.occluders` is an `OccluderStore`.

| Method | Geometry |
| --- | --- |
| `lockBox` / `lockSphere` / `lockCylinder` / `lockCone` / `lockPlane` | Unit primitive × matrix |
| `lockMesh(mesh \| meshInstance)` | Triangle snapshot; same `pc.Mesh` is interned |
| `lockMeshData(positions, indices?)` | Raw xyz; no indices ⇒ triangle soup |

Moving occluders: `enqueueUpdate(id, matrix)` — updates the matrix and queues a small worker upsert.

`unlock(id)` releases the slot and mesh refcount; the worker receives remove commands on the next submit.

Meshes are snapshotted at lock time. If you morph the `pc.Mesh`, lock again.

The same `pc.Mesh` is interned: many occluder instances share one vertex/index blob. On first unique mesh, main **copies** verts/indices and **transfers** the copy to the worker, which computes the local AABB there. Later instances of the same mesh only send an occluder upsert with the existing mesh id. `lockMeshData` always allocates a new unique mesh.

Keep occluders **large and few**. Software raster at 256×128 will not represent foliage or thin rails well.

Occluders whose local AABB is fully outside the camera frustum are skipped before raster. Occluders whose projected screen footprint is smaller than a few pixels are also skipped. Near-plane straddling still rasterizes (triangles are clipped). This is a conservative clip test, not Hi-Z hiding of occluders.

## What crosses the thread boundary

Each idle `execute` sends one `frame` message:

1. Optional dirty patches: resize, mesh upserts/removes, occluder upserts/removes, AABB full/upsert sync.
2. Job payload: view-projection (16 floats) and **queue ids only**. AABB centers/half-extents live in the worker mirror.
3. Worker returns compact flags (`length === queueCount`) plus stats — not a scene buffer.

AABB sync: `tester.lock` / `enqueueAabbUpdate` mark dirty ids (incremental upsert). Updates via `aabbStore.enqueueUpdate` directly bump `version` without dirty ids and trigger a **full** AABB mirror copy on the next submit. Prefer the tester helpers for moving occludees.

No `SharedArrayBuffer` / COOP / COEP is required. There is no ping-pong of a packed scene `ArrayBuffer`.

After each completed job with a non-empty queue, non-queued ids become `UNKNOWN` in the local flag snapshot (same as before).

## Occluder debug wireframe

Enable with `debugOccluders: true` (ctor) or `tester.debugOccluders = true`. The worker rebuilds world-space triangle edges only when occluder/mesh geometry is dirty (or debug is first enabled) — not on every AABB test job. The GPU mesh is uploaded only when that line buffer changes.

```ts
tester.debugOccluders = true;

app.on("update", () => {
    tester.enqueue(id);
    tester.execute(camera.camera);
    tester.debugDraw(app); // Immediate: app.drawMesh of a PRIMITIVE_LINES mesh
});
```

The worker sends world-space line endpoints; the tester uploads them into a `pc.Mesh` with `pc.PRIMITIVE_LINES` only when that buffer changes. Cap is 250k line segments. Disable when not needed — building and transferring the wireframe is not free.

## Capacities

Occluder slot capacity defaults to 256 and grows via `reserved.occluders` / `preallocate` / `OccluderStore.resize`. The worker grows its sparse tables from a resize patch on the next submit.

`uniqueMeshes`, `vertexCount`, and `indexCount` on `reserved` / `preallocate` are kept for API compatibility. Geometry is stored per-mesh inside the worker; those fields no longer grow a shared packed buffer.

```ts
const tester = new SoftwareOcclusionTester(aabbs, {
    reserved: {
        occluders: 512,
    },
});
// or later: tester.preallocate({ occluders: 512 });
```

`tester.reserved` still reports the current floors (`occluders` follows `occluders.capacity`).

## Limitations

- Conservative low-res raster: occludees smaller than a pixel may stay visible
- One in-flight job: high CPU raster time ⇒ tests lag one or more frames (queue is retained, not cleared)
- Not a replacement for triangle-perfect visibility
