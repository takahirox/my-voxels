# Voxel Subsystem Specification v0.1

## 1. Goal and authority

Voxel storage, streaming, meshing, lighting, collision, generation, and
persistence are replaceable capabilities. `VoxelStorage` owns canonical block
data. Meshes, light fields, collision acceleration structures, heightmaps, and
renderer objects are derived and disposable.

On a server, only the server issues authoritative revisions. A local single-player
runtime assumes the same authority role. Clients keep a replicated authoritative
base plus a separate prediction overlay.

## 2. Coordinates and chunk identity

The world uses a right-handed integer grid: +X east, +Y up, and +Z south.
`VoxelWorldConfig` owns chunk dimensions. The reference configuration starts with
16 voxels on X and Z; vertical section height is configurable and recorded in
world metadata.

```ts
interface IVec3 { readonly x: number; readonly y: number; readonly z: number }
interface ChunkCoord { readonly x: number; readonly z: number }
interface SectionCoord extends ChunkCoord { readonly y: number }
interface LocalVoxelCoord { readonly x: number; readonly y: number; readonly z: number }

type BlockId = number & { readonly __brand: "BlockId" };
type ChunkRevision = bigint & { readonly __brand: "ChunkRevision" };
type OverlayRevision = bigint & { readonly __brand: "OverlayRevision" };
type EditCommandId = string & { readonly __brand: "EditCommandId" };

interface VoxelEdit {
  readonly position: IVec3;
  readonly block: BlockId;
}
```

All coordinates are safe integers within configured world bounds. World-to-chunk
conversion uses mathematical floor division, so voxel `-1` belongs to chunk `-1`,
not chunk `0`. Local coordinates are always non-negative and smaller than the
configured dimension. These rules are shared by storage, protocol, streaming,
meshing, collision, and persistence codecs.

## 3. Core capabilities and storage state

```ts
type ChunkState =
  | "unloaded"
  | "loading"
  | "ready"
  | "dirty"
  | "saving"
  | "failed";

interface ReadonlyChunk {
  readonly coord: ChunkCoord;
  readonly revision: ChunkRevision;
  readonly blocks: ReadonlyArray<BlockId>;
}

interface VoxelStorage {
  get(position: IVec3): BlockId | undefined;
  getChunk(coord: ChunkCoord): ReadonlyChunk | undefined;
  state(coord: ChunkCoord): ChunkState;
  apply(transaction: VoxelTransaction): VoxelCommitResult;
}
```

`undefined` means the chunk is not ready; it never means air. Reads do not trigger
implicit loading. `ChunkDemand` requests residency, `ChunkSource` loads or
generates immutable chunk input, and `ChunkResidency` owns the state transition:

```text
unloaded -> loading -> ready
                    \-> failed
ready -> dirty -> saving -> ready
          ^           \-> dirty + diagnostic
ready|failed -> unloaded
```

Edits are accepted only while every affected chunk is `ready` or `dirty`.
Loading, failed, saving-only, and unloaded chunks return a typed unavailable
result. A save failure leaves canonical memory state `dirty`, records a diagnostic,
and follows bounded caller-owned retry policy; it never rolls canonical data back
to older persisted state.

## 4. Authoritative revisions and transactions

```ts
interface ChunkBaseRevision {
  readonly coord: ChunkCoord;
  readonly revision: ChunkRevision;
}

interface VoxelTransaction {
  readonly commandId: EditCommandId;
  readonly base: readonly ChunkBaseRevision[];
  readonly edits: readonly VoxelEdit[];
}

type VoxelCommitResult =
  | { readonly status: "committed"; readonly revisions: readonly ChunkBaseRevision[]; readonly invalidation: VoxelInvalidation }
  | { readonly status: "rejected"; readonly code: string; readonly current: readonly ChunkBaseRevision[] };
```

The authority totally orders accepted transactions. It validates session
permission, chunk availability, every base revision, coordinates, block values,
and gameplay rules before writing. A transaction that touches multiple chunks
locks or stages them in stable coordinate order and commits every affected chunk
or none. Each affected chunk revision increments once for the committed
transaction. Partial success and implicit last-writer-wins are forbidden.

A client applies a delta only when its base equals the local authoritative chunk
revision. A gap, unknown base, or older complete payload triggers a complete-chunk
request. Complete replacement is also atomic and cannot move revision backward.

## 5. Structured invalidation

```ts
interface RevisionRef { readonly source: string; readonly value: bigint }

interface VoxelInvalidation {
  readonly commandId: EditCommandId;
  readonly chunks: readonly ChunkCoord[];
  readonly sections: readonly SectionCoord[];
  readonly touchedBoundaries: readonly ("west" | "east" | "down" | "up" | "north" | "south")[];
  readonly revisions: readonly RevisionRef[];
}
```

Storage emits invalidation but never calls a mesher, renderer, light solver,
collision cache, navigation module, or persistence backend. Consumers coalesce
duplicate invalidations while retaining the newest revision for every source.
Boundary edits invalidate the affected neighboring section for algorithms whose
input crosses that boundary.

An output candidate is valid only if every input revision still matches at commit.
Inputs may include the edited chunk, neighbors, lighting, material definitions,
meshing configuration, collision configuration, and prediction overlay. Checking
only the primary chunk revision is insufficient.

## 6. Meshing

The reference visible-face mesher is the correctness oracle. The v0.1 greedy
mesher is lighting-independent and builds two-dimensional masks per face plane,
merging compatible faces into maximal rectangles. Compatibility includes material,
texture, normal direction, and every vertex attribute that cannot vary across the
merged quad.

Lighting-aware compatibility is introduced with the lighting milestone. A later
implementation may merge only equal corner lighting/AO, use a representation that
supports larger lit quads, or declare a fidelity tradeoff. No choice changes the
storage or renderer-neutral geometry contract.

Renderers consume neutral typed geometry: positions, optional normals/UV/colors,
indices, material key, bounds, and the complete input revision set. A Three.js
adapter converts this into `BufferGeometry`; other renderers consume the same
contract.

## 7. Versioned job execution

Meshing, lighting, generation, compression, and other derived work use the job
contract from `ARCHITECTURE.md`. A request contains immutable input and its full
revision set. Completion validates the set atomically with output commit; a changed
input makes the result `obsolete`.

Executors expose calibrated queue, concurrency, memory, and output limits. Work
for the same chunk and compatible input can coalesce. Demand loss cancels queued
work and cancels or deprioritizes running work at declared cancellation points.
Priority considers distance, visibility, whether old output exists, and aging;
aging supplies a measured maximum wait so low-priority chunks cannot starve.

Old geometry may remain visible while replacement runs, but its age is measured
and bounded by the target profile. A result arriving after unload or runtime stop
is discarded.

## 8. Lighting

Lighting consumes occupancy and material properties, not render geometry. Output
is a revisioned chunk/section light field. Its revision participates in the mesher
input revision set.

The initial-mesh policy is explicit per installation: wait for first light, emit
provisional geometry and remesh, or update a separate GPU lighting representation.
No policy is hidden inside storage or meshing. M1 uses the documented
lighting-independent meshing contract; operational light invalidation begins in
M5, while M4 implements its contract and tests.

## 9. Collision and predicted overlay

`VoxelCollision` queries canonical authoritative voxel state. Client prediction
may render and target an overlay immediately, but an unconfirmed placed voxel is
not authoritative character support and an unconfirmed removal does not erase
authoritative collision.

On edit acceptance, the confirmed command is removed from the overlay after the
new authoritative revision is installed. On rejection, only that command's
overlay contribution is removed. Derived overlay output is invalidated, then
character prediction reconciles against authoritative voxel collision. This order
prevents an unconfirmed platform from becoming trusted movement state.

## 10. Streaming and residency

Residency uses demand tickets rather than direct player coupling:

```ts
interface ChunkDemandTicket {
  readonly owner: string;
  readonly coord: ChunkCoord;
  readonly priority: number;
  readonly reason: "render" | "physics" | "ai" | "network" | "tooling";
  readonly expiresAtTick: bigint;
}
```

The residency manager merges tickets, applies load/unload hysteresis, and enforces
calibrated resident-chunk, queue, in-flight, and memory limits. Overload sheds or
deprioritizes derived/render demand before authoritative physics or server demand.
Unloading cancels eligible jobs and waits only for the configured persistence
policy; unsaved authoritative chunks remain dirty or produce an explicit fatal
persistence diagnostic rather than disappearing silently.

Server demand can come from players, physics, AI, persistence jobs, or
administrative tooling. Server rendering modules are unnecessary.

## 11. Persistence

Persistence stores authoritative chunk data and revision metadata. It never stores
prediction overlay, renderer objects, or derived caches as canonical state. A load
validates coordinate, codec, world configuration, and revision metadata before the
chunk becomes ready. Generated and persisted sources resolve through an explicit
source policy; persisted authoritative data cannot be silently replaced by newly
generated data.

## 12. Predicted edit reconciliation

Each predicted edit has a command ID, authoritative base revisions, and a separate
overlay revision. Overlay revisions order local derived work only; they never
compare as authoritative chunk revisions.

Acknowledgements match command ID rather than arrival order. Acceptance installs
the returned authoritative revisions atomically, removes the confirmed overlay,
and invalidates dependent output. Rejection removes only the rejected overlay and
rebuilds from the remaining overlay over the newest authoritative base. A base
revision mismatch requests the missing delta or complete chunk before prediction
continues for that chunk.

## 13. Voxel acceptance tests

Contract tests cover positive and negative coordinates, chunk/section boundaries,
simultaneous edits, reversed acknowledgements, base mismatch, revision gaps,
multi-chunk atomicity, loading-time edits, save failure, neighboring invalidation,
material and lighting revision changes, obsolete jobs, demand cancellation,
starvation, unload races, and predicted-support rejection.

Each performance scenario records target device, chunk dimensions, view and demand
radius, resident chunks, edit burst, executor configuration, repetitions, frame
time, CPU job time, memory, geometry age, and queue wait. Thresholds and overload
degradation policy are calibrated and recorded before the owning milestone gate.
