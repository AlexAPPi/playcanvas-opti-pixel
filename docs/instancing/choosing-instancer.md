# Choosing an instancer

Start from the simplest class that covers the feature you need. You can switch later: `HierarchicalInstancer` is a `SimpleHierarchicalInstancer`, which is a `BasicHierarchicalInstancer`.

| Need | Class |
| --- | --- |
| Matrices + LOD meshes, you drive culling yourself | `BasicHierarchicalInstancer` |
| Frustum culling, visibility flags, time-based LOD fade | `SimpleHierarchicalInstancer` |
| Same, plus BVH for large instance counts | `HierarchicalInstancer` |
| Several independent instance groups sharing one texture array | `BasicArrayHierarchicalInstancer` |

## `BasicHierarchicalInstancer`

Use when you only need GPU instancing and LOD **renders**, and you already know which instances are visible (your own BVH, occlusion, or a fixed set).

- `capacity` is the buffer size (default 1000). Call `resize(n)` to grow — `setMatrixAt` does not expand it
- `setMatrixAt` / `getMatrixAt` / `getPositionAt`
- `addLOD(meshInstances, root, distance, hysteresis)`

There is no `update()` frustum pass on this class. You work with LOD renders directly if you go this low.

## `SimpleHierarchicalInstancer`

Default for moderate counts (hundreds to low thousands) where a linear frustum test is acceptable.

Adds:

- `setActiveAt` / `setVisibilityAt` / `setActiveAndVisibilityAt` (slots start false/false)
- `lodFadeTime` (default `0.25` seconds)
- `update(dt, camera, cameraPosition)` — frustum test requires both Active and Visible

```ts
const instancer = new SimpleHierarchicalInstancer(device, {
    capacity: 512,
    lodFadeTime: 0.2,
});
// after setMatrixAt:
instancer.setActiveAndVisibilityAt(id, true);
```

## `HierarchicalInstancer`

Same as Simple, with a BVH over instance AABBs.

Call `computeBVH()` **after** matrices, LOD meshes, and **Active** flags are ready — only Active instances are inserted. With `autoUpdateBVH` (default `true`), `setMatrixAt` moves an existing leaf (`move` no-ops if that id was never inserted).

```ts
const instancer = new HierarchicalInstancer(device, { capacity: 8192 });
// ... addLOD, setMatrixAt, setActiveAndVisibilityAt ...
instancer.computeBVH({
    margin: 0,              // > 0 if instances move a lot
    getBBoxFromBSphere: false,
    accurateCulling: true,
});
```

Rebuild or `disposeBVH()` if you replace the whole set of instances. See [BVH](../bvh.md).

Linear `SimpleHierarchicalInstancer.update` is often enough below a few thousand instances. Measure before adding BVH.

## `BasicArrayHierarchicalInstancer`

One capacity, one matrix/color **texture array**, N logical layers. Each layer has its own LODs and materials via `getLayer(i)`.

Use this when several instance groups must share GPU memory but stay independent in the scene (different meshes, different sort flags).

```ts
const instancer = new BasicArrayHierarchicalInstancer(device, {
    capacity: 2048,
    layers: 3,
});

const trees = instancer.getLayer(0);
trees.addLOD(treeMeshes, forestRoot, 0);
```

## What not to mix

- Do not attach two instancers to the same `MeshInstance` list
- Do not call `computeBVH` before LOD meshes exist — instance AABB comes from those meshes
- Do not call `computeBVH` before instances are Active — inactive slots are skipped
- LOD0 distance must stay `0` (`updateLOD` warns if you change it)
