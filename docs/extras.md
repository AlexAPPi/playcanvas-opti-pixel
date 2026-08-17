# Extras

Building blocks used by instancing and occlusion. Import them when you need the same storage without the high-level systems.

## `AABBStore`

CPU (and on demand GPU) packed AABBs: center.xyz + extra1, halfExtents.xyz + extra2.

```ts
const store = new AABBStore(device, 4096);
const id = store.lock(boundingBox, optionalMatrix);
store.enqueueUpdate(id, boundingBox, optionalMatrix);
store.update(); // upload GPU textures if they were created
store.unlock(id);
```

Textures (`centersTexture`, `halfExtentsTexture`) are created on first access. Software occlusion can stay CPU-only if you never touch those getters.

`version` increments on lock/update/resize so consumers can skip copies.

## Data textures

Square (power-of-two-ish) 2D textures that pack arrays for shaders:

| Class | Contents |
| --- | --- |
| `Mat4DataTexture` / `Mat4DataTextureArray` | Instance matrices |
| `ColorDataTexture` / `ColorDataTextureArray` | Per-instance colors |
| `Vec4F32Texture` / array | Generic vec4 (AABB uses this) |
| `SquareDataTexture` / array / `LayerProxy` | Typed-array backed square textures |

Helpers: `getSquareTextureSize`, `getPixelFormatByArrayType`.

Instancers own a `Mat4DataTexture`. You only construct these if you write custom shaders.

## Queues and index pools

| Class | Role |
| --- | --- |
| `IndexManager` | Allocate / free integer slots |
| `IndexQueue` / `IndexQueueEx` | Per-frame ID lists (`IndexQueueEx` used by software occlusion) |
| `NumberQueue` / `ValueSortQueue` | CPU number buffers |
| `GPUIndexQueue` / `GPUElementQueue` | GPU-side queues (WebGPU HZB indirect path) |

## Other

- `BitSet` — compact flags (`InstancesFlags` uses a similar idea)
- `radixSort` — sort helper used when LOD renders sort instances
- `Random`, `GPUBufferTool` — miscellaneous helpers

Treat extras as **stable enough to import**, but prefer the high-level instancer and testers in application code.
