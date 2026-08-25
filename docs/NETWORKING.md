# Networking and Prediction Specification v0.1

## 1. Goals

Multiplayer must provide immediate local controls while keeping the server authoritative over trusted game state.

The core approach is:

```text
client sends intent
client predicts intent immediately
server validates and simulates intent
server acknowledges processed intent with authoritative state
client reconciles and replays unacknowledged intent
```

The server never needs to trust a client-supplied position as authoritative player movement.

## 2. Simulation ticks

Every predicted command is associated with client command sequence, intended simulation tick, and player/session identity supplied by transport context rather than trusted payload data.

```ts
interface CommandEnvelope<T> {
  sequence: number;
  clientTick: number;
  payload: T;
}
```

The protocol must tolerate jitter and limited reordering.

## 3. Shared simulation

A predicted gameplay rule is expressed once and executed against predicted state on the client and authoritative state on the server after validation. Shared code is preferred, but perfect deterministic equality is not required; reconciliation corrects divergence.

## 4. Character prediction pipeline

At each client tick: sample input, assign a sequence, append it to pending history, immediately simulate locally, send the command, and render predicted state.

The server authenticates the session, verifies sequence freshness, validates input/action state, queues the command, and executes authoritative simulation.

Server snapshots include `serverTick`, `lastProcessedSequence`, and authoritative predicted-component state. On receipt the client discards acknowledged commands, restores authoritative state, replays newer pending commands, and updates the presentation correction target.

## 5. Simulation state vs presentation state

Prediction correction must not automatically create visible camera snapping. Simulation transforms are used by gameplay and physics; presentation transforms are smoothed visual representations. Small corrections are eased, while large corrections snap. This policy belongs outside ECS core.

## 6. Remote entities

Remote players and most server-owned entities are not locally predicted. Clients keep bounded snapshot history and interpolate around a slightly delayed render time. Extrapolation is strictly capped.

## 7. Replication modes

Networking modules may classify data as authoritative, predicted, interpolated, or local. These policies are networking metadata; ECS components themselves remain network-agnostic.

## 8. Predicted gameplay commands

Prediction is not movement-only. Commands such as voxel placement may be locally applied, validated by the server, then confirmed or rolled back. World edits use chunk/region revisions so stale acknowledgements cannot overwrite newer state.

## 9. Anti-cheat baseline

The server treats packets as untrusted intent and validates input ranges, legal transitions, command rate, sequence/tick sanity, authoritative collision, movement modifiers, and cooldown state. Clients never choose authoritative position, velocity, health, inventory quantities, permissions, or persistent block edits.

## 10. Interest management

A generic `InterestProvider` determines entities and regions relevant to a connection. Voxel implementations commonly use player chunk position, view radius, load/unload hysteresis, and explicit global subscriptions. Interest management is independent of rendering distance.

## 11. Voxel streaming protocol

Chunk transfer supports coordinates, revisions, compressed payloads, metadata required before derived processing, and incremental edits after a base revision. Clients reject edits older than their authoritative chunk revision.

## 12. Bandwidth strategy

The reference implementation should support binary serialization, quantized transforms, delta replication from acknowledged baselines, sparse voxel edits, and independent update rates. Correctness comes before aggressive compression in v0.1.

## 13. Transport recommendation

The reference implementation begins with WebSocket on a modern Node.js server for browser support and straightforward debugging. Transport abstraction permits later WebTransport or hosted adapters.

## 14. Network test harness

A loopback transport must simulate latency, jitter, packet loss, duplication, and reordering. Acceptance targets include immediate local input, responsive movement at 150 ms RTT, convergence after input stops, rejection of invalid movement, and protection against stale snapshots rolling state backward.
