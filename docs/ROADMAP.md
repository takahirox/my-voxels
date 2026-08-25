# Roadmap

## Delivery rules

Milestones are gated specifications, not feature wish lists. A milestone starts
only after its decisions and contract tests are reviewable. Environment-dependent
limits are calibrated against named target profiles and committed with the test
configuration before the gate closes.

Every acceptance test records:

- initial authoritative, predicted, presentation, and derived state;
- input and command sequence, simulation tick count, and random seed where used;
- network profile: RTT, jitter, loss, duplication, reordering, and bandwidth;
- target device/runtime, client count, world/chunk load, and repetition count;
- expected state, events, diagnostic codes, and forbidden transitions;
- measured convergence time and error, memory and bandwidth, job latency, frame
  time, and maximum stale-geometry duration when relevant;
- the measured pass/fail threshold, calibration evidence, and owner/date.

Provider substitution uses the same contract test suite for every implementation.

## Milestone 0 — Architecture executable skeleton

Decision gate:

- public primitive TypeScript contracts and a type-checked complete module example;
- deterministic ordering graph and runtime lifecycle state machine;
- state ownership matrix and atomic stage-boundary commit rules;
- capability multiplicity, scope, and resolution diagnostics;
- command processing and runtime/job failure state machines;
- v0.1 package responsibilities and dependency direction.

Delivery:

- TypeScript monorepo;
- ECS entity/component/resource/query primitives;
- fixed-step runtime;
- module graph and typed capabilities;
- schedule ordering and cycle detection;
- unit and type tests for a headless runtime.

Acceptance: the same module set produces the same startup, tick, and shutdown
order regardless of registration order; invalid capability graphs and cycles
produce stable diagnostics; deferred conflicting writes never partially commit;
and client/server examples pass the same lifecycle contract tests.

## Milestone 1 — Single-player voxel sandbox

Decision gate:

- prediction snapshot and reconciliation contracts are specified for later use;
- chunk coordinates, revision scope, multi-chunk atomicity, load/save state, and
  revision-gap recovery are specified;
- the job contract covers cancellation, obsolescence, overload, and shutdown.

Delivery:

- browser input;
- canonical voxel storage and chunk residency;
- inline and browser-worker job executors;
- visible-face reference mesher;
- a lighting-independent greedy mesher under a provisional meshing contract;
- Three.js rendering adapter;
- character collision/controller;
- block raycast and authoritative editing.

Acceptance: under the recorded target-device and world-load profile, a scripted
player can walk, jump, place, and remove blocks; inline and worker executors
produce contract-equivalent results; boundary and multi-chunk edits are atomic;
obsolete jobs never commit; and memory, frame time, job time, and stale-geometry
metrics remain within calibrated M1 thresholds.

## Milestone 2 — Authoritative multiplayer

Decision gate:

- session/sequence windows, snapshot baseline recovery, full resynchronization,
  logical channel priorities, reconnect behavior, and limit policy are specified;
- threat and load profiles define how transport limits will be calibrated.

Delivery:

- binary protocol package;
- WebSocket reference transport;
- server sessions and authoritative command validation;
- interest management and chunk streaming;
- authoritative character state;
- remote entity interpolation;
- chunk revision deltas plus complete-chunk fallback.

Acceptance: two clients under the recorded transport and load profiles converge
on authoritative entity and chunk revisions; stale snapshots never roll state
backward; missing baselines trigger complete-state recovery; reconnect creates a
new session; bulk chunks do not violate calibrated input/ack latency; and invalid
or over-limit messages produce the specified drop, disconnect, and audit results.

## Milestone 3 — Character prediction

Decision gate:

- replay snapshot contents, numeric precision, correction policy, convergence
  metrics, and target network/device profiles are calibrated and recorded.

Delivery:

- command sequence history;
- predicted component snapshots;
- server acknowledgements;
- reconciliation and replay;
- presentation smoothing;
- artificial latency/jitter/loss/duplication/reordering harness.

Acceptance: local simulation responds in the command's client tick; the server
rejects illegal movement; under the named 150 ms RTT profile and other calibrated
profiles, position and velocity converge within the recorded error and time
thresholds after input stops; repeated correction stays below its calibrated
frequency limit; and replay emits no external side effects.

## Milestone 4 — Predicted voxel interaction

Delivery:

- predicted voxel overlay and separate overlay revisions;
- `PlaceVoxel` and `RemoveVoxel` commands with base revisions;
- server validation and all-or-none multi-chunk updates;
- chunk revision reconciliation and complete-chunk recovery;
- derived mesh invalidation; lighting invalidation is a contract until M5.

Acceptance: local overlay appears in the command's client tick; accepted edits
fold into authoritative revisions; rejected or reordered edits remove only their
overlay and converge within calibrated thresholds; rejected predicted supports
do not become authoritative character collision; and stale mesh/job results never
commit.

## Milestone 5 — Lighting and production chunk pipeline

Delivery:

- skylight solver job and lighting revisions;
- configurable initial-mesh lighting policy;
- worker pools, priorities, cancellation, coalescing, and starvation prevention;
- render-region batching;
- profiler/devtools views.

Acceptance: every lighting and mesh result validates its full input revision set;
demand loss cancels or deprioritizes work as specified; aging prevents starvation;
and the target profiles remain within calibrated memory, job, frame, and stale
geometry thresholds.

## Milestone 6 — Extensibility proof

Publish alternate implementations proving the contracts are real:

- second renderer or renderer mock;
- alternate mesher;
- alternate transport, such as loopback or a WebTransport experiment;
- alternate voxel storage backend.

Acceptance: each provider passes the same capability and subsystem contract test
suite, and no gameplay module changes when a conforming provider is substituted.
