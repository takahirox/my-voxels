# Voxel Subsystem Specification v0.1

## 1. Goal

Voxel world functionality is a set of replaceable algorithms, not one indivisible subsystem. Storage, streaming, meshing, lighting, collision, generation, and persistence can be replaced independently.

## 2. Core voxel capabilities

`VoxelStorage` owns canonical block data. `ChunkDemand` collects residency demand from renderer, physics, AI, minimap, or server interest management. `ChunkSource` loads or generates chunks asynchronously. `VoxelMesher` outputs renderer-neutral geometry. `VoxelLighting` calculates light fields independently of geometry. `VoxelCollision` queries canonical voxel state.

```ts
interface VoxelStorage {
  get(position: IVec3): BlockId;
  getChunk(coord: ChunkCoord): ReadonlyChunk | undefined;
  apply(edit: VoxelEdit): VoxelRevision;
}
```

## 3. Chunk representation

Chunk dimensions are configuration. The reference world begins with 16×16 horizontal chunks and configurable vertical sections. Section-level dirtiness prevents isolated edits from forcing unrelated vertical ranges through the pipeline. Each chunk has a monotonic revision plus occupied-Y metadata. Heightmaps are optional derived caches rather than mandatory canonical state.

## 4. Dirty propagation

Voxel edits emit structured invalidation containing chunk, sections, boundary information, and revision. Lighting, meshing, collision, navigation, and persistence subscribe independently. Storage never directly invokes a renderer or mesher.

## 5. Meshing

Two reference meshers are planned: a naive visible-face mesher for correctness/debugging and a production greedy mesher. Greedy meshing builds 2D masks per face plane and merges compatible faces into maximal rectangles. Compatibility includes material/texture and vertex data that cannot vary safely across the merged face.

Lighting/AO compatibility is explicit: implementations may merge only compatible corner values, encode lighting so larger quads remain possible, or intentionally trade visual fidelity for fewer vertices. No meshing algorithm is baked into other voxel modules.

## 6. Meshing concurrency

Meshing is submitted as versioned jobs. If chunk revision changes before a result returns, the stale result is discarded. The browser executor should use a conservatively sized Worker pool. Scheduling priority considers distance, visibility demand, starvation prevention, and whether old geometry already exists. Old geometry may remain visible until replacement is ready.

## 7. Lighting

Lighting consumes voxel occupancy/material properties, not render geometry. The reference implementation may provide discrete skylight and later emissive/block light. Output is a revisioned chunk/section field.

If lighting is unavailable when meshing begins, policy is configurable: wait for first light, create provisional geometry and remesh, or keep geometry independent and update a separate GPU lighting representation. The framework does not hard-code one policy.

## 8. Rendering integration

Renderers consume neutral typed geometry (`positions`, optional normals/UV/colors, indices, material key). A Three.js adapter converts this into `BufferGeometry`; other renderers consume the same output without changing meshing code.

## 9. Draw-call grouping

Storage chunk boundaries and render mesh boundaries are independent. Renderers may combine multiple chunk meshes into configurable render regions. Larger regions reduce draw calls; smaller regions improve rebuild cost and culling granularity.

## 10. Streaming

Chunk streaming uses demand tickets rather than direct player-position coupling. Multiple systems may request residency simultaneously; the residency manager merges tickets and applies hysteresis to prevent load/unload churn.

## 11. Server world handling

Server residency differs from clients and can be driven by players, physics, AI, persistent jobs, or administrative tooling. Server rendering modules are unnecessary.

## 12. Predicted edits

Client predicted voxel edits live in an overlay over authoritative chunk data. Acceptance folds the edit into a new authoritative revision. Rejection removes the overlay and invalidates dependent derived data. Unconfirmed local edits never destructively overwrite the authoritative base copy.
