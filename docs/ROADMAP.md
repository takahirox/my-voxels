# Roadmap

## Milestone 0 — Architecture executable skeleton

- TypeScript monorepo
- ECS entity/component/resource/query primitives
- fixed-step runtime
- module graph and typed capabilities
- schedule ordering and cycle detection
- unit tests for headless runtime

## Milestone 1 — Single-player voxel sandbox

- browser input
- voxel storage
- chunk residency
- worker job abstraction
- visible-face reference mesher
- greedy mesher
- Three.js rendering adapter
- character collision/controller
- block raycast and editing

Acceptance: walk, jump, place, and remove blocks in a generated world.

## Milestone 2 — Authoritative multiplayer

- binary protocol package
- WebSocket reference transport
- server sessions
- interest management
- chunk streaming
- authoritative character state
- remote entity interpolation

Acceptance: two browser clients share a world and see each other.

## Milestone 3 — Prediction

- command sequence history
- predicted component snapshots
- server acknowledgements
- reconciliation and replay
- presentation smoothing
- artificial latency/jitter/loss harness

Acceptance: local movement remains immediate under 150 ms RTT while server rejects invalid movement.

## Milestone 4 — Predicted voxel interaction

- predicted voxel overlay
- PlaceVoxel / RemoveVoxel commands
- server validation
- chunk revision reconciliation
- derived mesh/light invalidation

Acceptance: block edits feel immediate but rejected edits recover correctly.

## Milestone 5 — Lighting and production chunk pipeline

- skylight solver job
- lighting revisions
- configurable initial-mesh lighting policy
- worker pools and priorities
- render-region batching
- profiler/devtools views

## Milestone 6 — Extensibility proof

Publish alternate implementations proving the contracts are real:

- second renderer or renderer mock
- alternate mesher
- alternate transport (loopback or WebTransport experiment)
- alternate voxel storage backend

No gameplay module should need modification when these are swapped.
