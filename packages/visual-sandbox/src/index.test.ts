// @ts-expect-error Node types are supplied by the supported Node runtime.
import assert from "node:assert/strict";
// @ts-expect-error Node types are supplied by the supported Node runtime.
import test from "node:test";

import { applySandboxEdgeTreatment, cloneMeshInputWire, deterministicChunks, parseSandboxConfig } from "./config.js";
import { average, formatCount, formatDuration } from "./stats.js";
import type { MeshInputWire } from "../../voxel-jobs/src/worker-entry.js";
import { AIR, CHUNK_VOLUME, STONE, voxelIndex } from "../../voxel-storage/src/index.js";

test("sandbox query parsing has stable defaults and accepts deterministic options", () => {
  assert.deepEqual(parseSandboxConfig(""), { seed: 1234n, camera: "benchmark-1", executor: "worker" });
  assert.deepEqual(parseSandboxConfig("?seed=9&camera=benchmark-1&executor=inline"), {
    seed: 9n, camera: "benchmark-1", executor: "inline",
  });
});

test("sandbox query parsing rejects invalid values", () => {
  assert.throws(() => parseSandboxConfig("?seed=-1"), /unsigned 64-bit/);
  assert.throws(() => parseSandboxConfig("?seed=18446744073709551616"), /unsigned 64-bit/);
  assert.throws(() => parseSandboxConfig("?camera=unknown"), /unknown camera/);
  assert.throws(() => parseSandboxConfig("?executor=gpu"), /unknown executor/);
});

test("chunk list is deterministic and ordered by rows", () => {
  assert.deepEqual(deterministicChunks(), [
    { x: -2, z: -2 }, { x: -1, z: -2 }, { x: 0, z: -2 }, { x: 1, z: -2 },
    { x: -2, z: -1 }, { x: -1, z: -1 }, { x: 0, z: -1 }, { x: 1, z: -1 },
    { x: -2, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 0 }, { x: 1, z: 0 },
    { x: -2, z: 1 }, { x: -1, z: 1 }, { x: 0, z: 1 }, { x: 1, z: 1 },
  ]);
});

test("sandbox edge treatment rounds and tapers the finite terrain without mutating its input", () => {
  const blocks = new Uint16Array(CHUNK_VOLUME).fill(STONE);
  const center = applySandboxEdgeTreatment({ x: 0, z: 0 }, blocks);
  const corner = applySandboxEdgeTreatment({ x: 1, z: 1 }, blocks);

  assert.notEqual(center, blocks);
  assert.equal(blocks[voxelIndex({ x: 15, y: 63, z: 15 })], STONE);
  assert.equal(center[voxelIndex({ x: 0, y: 63, z: 0 })], STONE);
  assert.equal(corner[voxelIndex({ x: 15, y: 0, z: 15 })], AIR);
  assert.equal(corner[voxelIndex({ x: 15, y: 63, z: 15 })], AIR);
  assert.equal(corner[voxelIndex({ x: 0, y: 0, z: 0 })], AIR);
  assert.equal(corner[voxelIndex({ x: 0, y: 20, z: 0 })], STONE);
  assert.equal(corner[voxelIndex({ x: 0, y: 63, z: 0 })], AIR);
});

test("wire cloning preserves revisions without sharing transferable buffers", () => {
  const blocks = new Uint16Array([1, 2, 3]);
  const source: MeshInputWire = {
    snapshot: { coord: { x: 0, z: 0 }, revision: "7", blocks },
    halo: {
      west: { status: "available", chunk: { coord: { x: -1, z: 0 }, revision: "3", blocks } },
      east: { status: "unavailable", coord: { x: 1, z: 0 } },
      north: { status: "unavailable", coord: { x: 0, z: -1 } },
      south: { status: "unavailable", coord: { x: 0, z: 1 } },
    },
    revisions: [{ coord: { x: 0, z: 0 }, revision: "7" }],
  };
  const clone = cloneMeshInputWire(source);
  assert.deepEqual(clone.revisions, source.revisions);
  assert.notEqual(clone.snapshot.blocks.buffer, blocks.buffer);
  assert.equal(clone.halo.west.status, "available");
  if (clone.halo.west.status === "available") assert.notEqual(clone.halo.west.chunk.blocks.buffer, blocks.buffer);
  clone.snapshot.blocks[0] = 9;
  assert.equal(blocks[0], 1);
});

test("stats helpers format empty, millisecond, second, and count values", () => {
  assert.equal(average([]), undefined);
  assert.equal(average([10, 20]), 15);
  assert.equal(formatDuration(undefined), "—");
  assert.equal(formatDuration(19.6), "20 ms");
  assert.equal(formatDuration(1_250), "1.25 s");
  assert.equal(formatCount(12345.4), "12,345");
});
