// @ts-expect-error Node types are supplied by the supported Node runtime.
import assert from "node:assert/strict";
// @ts-expect-error Node types are supplied by the supported Node runtime.
import test from "node:test";

import { bakeVertexLight, computeSunlight, LightVolume } from "./index.js";
import { createMeshInput, meshGreedy } from "../../voxel-mesher/src/index.js";
import {
  AIR, CHUNK_VOLUME, STONE, WATER, ChunkCandidate, VoxelStorage, voxelIndex,
  type BlockId,
} from "../../voxel-storage/src/index.js";

function setup(voxels: readonly (readonly [number, number, number, BlockId])[]) {
  const blocks = new Uint16Array(CHUNK_VOLUME);
  for (const [x, y, z, block] of voxels) blocks[voxelIndex({ x, y, z })] = block;
  const storage = new VoxelStorage();
  const result = storage.commit(new ChunkCandidate({ x: 0, z: 0 }, blocks));
  if (result.status !== "committed") throw new Error("commit failed");
  const input = createMeshInput(result.snapshot, storage.horizontalHalo(result.snapshot.coord));
  return { storage, input };
}

test("sunlight is deterministic and opaque blocks stop a top-down column", () => {
  const value = setup([[3, 30, 4, STONE]]);
  const first = computeSunlight(value.input);
  const second = computeSunlight(value.input);
  assert.deepEqual(first.data, second.data);
  assert.equal(first.get(3, 31, 4), 15);
  assert.equal(first.get(3, 30, 4), 0);
  assert.equal(first.get(3, 29, 4), 0);
  assert.equal(first.get(2, 29, 4), 15);
  const leaked = first.data;
  leaked.fill(0);
  assert.equal(first.get(2, 29, 4), 15);
});

test("water attenuates sunlight but remains lit", () => {
  const value = setup([[3, 40, 4, WATER], [3, 39, 4, WATER]]);
  const light = computeSunlight(value.input);
  assert.equal(light.get(3, 41, 4), 15);
  assert.equal(light.get(3, 40, 4), 14);
  assert.equal(light.get(3, 39, 4), 13);
  assert.equal(light.get(3, 38, 4), 13);
});

test("baking leaves mesh topology invariant and emits per-vertex RGB", () => {
  const value = setup([[8, 40, 8, STONE]]);
  const mesh = meshGreedy(value.input);
  const positions = mesh.positions.slice();
  const indices = mesh.indices.slice();
  const result = bakeVertexLight(mesh, computeSunlight(value.input));
  assert.equal(result.status, "baked");
  if (result.status !== "baked") throw new Error("bake failed");
  assert.equal(result.vertexCount, mesh.vertexCount);
  assert.equal(result.light.length, mesh.vertexCount);
  assert.equal(result.colors.length, mesh.vertexCount * 3);
  assert.ok(result.colors.some((channel) => channel > 0));
  assert.deepEqual(mesh.positions, positions);
  assert.deepEqual(mesh.indices, indices);
});

test("mismatched and stale revision sets are rejected as obsolete", () => {
  const first = setup([[8, 40, 8, STONE]]);
  const mesh = meshGreedy(first.input);
  const secondCommit = first.storage.commit(new ChunkCandidate({ x: 0, z: 0 }, new Uint16Array(CHUNK_VOLUME)));
  if (secondCommit.status !== "committed") throw new Error("commit failed");
  const secondInput = createMeshInput(secondCommit.snapshot, first.storage.horizontalHalo(secondCommit.snapshot.coord));
  assert.deepEqual(bakeVertexLight(mesh, computeSunlight(secondInput)), {
    status: "obsolete", reason: "revision-mismatch",
  });

  const wrongLength = new LightVolume(new Uint8Array(CHUNK_VOLUME), []);
  assert.deepEqual(bakeVertexLight(mesh, wrongLength), {
    status: "obsolete", reason: "revision-mismatch",
  });
});

test("light volume validates shape and range", () => {
  assert.throws(() => new LightVolume(new Uint8Array(1), []), RangeError);
  const invalid = new Uint8Array(CHUNK_VOLUME);
  invalid[0] = 16;
  assert.throws(() => new LightVolume(invalid, []), RangeError);
});
