# playcanvas-opti-pixel

GPU instancing, LOD, BVH frustum culling, and occlusion culling for [PlayCanvas](https://playcanvas.com/).

The library is built around a few independent systems that share the same ID and AABB conventions. Use only what you need.

| System | Start here |
| --- | --- |
| Hierarchical GPU instancing + LOD | [Choosing an instancer](docs/instancing/choosing-instancer.md) |
| Occlusion culling (HZB, coverage, queries, CPU software) | [Choosing an occlusion backend](docs/occlusion/choosing-backend.md) |
| Bounding volume hierarchy | [BVH](docs/bvh.md) |
| Shared stores, queues, data textures | [Extras](docs/extras.md) |

Full table of contents: [docs/README.md](docs/README.md).

## Install

```bash
npm install playcanvas-opti-pixel playcanvas
```

Requires **PlayCanvas 2.x** (developed against `playcanvas@^2.19`). WebGL2 and WebGPU are both supported; not every occlusion backend is available on both.

```ts
import {
    HierarchicalInstancer,
    AABBStore,
    SoftwareOcclusionTester,
    OCCLUSION_OCCLUDED,
} from "playcanvas-opti-pixel";
```

## Minimal examples

Instancing with two LOD levels:

```ts
const instancer = new HierarchicalInstancer(app.graphicsDevice, { capacity: 1024 });
instancer.addLOD(lod0MeshInstances, rootEntity, 0);
instancer.addLOD(lod1MeshInstances, rootEntity, 40);

for (let i = 0; i < count; i++) {
    instancer.setMatrixAt(i, matrices[i]);
    instancer.setActiveAndVisibilityAt(i, true);
}

instancer.computeBVH();

app.on("update", (dt) => {
    instancer.update(dt, camera.camera, camera.getPosition());
});
```

CPU software occlusion (skip draws that fail the last completed test):

```ts
const aabbs = new AABBStore(app.graphicsDevice, 4096);
const tester = new SoftwareOcclusionTester(aabbs, { width: 256, height: 128 });

const occludeeId = tester.lock(worldAabb);
tester.occluders.lockBox(occluderWorldMatrix);

app.on("update", () => {
    tester.enqueue(occludeeId);
    tester.execute(camera.camera);

    if (tester.getOcclusionStatus(occludeeId) !== OCCLUSION_OCCLUDED) {
        // draw — treat OCCLUSION_UNKNOWN as visible
    }
});
```

`OCCLUSION_UNKNOWN` (`-1`) means there is no finished result yet. Draw in that case; do not hide the object.

## Module map

Exports live in `src/index.ts`.

- **Instancer** — `BasicHierarchicalInstancer`, `SimpleHierarchicalInstancer`, `HierarchicalInstancer`, `BasicArrayHierarchicalInstancer`, LOD fade helpers
- **Occlusion** — `OcclusionCullingSystem`, HZB (WebGL / WebGPU), coverage buffer (WebGL), occlusion queries (WebGL), `SoftwareOcclusionTester` + `OccluderStore`
- **BVH** — `BVH`, `HybridBuilder`
- **Extras** — `AABBStore`, square / mat4 / color data textures, index and GPU queues

Internal worker code, HZB / coverage shaders, and buffer layouts are not part of the public docs. See comments in `src/` if you are changing the implementation.

API reference: [GitHub Pages](https://alexappi.github.io/playcanvas-opti-pixel/) (built on `main`). Locally: `npm run docs:api` → `docs/api/index.html`.

## License

[Apache-2.0](src/LICENSE)
