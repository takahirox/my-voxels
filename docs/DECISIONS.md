# Initial Architecture Decisions

## ADR-001: Networking is not part of ECS core

**Decision:** Core contains no socket, replication, or connection concepts.

**Reason:** A headless local simulation and a multiplayer simulation should use the same runtime. Networking is one consumer/provider of commands and state.

## ADR-002: Modules depend on typed capabilities

**Decision:** Dependencies use opaque typed tokens rather than global string service names.

**Reason:** This gives TypeScript inference, refactor safety, and implementation substitution.

## ADR-003: Simulation uses fixed ticks

**Decision:** Game simulation is fixed-step and independent of render FPS.

**Reason:** Prediction, replay, server authority, physics stability, and tests all become simpler.

## ADR-004: Client sends intent, not trusted movement state

**Decision:** Authoritative movement consumes client input commands.

**Reason:** Immediate client response can coexist with server-side validation and simulation.

## ADR-005: Async derived work is versioned

**Decision:** Background jobs receive source revisions and obsolete results are discarded.

**Reason:** Meshing, lighting, generation, and compression can finish out of order without corrupting current state.

## ADR-006: Voxel storage and derived representations are separate

**Decision:** Meshes, light fields, collision acceleration structures, and renderer objects are derived caches.

**Reason:** They can be rebuilt, replaced, and processed concurrently without becoming canonical world state.

## ADR-007: Predicted voxel state uses an overlay

**Decision:** Unconfirmed edits do not mutate the client's authoritative base copy destructively.

**Reason:** Rejection and reconciliation become straightforward and revision-safe.

## ADR-008: Reference server starts with Node.js + WebSocket

**Decision:** Begin with a conventional Node.js WebSocket server behind a transport abstraction.

**Reason:** It minimizes infrastructure-specific assumptions while the protocol and prediction model are still evolving.
