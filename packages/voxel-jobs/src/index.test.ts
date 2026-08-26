// @ts-expect-error Node types are supplied by the supported Node runtime.
import assert from "node:assert/strict";
// @ts-expect-error Node types are supplied by the supported Node runtime.
import test from "node:test";

import {
  InlineVoxelExecutor,
  VoxelJobScheduler,
  calculateJobPriority,
  compareJobPriority,
  createVoxelJob,
  type VoxelJob,
} from "./index.js";

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
