// @ts-expect-error Node types are supplied by the supported Node runtime.
import assert from "node:assert/strict";
// @ts-expect-error Node types are supplied by the supported Node runtime.
import test from "node:test";

import {
  AIR,
  CHUNK_VOLUME,
  GRASS,
  STONE,
  ChunkCandidate,
  VoxelStorage,
  blockId,
  voxelIndex,
  worldToChunk,
  type BlockId,
  type ChunkCoord,
} from "./index.js";

function candidate(coord: ChunkCoord, fill: BlockId = AIR): ChunkCandidate {
  const blocks = new Uint16Array(CHUNK_VOLUME);
  blocks.fill(fill);
  return new ChunkCandidate(coord, blocks);
}

test("negative world coordinates use mathematical floor conversion", () => {
  assert.deepEqual(worldToChunk({ x: -1, y: 63, z: -17 }), {
    chunk: { x: -1, z: -2 },
    local: { x: 15, y: 63, z: 15 },
  });
  assert.deepEqual(worldToChunk({ x: 16, y: 0, z: 15 }), {
    chunk: { x: 1, z: 0 },
    local: { x: 0, y: 0, z: 15 },
  });
});

test("canonical indexing is x + z*16 + localY*256", () => {
  assert.equal(voxelIndex({ x: 0, y: 0, z: 0 }), 0);
  assert.equal(voxelIndex({ x: 15, y: 0, z: 15 }), 255);
  assert.equal(voxelIndex({ x: 3, y: 2, z: 5 }), 3 + 5 * 16 + 2 * 256);
  assert.equal(voxelIndex({ x: 15, y: 63, z: 15 }), CHUNK_VOLUME - 1);
});

test("coordinates, block ids, and candidate buffers are validated", () => {
  assert.throws(() => worldToChunk({ x: 0.5, y: 0, z: 0 }), RangeError);
  assert.throws(() => worldToChunk({ x: 0, y: -1, z: 0 }), RangeError);
  assert.throws(() => worldToChunk({ x: 0, y: 64, z: 0 }), RangeError);
  assert.throws(() => voxelIndex({ x: 16, y: 0, z: 0 }), RangeError);
  assert.throws(() => blockId(5), RangeError);
  assert.throws(() => new ChunkCandidate({ x: 0, z: 0 }, new Uint16Array(1)), RangeError);
  const invalid = new Uint16Array(CHUNK_VOLUME);
  invalid[0] = 99;
  assert.throws(() => new ChunkCandidate({ x: 0, z: 0 }, invalid), RangeError);
});

test("candidates and snapshots are defensively copied and storage-owned", () => {
  const source = new Uint16Array(CHUNK_VOLUME);
  source[voxelIndex({ x: 1, y: 2, z: 3 })] = GRASS;
  const input = new ChunkCandidate({ x: 0, z: 0 }, source);
  source.fill(STONE);
  const leakedCandidateCopy = input.blocks;
  leakedCandidateCopy.fill(STONE);

  const storage = new VoxelStorage();
  const result = storage.commit(input);
  assert.equal(result.status, "committed");
  if (result.status !== "committed") throw new Error("commit failed");
  assert.equal(storage.get({ x: 1, y: 2, z: 3 }), GRASS);
  assert.equal(storage.get({ x: 0, y: 0, z: 0 }), AIR);

  const leakedSnapshotCopy = result.snapshot.blocks;
  leakedSnapshotCopy.fill(STONE);
  assert.equal(result.snapshot.get({ x: 1, y: 2, z: 3 }), GRASS);
  assert.equal(storage.get({ x: 1, y: 2, z: 3 }), GRASS);
  assert.ok(Object.isFrozen(result.snapshot));
  assert.ok(Object.isFrozen(result.snapshot.coord));
});

test("chunk revisions are monotonic bigints, including across unload", () => {
  const storage = new VoxelStorage();
  const first = storage.commit(candidate({ x: 2, z: 3 }, GRASS));
  const second = storage.commit(candidate({ x: 2, z: 3 }, STONE));
  assert.equal(first.status, "committed");
  assert.equal(second.status, "committed");
  if (first.status !== "committed" || second.status !== "committed") throw new Error("commit failed");
  assert.equal(typeof first.snapshot.revision, "bigint");
  assert.equal(first.snapshot.revision, 1n);
  assert.equal(second.snapshot.revision, 2n);
  storage.unload({ x: 2, z: 3 });
  assert.equal(storage.state({ x: 2, z: 3 }), "unloaded");
  const third = storage.commit(candidate({ x: 2, z: 3 }, AIR));
  assert.equal(third.status, "committed");
  if (third.status !== "committed") throw new Error("commit failed");
  assert.equal(third.snapshot.revision, 3n);
});

test("a stale member rejects the complete input revision set", () => {
  const storage = new VoxelStorage();
  const a = storage.commit(candidate({ x: 0, z: 0 }));
  const b = storage.commit(candidate({ x: 1, z: 0 }));
  if (a.status !== "committed" || b.status !== "committed") throw new Error("commit failed");
  const inputs = [
    { coord: a.snapshot.coord, revision: a.snapshot.revision },
    { coord: b.snapshot.coord, revision: b.snapshot.revision },
  ] as const;
  storage.commit(candidate({ x: 1, z: 0 }, STONE));
  assert.equal(storage.revisionsMatch(inputs), false);
  assert.deepEqual(storage.commit(candidate({ x: 2, z: 0 }), inputs), { status: "stale" });
  assert.equal(storage.state({ x: 2, z: 0 }), "unloaded");
});

test("horizontal halo distinguishes unavailable chunks from air", () => {
  const storage = new VoxelStorage();
  storage.commit(candidate({ x: -1, z: 0 }, AIR));
  const halo = storage.horizontalHalo({ x: 0, z: 0 });
  assert.equal(halo.west.status, "available");
  assert.equal(halo.east.status, "unavailable");
  if (halo.west.status !== "available") throw new Error("west halo missing");
  assert.equal(halo.west.chunk.get({ x: 0, y: 0, z: 0 }), AIR);
  assert.deepEqual(halo.east, { status: "unavailable", coord: { x: 1, z: 0 } });
});
