# Networking and Prediction Specification v0.1

## 1. Goals and authority

Multiplayer provides immediate local controls while the server remains
authoritative over trusted state:

```text
client creates intent and predicts it
server binds intent to an authenticated session
server validates and simulates intent
server acknowledges it with authoritative state
client restores, reconciles, and replays unacknowledged intent
```

Clients never choose authoritative position, velocity, health, inventory,
permission, or persistent voxel edits. Transport-supplied identity is trusted only
after authentication and is never taken from an untrusted payload.

## 2. Command envelope and sequence semantics

```ts
type CommandId = string & { readonly __brand: "CommandId128" };
type SessionId = string & { readonly __brand: "SessionId" };
type Tick = bigint;
type Sequence = bigint;

interface BaseRevision {
  readonly source: string;
  readonly value: bigint;
}

interface CommandEnvelope<K extends string, P> {
  readonly commandId: CommandId;
  readonly sessionId: SessionId;
  readonly sequence: Sequence;
  readonly clientTick: Tick;
  readonly kind: K;
  readonly payload: Readonly<P>;
  readonly baseRevisions: readonly BaseRevision[];
}
```

`sequence` and `clientTick` are unsigned 64-bit wire values represented as
`bigint` in TypeScript. They begin at zero and increase monotonically within a
session; wraparound is forbidden and requires a new session. `commandId` is an
opaque 128-bit identifier unique within the session. The server rejects a payload
whose `sessionId` does not match authenticated transport context.

Each session has configured and observable `pastTickWindow`, `futureTickWindow`,
`reorderWindow`, `reorderTimeout`, and `maxPendingCommands`. Concrete values are
calibrated from the M2 threat/load profile and recorded before that gate. Within
the reorder window, a gap may wait until the missing command or timeout. A timed
out, too-old, too-far-future, or over-limit command is rejected with a stable code;
the server never allocates an unbounded gap queue.

Duplicate `commandId` or sequence returns the stored disposition without executing
again. Conflicting reuse of an identifier is a protocol violation. A reconnect
creates a new session; old pending commands and predicted state are discarded.

## 3. Command processing state machine

```text
created -> received -> validated -> accepted -> simulated -> acknowledged
                              \-> rejected -----------------> acknowledged
```

Validation covers authenticated session binding, identifier freshness, tick and
sequence windows, payload schema, command rate, legal transitions, cooldowns,
permissions, authoritative collision, and relevant base revisions. A rejection is
an acknowledged terminal result with a stable diagnostic code.

Replay begins from a stored prediction snapshot and cannot emit network packets,
persistence writes, analytics, audio, or other external side effects. Pending
history is bounded by acknowledgement progress, configured memory limits, and
session lifetime.

## 4. Shared simulation and prediction snapshots

A predicted gameplay rule executes against predicted state on the client and
authoritative state on the server after validation. Shared fixed-step code is
preferred, but reconciliation corrects bounded numeric divergence.

```ts
interface PredictionSnapshot {
  readonly tick: Tick;
  readonly lastProcessedSequence: Sequence;
  readonly components: ReadonlyMap<string, unknown>;
  readonly randomState: ReadonlyMap<string, unknown>;
  readonly timers: ReadonlyMap<string, unknown>;
  readonly controllerState: ReadonlyMap<string, unknown>;
  readonly worldRevisions: readonly BaseRevision[];
}

interface ReconciliationResult {
  readonly restoredTick: Tick;
  readonly replayedSequences: readonly Sequence[];
  readonly positionError: number;
  readonly velocityError: number;
  readonly correction: "none" | "smooth" | "snap";
}
```

The concrete predicted component set, random generators, timers, grounding/contact
state, movement modifiers, and world revisions are registered explicitly. A
predicted system that depends on undeclared state fails validation.

At each client tick the client samples input, assigns identifiers, saves the
command and required snapshot state, predicts immediately, and sends the command.
The server validates and simulates it. An authoritative snapshot includes
`serverTick`, `lastProcessedSequence`, an identifier, its optional baseline
identifier, predicted-component state, and relevant world revisions. The client
restores authoritative state, removes acknowledged commands, replays newer ones,
and computes presentation correction.

## 5. Simulation and presentation correction

Simulation transforms drive gameplay and physics. Presentation transforms are
smoothed views and never feed simulation. Correction policy exposes calibrated
position, velocity, and angle thresholds; smoothing duration; correction-frequency
limit; and maximum extrapolation time. Teleport, respawn, invalid history, and
errors above the snap threshold snap immediately.

Thresholds are measured on named M3 device/network profiles. Acceptance records
the maximum error and time to converge after input stops and the frequency of
visible corrections. Implementations cannot substitute undocumented defaults.

## 6. Remote entities and replication modes

Remote players and most server-owned entities are interpolated, not predicted.
Clients keep bounded snapshot history around a delayed render time. Extrapolation
is capped by the correction policy, after which presentation freezes or hides
according to declared component policy.

Networking metadata classifies replicated data as authoritative, predicted,
interpolated, or local. ECS component definitions remain network-neutral.

## 7. Snapshots, baselines, and recovery

```ts
interface SnapshotEnvelope<T> {
  readonly snapshotId: string;
  readonly baselineId?: string;
  readonly serverTick: Tick;
  readonly lastProcessedSequence: Sequence;
  readonly payload: T;
}

type LogicalChannel = "input-ack" | "snapshot" | "chunk-bulk";

interface FrameEnvelope {
  readonly channel: LogicalChannel;
  readonly messageId: string;
  readonly encodedBytes: number;
  readonly fragmentCount: number;
}

interface FragmentEnvelope {
  readonly messageId: string;
  readonly fragmentIndex: number;
  readonly fragmentCount: number;
  readonly payload: Uint8Array;
}
```

Clients acknowledge applied snapshot IDs. A delta is valid only when its baseline
is present and acknowledged. Missing, evicted, or mismatched baselines cause the
client to request a complete snapshot; the invalid delta is not partially applied.
Servers retain baselines only within configured memory and age limits.

Stale snapshot, entity, and chunk revisions never move authoritative client state
backward. Timeout or repeated decode failure enters resynchronizing state; gameplay
prediction pauses or is discarded according to command kind until complete state
arrives.

## 8. Predicted voxel commands

Voxel placement and removal may update a client overlay immediately, but the
overlay never mutates the authoritative chunk base. Commands carry every affected
chunk base revision. The server validates and totally orders edits, then confirms
all affected revisions or rejects the whole command.

Authoritative character collision does not use unconfirmed voxel overlay. On
rejection or conflict, the client removes the command's overlay, invalidates its
derived results, applies authoritative voxel state, and then reconciles character
state. Reordered acknowledgements affect only the matching command ID and overlay
revision. See [`VOXELS.md`](VOXELS.md).

## 9. Interest management and chunk streaming

A generic `InterestProvider` determines entities and regions relevant to a
connection. Voxel implementations commonly use player chunk, view radius,
load/unload hysteresis, and explicit global subscriptions. Interest distance is
independent from render distance.

Chunk transfer contains coordinates, authoritative revision, compression and
codec metadata, uncompressed size, base revision for deltas, and data required
before derived processing. A revision gap or unavailable base causes a complete
chunk request. Old edits are ignored only after the client has evidence of the
newer authoritative revision.

Chunk payloads are fragmented within configured frame limits and have a bounded
reassembly lifetime. Input and acknowledgement traffic has higher logical priority
than snapshot traffic, which has higher priority than bulk chunk traffic.

## 10. Transport guarantees

The protocol assumes only authenticated connection context, message boundaries,
and detectable disconnect. It remains correct under duplicate, delayed, and stale
application messages even if a specific transport offers stronger guarantees.

| Transport | Ordering/reliability | Required adaptation |
| --- | --- | --- |
| loopback impairment | configurable loss, duplication, delay, reorder | exercise every protocol recovery path |
| WebSocket reference | reliable ordered byte stream per connection | framing, logical priority queues, fragmentation, reconnect/session reset |
| future datagram transport | transport-specific | retransmission or snapshot recovery below gameplay |

The WebSocket reference begins on Node.js. Large chunk frames must be fragmented
and scheduled so they cannot monopolize the application send queue ahead of
input/acknowledgement traffic.

## 11. Limit and security policy

All inbound data is untrusted. `LimitPolicy` supplies configurable limits whose
values are calibrated and recorded at the M2 gate:

| Area | Required limits | Violation behavior |
| --- | --- | --- |
| framing | encoded and decoded message bytes, fragment count/lifetime | drop message; disconnect repeated or structural abuse |
| compression | uncompressed bytes and compression ratio | abort decode, audit, disconnect |
| commands | rate, pending count, sequence/tick window | reject command; disconnect sustained abuse |
| coordinates | world/chunk bounds and subscription count | reject and audit |
| streaming | queued chunks, bytes, concurrent transfers, reassembly memory | shed/deprioritize bulk work |
| history | snapshots, baselines, prediction commands, age | evict safely or require full resync |

Persistent edits also check authenticated permission for every affected region.
Diagnostics distinguish normal stale data from abuse. Audit records contain
stable codes and bounded metadata, not untrusted payload bodies.

## 12. Disconnect and reconnect

```text
connected -> disconnected -> reconnecting -> resynchronizing -> connected
```

A disconnect stops new command transmission and bounds retained presentation
history. Successful reconnect creates a new authenticated session, resets sequence
to zero, discards old pending commands and prediction overlays, requests complete
authoritative state, and resumes prediction only after resynchronization. Chunk
load failure follows bounded retry policy and exposes an unavailable state rather
than fabricated empty authoritative data.

## 13. Bandwidth strategy

The reference implementation supports binary codecs, quantized transforms, delta
replication from acknowledged baselines, sparse voxel edits, and independent
update rates. Correctness and bounded recovery precede compression efficiency.
Bandwidth counters are split by logical channel and message kind.

## 14. Network acceptance harness

The loopback harness configures RTT, jitter, loss, duplication, reordering,
bandwidth, disconnects, and baseline eviction. Each test records client count,
target runtime, ticks, inputs, repetitions, expected state/diagnostics, convergence
error and time, correction frequency, queue/memory use, and bytes by channel.

Required scenarios include duplicate and conflicting IDs, gaps and timeouts,
past/future ticks, invalid movement, stale snapshots, missing baselines, reconnect,
chunk revision gaps, unauthorized subscriptions, oversized and compressed input,
bulk-transfer head-of-line pressure, and convergence after input stops. The named
150 ms RTT profile remains a mandatory scenario; pass thresholds are calibrated
and recorded before M3 rather than inferred from “responsive.”
