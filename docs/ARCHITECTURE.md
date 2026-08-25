# Architecture Specification v0.1

## 1. Purpose

`my-voxels` is a TypeScript-first framework for composing voxel games from independently replaceable subsystems.

The framework is not a monolithic engine. Its smallest useful layer is an ECS execution environment. Rendering, networking, world storage, chunk streaming, meshing, lighting, input, physics, persistence, character movement, UI, and gameplay rules are all outside the core.

The architecture is built around **state**, **schedules**, **typed capabilities**, and **commands**.

## 2. Architectural principles

### 2.1 Core must stay domain-neutral

The core must not define Player, Block, Camera, Socket, Mesh, PhysicsBody, Inventory, or Chunk. It defines only Entity, Component, Query, Resource, Event, Command, Schedule, Clock, Module, and Capability.

### 2.2 Composition is capability-based

Modules expose typed capabilities. Consumers depend on contracts rather than implementation packages. Capabilities use opaque typed tokens rather than global strings.

```ts
export const SpatialQuery = defineCapability<{
  raycast(origin: Vec3, direction: Vec3, maxDistance: number): Hit | null;
}>();
```

### 2.3 Client and server share simulation primitives

Predicted systems should be written so the same gameplay rules can execute under client prediction and server authority.

### 2.4 Rendering is a view, not game state

Authoritative simulation state never depends on renderer objects. Renderer modules mirror ECS state into presentation objects.

### 2.5 Transport is replaceable

Networking is split into protocol, replication, prediction, and transport. WebSocket, WebTransport, and loopback transports are interchangeable below gameplay.

### 2.6 Expensive work uses generic jobs

Meshing, lighting, generation, compression, and pathfinding use a generic asynchronous job abstraction. Executors may run inline, in Web Workers, worker pools, Node worker_threads, or future remote executors. Algorithms own computation; executors own concurrency.

## 3. ECS model

Entities are opaque IDs. Components are typed data definitions. Resources are runtime-scoped singleton state. Queries are cached/compiled rather than rebuilding entity sets every frame. Structural changes during iteration are deferred through command buffers by default.

## 4. Scheduling

Default stages are intentionally generic:

```text
collect -> prepare -> simulate -> resolve -> commit -> replicate -> present -> cleanup
```

Modules attach systems using explicit ordering constraints. The scheduler detects dependency cycles at startup.

Simulation uses a fixed timestep independent of rendering and snapshot rates. Presentation receives interpolation alpha.

## 5. Module model

A module declaratively contributes requirements, provided capabilities, components, systems, and lifecycle hooks. Module IDs are diagnostic metadata rather than dependency keys.

Before startup the runtime resolves capability providers, verifies requirements, detects forbidden duplicate providers, builds the system dependency graph, and starts modules in dependency order.

## 6. Commands and events

Events are ephemeral facts within a tick. Commands represent intent and may be validated, transmitted, predicted, recorded, or replayed. Networking and prediction attach semantics to commands without changing ECS core.

## 7. Networking architecture

Networking stays outside runtime core:

```text
Transport
   ↓
Protocol / serialization
   ↓
Replication + interest management
   ↓
Prediction / reconciliation
   ↓
Gameplay commands and ECS state
```

Transport implementations do not know ECS component types. See `NETWORKING.md`.

## 8. Voxel architecture

Voxel behavior is decomposed into independent capabilities: VoxelStorage, ChunkDemand, ChunkSource, ChunkResidency, VoxelQuery, VoxelMutation, VoxelMesher, VoxelLighting, VoxelCollision, and VoxelPersistence.

Block mutation emits dirty-region information but does not directly rebuild meshes or calculate lighting. See `VOXELS.md`.

## 9. Concurrency model

ECS simulation is single-writer by default in v0.1. Async jobs operate on immutable/copy-on-submit inputs and commit results at stage boundaries. Every job has a generation/version and obsolete results are discarded.

## 10. Error model

Missing capabilities, duplicate exclusive providers, scheduler cycles, and invalid module configuration are fatal startup errors with structured diagnostics. Optional job failures must not corrupt authoritative state.

## 11. Developer experience

APIs prioritize TypeScript inference and discoverability, avoiding manual numeric IDs, string registries, and serialization plumbing. Development builds should expose schedule graphs, entity/component inspection, chunk residency, job timings, prediction error visualization, network impairment simulation, and bandwidth counters.

## 12. Initial implementation constraints

- TypeScript public authoring language.
- Browser client first target.
- Node.js reference server; Bun compatibility desirable.
- Optional Three.js reference renderer.
- WebSocket reference transport.
- Prediction begins with character movement, then voxel edits.
- Reference chunks start at 16×16 horizontally, but dimensions are configurable.

## 13. Architectural tests

Tests must prove substitution: headless ECS without renderer; shared movement under client/server runtimes; inline vs worker meshing executor; WebSocket vs loopback transport; alternate meshers over the same storage; reconciliation under latency; and rejection of illegal movement while preserving immediate local response.
