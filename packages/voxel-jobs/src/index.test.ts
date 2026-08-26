// @ts-expect-error Node types are supplied by the supported Node runtime.
import assert from "node:assert/strict";
// @ts-expect-error Node types are supplied by the supported Node runtime.
import test from "node:test";

import { generateTerrain } from "../../terrain-generator/src/index.js";
import {
  BrowserWorkerExecutor,
  BrowserWorkerPool,
  InlineVoxelExecutor,
  VoxelJobScheduler,
  calculateJobPriority,
  collectTransferableArrayBuffers,
  compareJobPriority,
  createVoxelJob,
  workerCountForHardwareConcurrency,
  type VoxelJob,
  type WorkerErrorEvent,
  type WorkerLike,
  type WorkerMessageEvent,
} from "./index.js";
import {
  dispatchVoxelWorkerRequest,
  type TerrainJobInputWire,
  type TerrainResultWire,
} from "./worker-entry.js";

const signal = new AbortController().signal;

function job(
  id: string,
  type: "terrain" | "mesh" | "lighting" | "bake",
  options: {
    dependencies?: readonly { id: string; type: "terrain" | "mesh" | "lighting" | "bake" }[];
    visible?: boolean;
    distance?: number;
    downstream?: number;
    sequence?: number;
    commit?: (result: unknown) => void;
    revision?: Readonly<Record<string, number>>;
  } = {},
): VoxelJob {
  return createVoxelJob({
    id,
    type,
    revision: options.revision ?? { chunk: 1 },
    dependencies: options.dependencies ?? [],
    visible: options.visible ?? true,
    distance: options.distance ?? 0,
    downstream: options.downstream ?? 0,
    enqueuedAt: 0,
    sequence: options.sequence ?? 0,
    input: id,
    commit: options.commit ?? (() => undefined),
  });
}

test("job contracts defensively freeze revisions, dependencies, and priority", () => {
  const revision: Record<string, number> = { chunk: 2 };
  const dependencies = [{ id: "terrain", type: "terrain" as const }];
  const value = createVoxelJob({
    id: "mesh", type: "mesh", revision, dependencies, visible: true,
    distance: 4, downstream: 2, enqueuedAt: 10, sequence: 3, input: {}, commit: () => undefined,
  });
  revision.chunk = 9;
  dependencies[0]!.id = "changed";
  assert.deepEqual(value.revision, { chunk: 2 });
  assert.deepEqual(value.dependencies, [{ id: "terrain", type: "terrain" }]);
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.revision));
  assert.ok(Object.isFrozen(value.dependencies));
  assert.ok(Object.isFrozen(value.priority));
});

test("priority is visible, distance, downstream, bounded-age, then stable sequence", () => {
  const policy = { ageQuantumMs: 10, maxAgeBoost: 3 };
  const visible = calculateJobPriority({
    visible: true, distance: 10, downstream: 0, enqueuedAt: 0, sequence: 9,
  }, 1_000, policy);
  const hidden = calculateJobPriority({
    visible: false, distance: 0, downstream: 99, enqueuedAt: 0, sequence: 0,
  }, 1_000, policy);
  assert.ok(compareJobPriority(visible, hidden) < 0);
  assert.equal(visible.distanceRank, 7);
  assert.equal(visible.ageRank, -3);

  const near = calculateJobPriority({
    visible: true, distance: 1, downstream: 0, enqueuedAt: 100, sequence: 2,
  }, 100, policy);
  const far = calculateJobPriority({
    visible: true, distance: 2, downstream: 100, enqueuedAt: 100, sequence: 1,
  }, 100, policy);
  assert.ok(compareJobPriority(near, far) < 0);

  const moreDownstream = calculateJobPriority({
    visible: true, distance: 1, downstream: 4, enqueuedAt: 100, sequence: 8,
  }, 100, policy);
  assert.ok(compareJobPriority(moreDownstream, near) < 0);
  const stableFirst = calculateJobPriority({
    visible: true, distance: 1, downstream: 4, enqueuedAt: 100, sequence: 7,
  }, 100, policy);
  assert.ok(compareJobPriority(stableFirst, moreDownstream) < 0);
});

test("scheduler releases dependencies and records deterministic assignments", async () => {
  const commits: string[] = [];
  let clock = 10;
  const executor = new InlineVoxelExecutor({
    terrain: (value) => `${value.input}:done`,
    mesh: (value) => `${value.input}:done`,
    lighting: (value) => `${value.input}:done`,
    bake: (value) => `${value.input}:done`,
  });
  const scheduler = new VoxelJobScheduler({
    concurrency: 1,
    executor,
    validateRevision: () => true,
    now: () => clock++,
  });
  const terrain = scheduler.enqueue(job("terrain", "terrain", {
    sequence: 2, commit: (result) => commits.push(String(result)),
  }));
  const mesh = scheduler.enqueue(job("mesh", "mesh", {
    dependencies: [{ id: "terrain", type: "terrain" }],
    sequence: 0,
    commit: (result) => commits.push(String(result)),
  }));
  const lighting = scheduler.enqueue(job("lighting", "lighting", {
    dependencies: [{ id: "terrain", type: "terrain" }],
    sequence: 1,
    commit: (result) => commits.push(String(result)),
  }));
  assert.equal((await terrain).status, "succeeded");
  assert.equal((await mesh).status, "succeeded");
  assert.equal((await lighting).status, "succeeded");
  assert.deepEqual(commits, ["terrain:done", "mesh:done", "lighting:done"]);
  assert.deepEqual(scheduler.metrics().assignments.map((item) => item.id), [
    "terrain", "mesh", "lighting",
  ]);
  assert.deepEqual(scheduler.metrics().queued, { terrain: 0, mesh: 0, lighting: 0, bake: 0 });
  assert.equal(scheduler.metrics().durationsMs.length, 3);
});

test("scheduler enforces bounded concurrency", async () => {
  let active = 0;
  let maximum = 0;
  const releases: (() => void)[] = [];
  const executor = new InlineVoxelExecutor({
    terrain: async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return true;
    },
  });
  const scheduler = new VoxelJobScheduler({
    concurrency: 2, executor, validateRevision: () => true,
  });
  const outcomes = [
    scheduler.enqueue(job("one", "terrain", { sequence: 0 })),
    scheduler.enqueue(job("two", "terrain", { sequence: 1 })),
    scheduler.enqueue(job("three", "terrain", { sequence: 2 })),
  ];
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(maximum, 2);
  assert.deepEqual(scheduler.metrics().running, { terrain: 2, mesh: 0, lighting: 0, bake: 0 });
  releases.shift()?.();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(maximum, 2);
  while (releases.length > 0) releases.shift()?.();
  await Promise.all(outcomes);
});

test("failed dependencies fail without execution", async () => {
  const executed: string[] = [];
  const scheduler = new VoxelJobScheduler({
    concurrency: 2,
    executor: new InlineVoxelExecutor({
      terrain: (value) => {
        executed.push(value.id);
        throw new Error("boom");
      },
      mesh: (value) => executed.push(value.id),
    }),
    validateRevision: () => true,
  });
  const parent = scheduler.enqueue(job("parent", "terrain"));
  const child = scheduler.enqueue(job("child", "mesh", {
    dependencies: [{ id: "parent", type: "terrain" }],
  }));
  const parentOutcome = await parent;
  assert.equal(parentOutcome.status, "failed");
  if (parentOutcome.status === "failed") {
    assert.equal(parentOutcome.reason, "execution");
    const parentError = parentOutcome.error;
    assert.ok(parentError instanceof Error);
    if (!(parentError instanceof Error)) throw new Error("expected Error outcome");
    assert.equal(parentError.message, "boom");
  }
  const childOutcome = await child;
  assert.equal(childOutcome.status, "failed");
  if (childOutcome.status === "failed") assert.equal(childOutcome.reason, "dependency");
  assert.deepEqual(executed, ["parent"]);
  assert.equal(scheduler.metrics().failed, 2);
});

test("stale post-execution results never commit", async () => {
  let committed = false;
  const scheduler = new VoxelJobScheduler({
    concurrency: 1,
    executor: new InlineVoxelExecutor({ terrain: () => 42 }),
    validateRevision: (revision) => revision.chunk === 2,
  });
  const outcome = await scheduler.enqueue(job("stale", "terrain", {
    revision: { chunk: 1 }, commit: () => { committed = true; },
  }));
  assert.deepEqual(outcome, { status: "stale", result: 42 });
  assert.equal(committed, false);
  assert.equal(scheduler.metrics().stale, 1);
});

test("queued and running cancellation settle as cancelled", async () => {
  let release: (() => void) | undefined;
  const scheduler = new VoxelJobScheduler({
    concurrency: 1,
    executor: new InlineVoxelExecutor({
      terrain: async () => await new Promise<void>((resolve) => { release = resolve; }),
    }),
    validateRevision: () => true,
  });
  const running = scheduler.enqueue(job("running", "terrain", { sequence: 0 }));
  const queued = scheduler.enqueue(job("queued", "terrain", { sequence: 1 }));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(scheduler.cancel("queued"), true);
  assert.equal(scheduler.cancel("running"), true);
  release?.();
  assert.deepEqual(await queued, { status: "cancelled" });
  assert.deepEqual(await running, { status: "cancelled" });
  assert.equal(scheduler.metrics().cancelled, 2);
});

class FakeWorker implements WorkerLike {
  readonly messages: { message: unknown; transfer: readonly ArrayBuffer[] }[] = [];
  readonly messageListeners = new Set<(event: WorkerMessageEvent) => void>();
  readonly errorListeners = new Set<(event: WorkerErrorEvent) => void>();
  terminated = 0;
  respond?: (message: Record<string, unknown>) => void;

  postMessage(message: object, transfer: readonly ArrayBuffer[] = []): void {
    this.messages.push({ message, transfer });
    this.respond?.(message as Record<string, unknown>);
  }

  addEventListener(type: "message" | "error", listener: ((event: WorkerMessageEvent) => void) | ((event: WorkerErrorEvent) => void)): void {
    if (type === "message") this.messageListeners.add(listener as (event: WorkerMessageEvent) => void);
    else this.errorListeners.add(listener as (event: WorkerErrorEvent) => void);
  }

  removeEventListener(type: "message" | "error", listener: ((event: WorkerMessageEvent) => void) | ((event: WorkerErrorEvent) => void)): void {
    if (type === "message") this.messageListeners.delete(listener as (event: WorkerMessageEvent) => void);
    else this.errorListeners.delete(listener as (event: WorkerErrorEvent) => void);
  }

  emitMessage(data: unknown): void {
    for (const listener of this.messageListeners) listener({ data });
  }

  emitError(error: unknown): void {
    for (const listener of this.errorListeners) listener({ error });
  }

  terminate(): void {
    this.terminated++;
  }
}

function browserJob(id: string, type: "terrain" | "mesh" | "lighting" | "bake", input: unknown): VoxelJob {
  return createVoxelJob({
    id, type, revision: {}, visible: true, distance: 0, enqueuedAt: 0, sequence: 0,
    input, commit: () => undefined,
  });
}

test("browser executor correlates out-of-order responses by unique request id", async () => {
  const worker = new FakeWorker();
  const executor = new BrowserWorkerExecutor(worker);
  const first = executor.execute(browserJob("first", "terrain", { value: 1 }), { signal });
  const second = executor.execute(browserJob("second", "mesh", { value: 2 }), { signal });
  const firstRequest = worker.messages[0]!.message as { id: string };
  const secondRequest = worker.messages[1]!.message as { id: string };
  assert.notEqual(firstRequest.id, secondRequest.id);
  worker.emitMessage({ id: secondRequest.id, ok: true, result: "second" });
  worker.emitMessage({ id: firstRequest.id, ok: true, result: "first" });
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  executor.dispose();
});

test("transfer collection recursively deduplicates typed-array backing buffers", async () => {
  const shared = new ArrayBuffer(16);
  const other = new Uint8Array(4);
  const value = {
    first: new Uint8Array(shared),
    nested: [new Uint16Array(shared), { view: new DataView(shared), other }],
  };
  assert.deepEqual(collectTransferableArrayBuffers(value), [shared, other.buffer]);
  const worker = new FakeWorker();
  const executor = new BrowserWorkerExecutor(worker);
  const pending = executor.execute(browserJob("transfer", "terrain", value), { signal });
  assert.deepEqual(worker.messages[0]!.transfer, [shared, other.buffer]);
  const request = worker.messages[0]!.message as { id: string };
  worker.emitMessage({ id: request.id, ok: true, result: null });
  await pending;
  executor.dispose();
});

test("browser executor rejects worker failures, protocol failures, errors, and dispose", async () => {
  const failedWorker = new FakeWorker();
  const failedExecutor = new BrowserWorkerExecutor(failedWorker);
  const failed = failedExecutor.execute(browserJob("failed", "terrain", {}), { signal });
  const failedId = (failedWorker.messages[0]!.message as { id: string }).id;
  failedWorker.emitMessage({ id: failedId, ok: false, error: { name: "RangeError", message: "bad input" } });
  await assert.rejects(failed, { name: "RangeError", message: "bad input" });

  const protocol = failedExecutor.execute(browserJob("protocol", "mesh", {}), { signal });
  failedWorker.emitMessage({ nope: true });
  await assert.rejects(protocol, /protocol error/);
  failedExecutor.dispose();

  const errorWorker = new FakeWorker();
  const errorExecutor = new BrowserWorkerExecutor(errorWorker);
  const errored = errorExecutor.execute(browserJob("errored", "lighting", {}), { signal });
  errorWorker.emitError(new Error("worker crashed"));
  await assert.rejects(errored, /worker crashed/);
  errorExecutor.dispose();

  const disposeWorker = new FakeWorker();
  const disposeExecutor = new BrowserWorkerExecutor(disposeWorker);
  const pending = disposeExecutor.execute(browserJob("pending", "bake", {}), { signal });
  disposeExecutor.dispose();
  disposeExecutor.dispose();
  await assert.rejects(pending, /disposed/);
  await assert.rejects(disposeExecutor.execute(browserJob("late", "terrain", {}), { signal }), /disposed/);
  assert.equal(disposeWorker.terminated, 1);
  assert.equal(disposeWorker.messageListeners.size, 0);
  assert.equal(disposeWorker.errorListeners.size, 0);
});

test("browser pool distributes every job type round-robin and sizes conservatively", async () => {
  const workers = [new FakeWorker(), new FakeWorker(), new FakeWorker()];
  for (let index = 0; index < workers.length; index++) {
    const worker = workers[index]!;
    worker.respond = (request) => queueMicrotask(() => worker.emitMessage({
      id: request.id,
      ok: true,
      result: index,
    }));
  }
  const pool = new BrowserWorkerPool(workers);
  assert.equal(pool.count, 3);
  const types = ["terrain", "mesh", "lighting", "bake", "terrain"] as const;
  const results = await Promise.all(types.map((type, index) =>
    pool.execute(browserJob(String(index), type, {}), { signal })));
  assert.deepEqual(results, [0, 1, 2, 0, 1]);
  assert.deepEqual(workers.map((worker) => worker.messages.length), [2, 2, 1]);
  assert.equal(workerCountForHardwareConcurrency(undefined), 1);
  assert.equal(workerCountForHardwareConcurrency(1), 1);
  assert.equal(workerCountForHardwareConcurrency(2), 1);
  assert.equal(workerCountForHardwareConcurrency(4), 2);
  assert.equal(workerCountForHardwareConcurrency(64), 6);
  pool.dispose();
  pool.dispose();
  assert.deepEqual(workers.map((worker) => worker.terminated), [1, 1, 1]);
});

test("inline and fake browser-worker paths produce equivalent terrain output", async () => {
  const input: TerrainJobInputWire = { seed: "42", coord: { x: -1, z: 2 } };
  const terrainJob = browserJob("terrain-equivalence", "terrain", input);
  const inline = new InlineVoxelExecutor({
    terrain: (value) => {
      const wire = value.input as TerrainJobInputWire;
      const candidate = generateTerrain(BigInt(wire.seed), wire.coord);
      const result: TerrainResultWire = { coord: candidate.coord, blocks: candidate.blocks };
      return result;
    },
  });
  const worker = new FakeWorker();
  worker.respond = (request) => queueMicrotask(() => {
    try {
      worker.emitMessage({ id: request.id, ok: true, result: dispatchVoxelWorkerRequest(request as never) });
    } catch (error) {
      worker.emitMessage({ id: request.id, ok: false, error: { message: String(error) } });
    }
  });
  const browser = new BrowserWorkerExecutor(worker);
  const expected = await inline.execute<TerrainResultWire>(terrainJob, { signal });
  const actual = await browser.execute<TerrainResultWire>(terrainJob, { signal });
  assert.deepEqual(actual.coord, expected.coord);
  assert.deepEqual(actual.blocks, expected.blocks);
  browser.dispose();
});
