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

## ADR-009: State categories have one-way authority

**Decision:** Authoritative state is the only persistent and server-replicated source of truth. Predicted state is client-local and rollbackable. Presentation state is view-only. Derived caches are disposable and rebuildable. Gameplay reads authoritative state except inside explicitly declared prediction execution.

**Reason:** A one-way authority model prevents presentation objects, stale jobs, and rejected predictions from contaminating trusted simulation.

## ADR-010: All execution ordering uses one deterministic graph

**Decision:** Stage order, capability dependencies, and explicit `before`/`after` constraints become edges in one ordering graph. Each system belongs to one stage, ties use a stable key rather than registration order, and shutdown reverses successful startup order.

**Reason:** Prediction, replay, and tests require the same configuration to produce the same execution order regardless of module registration order.

## ADR-011: Deferred writes commit atomically at stage boundaries

**Decision:** Structural commands and asynchronous results commit only at stage boundaries. Revision validation and application are one atomic operation; any mismatch rejects the whole commit.

**Reason:** Partial application and last-writer-wins behavior would make authoritative state timing-dependent and difficult to replay.

## ADR-012: Capability multiplicity and scope are declared by the token

**Decision:** A capability token declares `single` or `collection`, `required` or `optional`, and `runtime` or `module` scope. Missing required providers and ambiguous single providers fail before startup. Collection providers use deterministic order.

**Reason:** Provider selection must be typed, explicit, and independent of module registration order.

## ADR-013: Commands are session-scoped, uniquely identified intents

**Decision:** Predicted commands carry a command ID, session ID, sequence, client tick, kind, payload, and relevant base revision. Reconnection creates a new session and discards old pending prediction. Replay suppresses external side effects.

**Reason:** Tick numbers alone cannot safely distinguish retries, multiple commands in one tick, stale sessions, or duplicate delivery.

## ADR-014: Runtime and jobs use explicit failure state machines

**Decision:** Runtime startup cleans up already-started modules in reverse order after failure; start and stop are idempotent. Jobs declare required or optional disposition, immutable inputs, an input revision set, cancellation, and structured results. Failed or obsolete jobs never partially commit.

**Reason:** Lifecycle and background failure behavior must be observable and identical across inline, browser-worker, and worker-thread executors.

## ADR-015: v0.1 has a deliberately narrow executable scope

**Decision:** The first executable scope is ECS/runtime/module-api, fixed-step scheduling, capability resolution, canonical voxel storage, a lighting-independent reference mesher, and the minimum protocol/clock/history/validation/resynchronization contracts needed by later prediction. Lighting, production meshing, multiple transports, broader devtools, and Bun compatibility remain later or reference work.

**Reason:** Core contracts must stabilize before optional integrations expand the compatibility surface.

## ADR-016: Authoritative voxel revisions are server-issued per chunk

**Decision:** The server totally orders accepted edits and issues monotonic revisions per chunk. A multi-chunk edit validates every base revision and commits all affected chunks or none. Predicted overlay revisions remain separate. Derived jobs validate every input revision, not only the edited chunk revision.

**Reason:** Per-chunk revisions localize invalidation while atomic multi-chunk edits and complete input revision sets prevent mixed-version results.

## ADR-017: Transport and resource limits are explicit policy

**Decision:** Input/acknowledgement traffic and bulk chunk traffic use separate logical priorities. Snapshots identify their baseline and fall back to complete state when it is unavailable. Payload, decompression, subscription, queue, memory, and concurrency limits are configuration with defined violation behavior.

**Reason:** Replaceable transports still need common safety behavior, and bulk world data must not delay authoritative input processing.

## ADR-018: Environment-dependent thresholds are calibrated, not guessed

**Decision:** Acceptance tests define metrics and reproducible profiles first. Hardware-, load-, and experience-dependent pass thresholds are measured on declared target profiles and recorded before the relevant milestone gate.

**Reason:** Unmeasured fixed values are arbitrary, while qualitative terms such as “responsive” cannot detect regressions.
