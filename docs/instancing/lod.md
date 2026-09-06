# LOD

Each instancer holds an ordered list of `ILODLevel` entries. Distance is compared in **squared world units** ( `addLOD` squares the value you pass).

## Adding levels

```ts
instancer.addLOD(lod0Meshes, root, 0);     // always the closest
instancer.addLOD(lod1Meshes, root, 30);
instancer.addLOD(lod2Meshes, root, 80);
```

- LOD0 is the hero mesh. Its distance is fixed at 0.
- Later levels activate when camera-distance² reaches that level’s stored distance.
- `hysteresis` (0–1) is applied in **squared-distance** space in `getObjectLODIndexForDistance`: the switch happens at `level.distance * (1 - hysteresis)` (where `level.distance` is already the squared world distance). That reduces flicker at the boundary.
- `root` is an optional entity whose local space is used for the combined mesh AABB.

`removeLOD` / `updateLOD` exist on the basic instancer. Changing geometry means calling `updateInstanceBoundingBox()` (already done inside `addLOD`).

## Which fade you get

| Helper | Used by | Behaviour |
| --- | --- | --- |
| `FadeTimeLODState` | `SimpleHierarchicalInstancer` / `HierarchicalInstancer` | Over `lodFadeTime` seconds, both current and next LOD can draw with opacity |
| `FadeDistanceLODState` | Exported helper only | Distance-band blend. Instancers do **not** call this; they use time fade + hysteresis on the LOD switch |

During a time fade, two LOD renders may enqueue the same instance with complementary opacities. Transparent materials should keep `sortObjects` enabled on the LOD render.

## Per-instance visibility

Slots start with Active and Visible both false. Call `setActiveAndVisibilityAt(id, true)` when the instance should draw.

`setVisibilityAt(id, false)` hides without freeing the slot (gameplay hide). `SimpleHierarchicalInstancer.update` still requires Active as well. `computeBVH` only inserts Active instances; with a live BVH, `HierarchicalInstancer.update` then checks Visible. Call `resize` if you need more slots. Instancers have no `lock` / `unlock`.

## Combined with occlusion

Typical pattern:

1. Instancer (or BVH) decides frustum + LOD
2. Occlusion tester tests the instance AABB
3. If status is `OCCLUSION_OCCLUDED`, skip enqueue into the LOD render — or hide via `setVisibilityAt`

Do not fade LOD on occluded instances; they should not draw at all.
