# Documentation

Read these in order if you are new to the library. Skip to a choosing guide if you already know which system you need.

1. [Getting started](getting-started.md) — install, IDs, first frame loop
2. [Architecture](architecture.md) — how the systems fit together
3. [Choosing an instancer](instancing/choosing-instancer.md)
4. [Choosing an occlusion backend](occlusion/choosing-backend.md)

## Guides

### Instancing

- [Overview](instancing/overview.md)
- [Choosing an instancer](instancing/choosing-instancer.md)
- [LOD](instancing/lod.md)

### Occlusion culling

- [Overview](occlusion/overview.md)
- [Choosing a backend](occlusion/choosing-backend.md)
- [Hierarchical Z-buffer (HZB)](occlusion/hzb.md)
- [Occlusion queries](occlusion/queries.md)
- [CPU software occlusion](occlusion/software.md)

### Other

- [BVH](bvh.md)
- [Extras](extras.md) — AABB store, data textures, queues

## API reference

Guides here cover **when** and **in what order** to call things. Method signatures come from `src/index.ts`.

Generate the TypeDoc site locally (written to `docs/api/`, gitignored):

```bash
npm run docs:api
```

Then open `docs/api/index.html`.

On every push to `main`, GitHub Actions publishes TypeDoc to [GitHub Pages](https://alexappi.github.io/playcanvas-opti-pixel/).

The Actions token cannot create a Pages site. Enable it once in the GitHub UI: **Settings → Pages → Build and deployment → Source → GitHub Actions**. Then re-run **Deploy docs**.
