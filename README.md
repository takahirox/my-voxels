# my-voxels

A TypeScript-first framework for building modular, networked voxel games.

`my-voxels` is designed from first principles around four ideas:

1. **A tiny ECS runtime** — the core only schedules and executes game state transitions.
2. **Composable capabilities** — rendering, networking, voxels, physics, input, persistence, and gameplay are replaceable modules.
3. **Shared simulation** — client prediction and server authority execute the same simulation rules whenever practical.
4. **Low-latency interaction** — local input reacts immediately while the server remains authoritative over trusted game state.

This repository currently contains the architecture specification for the framework.

## Design goals

- TypeScript-first APIs with strong inference and minimal boilerplate.
- No renderer, transport, physics engine, or voxel algorithm is mandatory.
- Client and server runtimes use the same ECS primitives.
- Fixed-step simulation is independent from rendering and network frequencies.
- Multiplayer supports prediction, reconciliation, interpolation, validation, and rollback of predicted commands.
- CPU-heavy voxel work can run through pluggable job executors such as Web Workers or worker threads.
- Modules communicate through typed capabilities instead of reaching into each other's internals.
- A useful game should be possible without understanding the framework internals.

## Non-goals

- Providing a complete game out of the box.
- Requiring deterministic floating-point behavior across every runtime.
- Baking Three.js, WebGPU, Rapier, WebSocket, Colyseus, or any other large dependency into the core.
- Treating networking as a special responsibility of the ECS core.

## Proposed workspace

```text
packages/
  ecs/                   # entities, components, queries, resources
  runtime/               # schedules, clocks, module installation
  module-api/            # typed capabilities and module contracts

  net-protocol/          # transport-independent packets and codecs
  net-transport-websocket/ # reference WebSocket transport
  net-server/            # authority, replication, interest management
  net-client/            # snapshots, interpolation, prediction bridge
  prediction/            # command history, reconciliation, replay

  voxel-storage/         # chunk/block storage interfaces
  voxel-streaming/       # chunk demand, loading, unloading
  voxel-meshing/         # meshing contracts + reference mesher
  voxel-lighting/        # lighting contracts + reference light solver
  voxel-collision/       # canonical voxel collision queries
  voxel-editing/         # predicted/authoritative block commands
  voxel-persistence/     # canonical chunk persistence adapters

  input-browser/         # keyboard, mouse, touch, gamepad
  renderer-three/        # optional Three.js renderer
  physics-rapier/        # optional Rapier integration

  character-controller/  # shared predicted movement example
  devtools/              # tick, entity, network and prediction inspection
  sandbox/               # reference multiplayer voxel playground
```

## Runtime sketch

```ts
const app = createRuntime({
  clock: fixedClock({ hz: 60 }),
  modules: [
    browserInput(),
    voxelStorage(),
    voxelStreaming(),
    greedyVoxelMesher(),
    sunlight(),
    characterController(),
    networkClient(),
    prediction(),
    threeRenderer(),
  ],
});

await app.start();
```

The server installs a different module set while sharing simulation modules:

```ts
const server = createRuntime({
  clock: fixedClock({ hz: 60 }),
  modules: [
    voxelStorage(),
    characterController(),
    networkServer(),
    persistence(),
  ],
});

await server.start();

// Both client and server runtimes use the same lifecycle contract.
await app.stop();
await server.stop();
```

Runtime construction is synchronous. Lifecycle hooks and external I/O may be
asynchronous. `start()` and `stop()` are idempotent and follow the state machine
defined in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#10-runtime-lifecycle-and-error-model).

## Implementation gates

The framework specification is normative before implementation. Milestone 0 may
start only after the public primitive contracts, deterministic ordering graph,
state ownership rules, atomic commit rules, capability resolution rules, command
state machine, runtime/job failure contracts, and v0.1 package scope are reflected
in the architecture tests.

Later milestones have their own decision gates for prediction, voxel revisions,
transport limits, and calibrated acceptance thresholds. See
[`docs/ROADMAP.md`](docs/ROADMAP.md). Values that depend on target hardware or
representative load are measured and recorded before their milestone gate; they
are not silently chosen by an implementation.

## Core rule

> Core defines how state is executed. Modules define what the game is.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the core contracts,
[`docs/NETWORKING.md`](docs/NETWORKING.md) for command and transport semantics,
[`docs/VOXELS.md`](docs/VOXELS.md) for chunk and revision semantics,
[`docs/DECISIONS.md`](docs/DECISIONS.md) for accepted decisions, and
[`docs/ROADMAP.md`](docs/ROADMAP.md) for implementation gates.
