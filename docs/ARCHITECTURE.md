# Architecture Specification v0.1

## 1. Purpose

`my-voxels` is a TypeScript-first framework for composing voxel games from
independently replaceable subsystems. Its smallest useful layer is a domain-neutral
ECS execution environment. Rendering, networking, world storage, chunk streaming,
meshing, lighting, input, physics, persistence, character movement, UI, and
gameplay rules remain modules outside the core.

The architecture is built around state, schedules, typed capabilities, commands,
and explicit authority boundaries.

## 2. Architectural principles

### 2.1 Core stays domain-neutral

Core defines Entity, Component, Query, Resource, Event, Command, Schedule, Clock,
Module, Capability, Job, Runtime, and Diagnostic. It does not define Player,
Block, Camera, Socket, Mesh, PhysicsBody, Inventory, or Chunk.

### 2.2 Composition is capability-based

Modules depend on opaque typed capability tokens rather than packages, global
strings, or concrete implementations. Tokens also declare provider multiplicity,
optionality, and scope.

### 2.3 Client and server share simulation primitives

Predicted gameplay rules use the same fixed-step ECS primitives on the client and
authoritative server. Perfect floating-point equality is not required; the
prediction contract defines snapshots, tolerances, reconciliation, and replay.

### 2.4 Rendering is a view

Authoritative simulation never depends on renderer objects. Presentation modules
mirror simulation state but cannot write authoritative state.

### 2.5 Transport is replaceable

Protocol, replication, prediction, and transport are separate layers. Gameplay
does not depend on WebSocket, WebTransport, or any hosted adapter.

### 2.6 Expensive work uses generic jobs

Meshing, lighting, generation, compression, and pathfinding submit immutable jobs.
Algorithms own computation; executors own concurrency. Inline, Web Worker, and
worker-thread executors implement the same job contract.

## 3. Primitive contracts and state ownership

The following declarations define the required shape, not final implementation
syntax. Public implementations may add fields without weakening these contracts.

```ts
declare const brand: unique symbol;

type Entity = number & { readonly [brand]: "Entity" };
type StableKey = string & { readonly [brand]: "StableKey" };
type Stage = "collect" | "prepare" | "simulate" | "resolve" | "commit" | "replicate" | "present" | "cleanup";
type RuntimeState = "created" | "starting" | "running" | "stopping" | "stopped" | "failed";

interface ComponentType<T> { readonly key: StableKey; readonly kind: "component" }
interface ResourceKey<T> { readonly key: StableKey; readonly kind: "resource" }
interface EventType<T> { readonly key: StableKey; readonly kind: "event" }
interface CommandType<P, R = void> {
  readonly key: StableKey;
  readonly kind: "command";
  readonly result?: R;
}

type CapabilityMultiplicity = "single" | "collection";
type CapabilityRequirement = "required" | "optional";
type CapabilityScope = "runtime" | "module";
type ResolveResult<T> = T | readonly T[] | undefined;

interface CapabilityToken<T> {
  readonly key: StableKey;
  readonly multiplicity: CapabilityMultiplicity;
  readonly requirement: CapabilityRequirement;
  readonly scope: CapabilityScope;
}

interface CapabilityProvider<T> {
  readonly token: CapabilityToken<T>;
  readonly key: StableKey;
  readonly value: T | (() => T | Promise<T>);
  readonly delayed?: boolean;
}

interface SystemContext {
  read<T>(type: ComponentType<T> | ResourceKey<T>): Readonly<T>;
  write<T>(type: ComponentType<T> | ResourceKey<T>, value: T): void;
}

interface ModuleContext {
  resolve<T>(token: CapabilityToken<T>): ResolveResult<T>;
}

interface Diagnostic {
  readonly code: string;
  readonly severity: "fatal" | "error" | "warning" | "info";
  readonly message: string;
  readonly relatedKeys?: readonly StableKey[];
}

interface RuntimeError extends Error { readonly diagnostic: Diagnostic }

interface SystemDefinition {
  readonly key: StableKey;
  readonly stage: Stage;
  readonly before?: readonly StableKey[];
  readonly after?: readonly StableKey[];
  readonly reads: readonly StableKey[];
  readonly writes: readonly StableKey[];
  run(context: SystemContext): void;
}

interface ModuleDefinition {
  readonly key: StableKey;
  readonly requires: readonly CapabilityToken<unknown>[];
  readonly provides: readonly CapabilityProvider<unknown>[];
  readonly systems: readonly SystemDefinition[];
  start?(context: ModuleContext): void | Promise<void>;
  stop?(context: ModuleContext): void | Promise<void>;
}

interface Runtime {
  readonly state: RuntimeState;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface RuntimeConfig {
  readonly clock: Clock;
  readonly modules: readonly ModuleDefinition[];
}

interface Clock { readonly stepSeconds: number }

declare function defineComponent<T>(key: string): ComponentType<T>;
declare function defineCapability<T>(token: Omit<CapabilityToken<T>, "key"> & { key: string }): CapabilityToken<T>;
declare function provide<T>(token: CapabilityToken<T>, key: string, value: T | (() => T | Promise<T>)): CapabilityProvider<T>;
declare function defineModule(module: Omit<ModuleDefinition, "key"> & { key: string }): ModuleDefinition;
declare function createRuntime(config: RuntimeConfig): Runtime;
```

Definitions are created synchronously and become immutable after runtime
construction. `createRuntime()` validates configuration without starting external
I/O. Components and resources can change only through declared system access or a
deferred command buffer. Lifecycle hooks may be asynchronous.

A minimal type-inference example is:

```ts
interface Vec3 { readonly x: number; readonly y: number; readonly z: number }

const Position = defineComponent<Vec3>("position");
const SpatialQuery = defineCapability<{ get(entity: Entity): Vec3 | undefined }>({
  key: "spatial-query",
  multiplicity: "single",
  requirement: "required",
  scope: "runtime",
});

const spatialModule = defineModule({
  key: "spatial-module",
  requires: [],
  provides: [provide(SpatialQuery, "spatial-provider", {
    get: (_entity: Entity) => undefined,
  })],
  systems: [{
    key: "integrate-position" as StableKey,
    stage: "simulate",
    reads: [Position.key],
    writes: [Position.key],
    run: (_context: SystemContext) => {},
  }],
});

const runtime = createRuntime({
  clock: { stepSeconds: 1 / 60 },
  modules: [spatialModule],
});
await runtime.start();
await runtime.stop();
```

The repository's type tests compile examples like this and include negative tests
for missing, duplicate, and type-incompatible registration.

### 3.1 State ownership matrix

| Category | Source of truth | Writers | Persistent/replicated | Rollback | Disposal |
| --- | --- | --- | --- | --- | --- |
| authoritative | server or local authoritative runtime | authoritative simulation and validated commit | yes | only by explicit authoritative transaction | no |
| predicted | client prediction runtime | declared predicted systems | no | yes, from a replay snapshot | discarded on session reset |
| presentation | renderer/UI module | presentation systems | no | no; corrected from simulation | freely disposable |
| derived cache | jobs or cache modules | atomic validated job commit | no | no | rebuildable from source revisions |

Gameplay reads authoritative state. A system may read predicted state only while
executing in an explicitly declared prediction context. Presentation and derived
state never feed authoritative decisions. Architecture tests must reject forbidden
dependency edges.

### 3.2 ECS visibility and writes

Entities are opaque runtime-issued IDs. Components are typed entity data;
resources are runtime-scoped singleton data. Queries are cached or compiled and
observe the state at the start of their stage.

Each system declares its read and write sets. Structural changes and asynchronous
results enter a command buffer and become visible only at the next stage boundary.
The commit validates every referenced revision and all write conflicts, then
applies the complete batch atomically. A conflict, stale revision, or validation
failure rejects the entire batch; partial application and implicit
last-writer-wins are forbidden.

## 4. Deterministic scheduling and ordering

The default stages are:

```text
collect -> prepare -> simulate -> resolve -> commit -> replicate -> present -> cleanup
```

Each system belongs to exactly one stage. The runtime builds one ordering graph:

- stage precedence creates edges between stages;
- a required capability creates provider-before-consumer edges;
- explicit `before` and `after` constraints create system edges;
- lifecycle dependencies create provider-before-consumer startup edges.

Registration order is never a tie-breaker. Nodes without another ordering edge
sort by their unique stable key. Missing references, duplicate keys, and cycles
fail before startup. Cycle diagnostics include every participating node and edge.
Shutdown calls successful module `stop` hooks in reverse startup order.

Simulation uses a fixed timestep independent from rendering, snapshot, and
transport frequencies. Presentation receives interpolation alpha and never changes
simulation ordering.

## 5. Module and capability model

A module declaratively contributes required and provided capabilities, component
and resource definitions, systems, and lifecycle hooks. A module key participates
in stable ordering and diagnostics; capability tokens remain the dependency keys.

Capability resolution is fixed before `start()`:

| Token declaration | Zero providers | One provider | Multiple providers |
| --- | --- | --- | --- |
| required single | `CAPABILITY_MISSING` | provider | `CAPABILITY_AMBIGUOUS` |
| optional single | explicit `None` | provider | `CAPABILITY_AMBIGUOUS` |
| required collection | `CAPABILITY_MISSING` | stable-key array | stable-key array |
| optional collection | empty array | stable-key array | stable-key array |

Runtime-scoped capabilities share one resolved value. Module-scoped capabilities
resolve separately for each consuming module. A provider whose value requires
startup is marked delayed: its token resolves during validation, but its value is
unavailable until the provider's `start()` succeeds. Consumers may use delayed
values only after their dependency edge has completed.

Optional single capabilities return an explicit option type; the runtime never
silently selects the first provider. Capability dependency cycles are ordering
cycles and fail with the same graph diagnostic.

## 6. Commands and events

Events are ephemeral facts visible within their declared tick lifetime. Commands
represent uniquely identified intent and can be validated, transmitted, predicted,
recorded, acknowledged, rejected, and replayed.

The processing states are:

```text
created -> received -> validated -> accepted -> acknowledged
                              \-> rejected -> acknowledged
```

Duplicate delivery returns the existing result without executing the command
again. Replay restores an explicit prediction snapshot and suppresses network,
persistence, analytics, audio, and other external side effects. The wire envelope,
session windows, history bounds, and reconnect rules are normative in
[`NETWORKING.md`](NETWORKING.md).

## 7. Networking architecture

Networking remains outside runtime core:

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

Transport implementations do not know ECS component types. Networking metadata
maps application codecs and replication policy to otherwise network-neutral ECS
state. See [`NETWORKING.md`](NETWORKING.md).

## 8. Voxel architecture

Voxel behavior is decomposed into VoxelStorage, ChunkDemand, ChunkSource,
ChunkResidency, VoxelQuery, VoxelMutation, VoxelMesher, VoxelLighting,
VoxelCollision, and VoxelPersistence capabilities.

Block mutation emits structured invalidation but never directly invokes a
renderer, mesher, light solver, or persistence backend. Authoritative and overlay
revisions, coordinate rules, chunk transactions, and load/save states are
normative in [`VOXELS.md`](VOXELS.md).

## 9. Concurrency and job contract

ECS simulation is single-writer in v0.1. Jobs operate on immutable or
copy-on-submit inputs and return candidates for atomic stage-boundary commit.

```ts
interface RevisionRef {
  readonly source: StableKey;
  readonly value: bigint;
}

type RevisionSet = readonly RevisionRef[];
type CancelReason = "superseded" | "demand-lost" | "shutdown" | "budget" | "operator";

interface JobError {
  readonly diagnostic: Diagnostic;
  readonly retryable: boolean;
}

interface JobRequest<I> {
  readonly id: StableKey;
  readonly kind: StableKey;
  readonly importance: "required" | "optional";
  readonly input: Readonly<I>;
  readonly revisions: RevisionSet;
}

type JobResult<O> =
  | { readonly status: "succeeded"; readonly output: Readonly<O>; readonly revisions: RevisionSet }
  | { readonly status: "failed"; readonly error: JobError }
  | { readonly status: "cancelled"; readonly reason: CancelReason }
  | { readonly status: "obsolete"; readonly changed: readonly RevisionRef[] };
```

Job states are `queued -> running -> succeeded|failed|cancelled|obsolete`.
Completion revalidates the full input revision set in the same atomic operation
that commits output. Required-job failure blocks its owning operation; optional-job
failure reports a diagnostic and follows the module's declared degraded behavior.
The caller owns retry policy so retries remain visible and bounded.

Every executor exposes queue, concurrency, memory, and output-size limits;
coalescing, cancellation points, and aging behavior; and a bounded shutdown. On
runtime stop it rejects new jobs, cancels cancellable jobs, waits only for the
configured shutdown bound, and discards late results. Inline and worker executors
must pass one contract test suite.

## 10. Runtime lifecycle and error model

```text
created -> starting -> running -> stopping -> stopped
              \          \             \
               -----------> failed <----
```

`start()` called while starting returns the same operation and while running
resolves without another startup. If startup fails, the runtime stops each module
whose start completed, in reverse order, then enters `failed`. `stop()` called
while stopping returns the same operation and while stopped resolves without
another shutdown. Stopped and failed runtimes are terminal; a new runtime must be
constructed to restart. A stop requested during startup cancels remaining startup
and performs reverse cleanup.

Fatal startup errors include missing or ambiguous capabilities, duplicate stable
keys, ordering cycles, invalid configuration, and required lifecycle failure.
Recoverable runtime errors are module-declared and cannot corrupt authoritative
state.

```ts
interface Diagnostic {
  readonly code: string;
  readonly severity: "fatal" | "error" | "warning" | "info";
  readonly message: string;
  readonly module?: StableKey;
  readonly system?: StableKey;
  readonly capability?: StableKey;
  readonly relatedKeys?: readonly StableKey[];
  readonly cause?: unknown;
}
```

Diagnostic codes and fields are stable machine-readable API. Human messages may
evolve without changing the code. Public lifecycle promises reject with a
`RuntimeError` carrying this diagnostic rather than an untyped string.

## 11. Developer experience

APIs prioritize TypeScript inference and discoverability. Users do not manually
allocate numeric IDs, use global string registries, or write routine serialization
plumbing. Development builds expose schedule graphs, entity/component inspection,
chunk residency, job timings, prediction errors, network impairment, and bandwidth
counters as optional modules.

## 12. v0.1 scope and package responsibilities

v0.1 includes the executable ECS/runtime/module API, fixed-step scheduling,
capability resolution, canonical voxel storage, lighting-independent reference
meshing, and the minimum protocol/clock/history/validation/resynchronization
contracts needed by later prediction. Multiple production transports, lighting,
production job pools, broader devtools, and Bun compatibility are later work.

| Package | Owns | May depend on |
| --- | --- | --- |
| `ecs` | entities, components, resources, queries, command buffers | no domain package |
| `module-api` | module, capability, diagnostic, job contracts | `ecs` public types |
| `runtime` | clock, schedules, ordering, lifecycle, atomic commit | `ecs`, `module-api` |
| `net-protocol` | envelopes, codecs, snapshot/baseline identifiers | shared value types only |
| `net-transport-websocket` | WebSocket framing and logical send queues | `net-protocol` |
| `net-server` | sessions, validation, authority, replication, interest | protocol, runtime/module APIs |
| `net-client` | snapshots, interpolation, transport bridge | protocol, runtime/module APIs |
| `prediction` | history, replay snapshots, reconciliation | protocol, runtime/module APIs |
| `voxel-storage` | canonical chunks, coordinates, revisions | runtime/module APIs |
| `voxel-streaming` | demand, residency, loading state | voxel contracts, runtime/module APIs |
| `voxel-meshing` | neutral geometry and mesher jobs | voxel contracts, job API |
| `voxel-lighting` | light fields and solver jobs | voxel contracts, job API |
| `voxel-collision` | canonical collision queries and derived acceleration | voxel contracts, job API |
| `voxel-editing` | edit commands and prediction overlay | voxel contracts, protocol/prediction APIs |
| `voxel-persistence` | authoritative chunk and revision persistence adapters | voxel contracts, module API |
| adapters and gameplay | concrete input, render, physics, controller, persistence | declared public capabilities only |

Domain packages depend toward `runtime`/`module-api`/`ecs`; those core packages
never import domain packages. Shared coordinate, revision, geometry, and protocol
value types live with the contract owner, not an adapter. Dependency-cycle checks
enforce this direction.

## 13. Architectural and acceptance tests

Architecture tests prove headless execution, deterministic order, capability
resolution, state authority, atomic conflicts, lifecycle cleanup, executor
substitution, renderer-free simulation, alternate mesher/storage/transport
providers, reconciliation under impairment, and rejection of illegal commands.

Every scenario records initial state, inputs, ticks and seeds, target runtime and
load, network impairment, expected state/events/diagnostics, forbidden
transitions, repetition count, and relevant error/time/memory/bandwidth metrics.
Environment-dependent pass thresholds are measured on named target profiles and
recorded before the owning milestone gate. Qualitative terms such as “responsive”
or “recovers correctly” are not acceptance criteria by themselves.
