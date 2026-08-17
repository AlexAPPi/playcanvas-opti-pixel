# BVH

`BVH` + `HybridBuilder` is a generic bounding-volume tree (insert, move, delete, frustum, ray, sphere). Instancing uses it through `InstancedMeshBVH` inside `HierarchicalInstancer`.

You rarely construct `BVH` yourself unless you are culling non-instanced objects.

## With `HierarchicalInstancer`

```ts
instancer.computeBVH({
    margin: 0,
    getBBoxFromBSphere: false,
    accurateCulling: true,
});
```

| Param | Default | When to change |
| --- | --- | --- |
| `margin` | `0` | Increase if instances move every frame; cheaper `move()`, looser culls |
| `getBBoxFromBSphere` | `false` | Faster, less precise; mesh bounding sphere must be origin-centered |
| `accurateCulling` | `true` | Test without applying margin at frustum time |

`autoUpdateBVH` (default `true`) calls `bvh.move(id)` from `setMatrixAt`. For a one-shot scatter of static instances, fill matrices, `computeBVH()`, then set `autoUpdateBVH = false`.

`disposeBVH()` drops the tree; `update()` falls back to the linear Simple path.

Call `computeBVH` after:

1. LOD meshes exist (`addLOD`) so instance AABB is valid
2. Matrices are assigned

## Standalone `BVH`

```ts
import { BVH, HybridBuilder } from "playcanvas-opti-pixel";

const builder = new HybridBuilder(Float32Array);
const bvh = new BVH(builder);
bvh.createFromArray(objects, boxes);
```

Boxes are `FloatArray` min/max layouts used by the builder. Traversal helpers: frustum, frustum+LOD, ray, sphere, box. See types on `BVH` in source.

`HybridBuilder` expects `Float32Array` boxes at build time; other typed arrays warn about precision.

## Frustum vs occlusion

BVH answers **is it in the camera frustum?** Occlusion testers answer **is it hidden behind geometry?** Run frustum (BVH) first, then occlusion on the remaining set.
