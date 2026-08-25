// @ts-expect-error Node types are supplied by the supported Node runtime.
import assert from "node:assert/strict";
// @ts-expect-error Node types are supplied by the supported Node runtime.
import test from "node:test";

import { CommitError, World, defineComponent, defineResource } from "./index.js";

const Position = defineComponent<{ x: number }>("position");
const Velocity = defineComponent<{ x: number }>("velocity");
const Tick = defineResource<number>("tick");

test("operations are deferred and queries use entity order", () => {
  const world = new World();
  const commands = world.commands();
  const first = commands.spawn();
  const second = commands.spawn();
  commands.set(second, Position, { x: 2 }).set(first, Position, { x: 1 });
  assert.deepEqual(world.query(Position), []);
  commands.commit();
  assert.deepEqual(world.query(Position), [first, second]);
  assert.deepEqual(world.get(first, Position), { x: 1 });
});

test("component, resource, and despawn changes are deferred", () => {
  const world = new World();
  const setup = world.commands();
  const entity = setup.spawn();
  setup.set(entity, Position, { x: 1 }).setResource(Tick, 1).commit();

  const changes = world.commands();
  changes.remove(entity, Position).set(entity, Velocity, { x: 3 }).removeResource(Tick);
  assert.deepEqual(world.get(entity, Position), { x: 1 });
  assert.equal(world.getResource(Tick), 1);
  changes.commit();
  assert.equal(world.get(entity, Position), undefined);
  assert.deepEqual(world.get(entity, Velocity), { x: 3 });
  assert.equal(world.getResource(Tick), undefined);

  const removal = world.commands();
  removal.despawn(entity);
  assert.equal(world.has(entity), true);
  removal.commit();
  assert.equal(world.has(entity), false);
});

test("conflicting writes reject the whole batch", () => {
  const world = new World();
  const setup = world.commands();
  const entity = setup.spawn();
  setup.set(entity, Position, { x: 1 }).commit();

  const conflict = world.commands();
  conflict.set(entity, Position, { x: 2 }).set(entity, Position, { x: 3 });
  assert.throws(() => conflict.commit(), (error: unknown) => error instanceof CommitError && error.code === "COMMIT_CONFLICT");
  assert.deepEqual(world.get(entity, Position), { x: 1 });
});

test("invalid references and stale batches roll back atomically", () => {
  const world = new World();
  const invalid = world.commands();
  const spawned = invalid.spawn();
  invalid.set(999 as typeof spawned, Position, { x: 9 });
  assert.throws(() => invalid.commit(), (error: unknown) => error instanceof CommitError && error.code === "INVALID_ENTITY");
  assert.equal(world.has(spawned), false);

  const older = world.commands();
  const current = world.commands();
  current.spawn();
  current.commit();
  older.spawn();
  assert.throws(() => older.commit(), (error: unknown) => error instanceof CommitError && error.code === "STALE_BATCH");
  assert.deepEqual(world.query(), [0]);
});
