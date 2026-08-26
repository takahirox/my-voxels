// @ts-expect-error Node types are supplied by the supported Node runtime.
import assert from "node:assert/strict";
// @ts-expect-error Node types are supplied by the supported Node runtime.
import test from "node:test";

import { createMeshInput, meshGreedy, meshVisibleFaces } from "./index.js";
import {
  AIR, CHUNK_VOLUME, STONE, WATER, ChunkCandidate, VoxelStorage, voxelIndex,
  type BlockId, type ChunkCoord, type HorizontalHalo,
} from "../../voxel-storage/src/index.js";

function setup(voxels: readonly (readonly [number, number, number, BlockId])[] = []) {
  const storage = new VoxelStorage();
  const blocks = new Uint16Array(CHUNK_VOLUME);
  for (const [x, y, z, block] of voxels) blocks[voxelIndex({ x, y, z })] = block;
  const committed = storage.commit(new ChunkCandidate({ x: 0, z: 0 }, blocks));
  if (committed.status !== "committed") throw new Error("commit failed");
  return { storage, snapshot: committed.snapshot };
}

function allAirHalo(storage: VoxelStorage): HorizontalHalo {
  for (const coord of [{ x: -1, z: 0 }, { x: 1, z: 0 }, { x: 0, z: -1 }, { x: 0, z: 1 }]) {
    storage.commit(new ChunkCandidate(coord, new Uint16Array(CHUNK_VOLUME)));
  }
  return storage.horizontalHalo({ x: 0, z: 0 });
}

test("one voxel produces six oracle quads and adjacent voxels cull their hidden face", () => {
  const one = setup([[8, 8, 8, STONE]]);
  assert.equal(meshVisibleFaces(createMeshInput(one.snapshot, one.storage.horizontalHalo(one.snapshot.coord))).quadCount, 6);
  const two = setup([[8, 8, 8, STONE], [9, 8, 8, STONE]]);
  const mesh = meshVisibleFaces(createMeshInput(two.snapshot, two.storage.horizontalHalo(two.snapshot.coord)));
  assert.equal(mesh.quadCount, 10);
  assert.equal(mesh.exposedSurfaceArea, 10);
});

test("greedy merging reduces a plane while preserving oracle surface area", () => {
  const voxels: Array<readonly [number, number, number, BlockId]> = [];
  for (let z = 2; z < 10; z++) for (let x = 2; x < 10; x++) voxels.push([x, 20, z, STONE]);
  const value = setup(voxels);
  const input = createMeshInput(value.snapshot, value.storage.horizontalHalo(value.snapshot.coord));
  const oracle = meshVisibleFaces(input);
  const greedy = meshGreedy(input);
  assert.ok(greedy.quadCount < oracle.quadCount);
  assert.equal(greedy.exposedSurfaceArea, oracle.exposedSurfaceArea);
});

test("AO darkens a corner beside occluders and participates in greedy signatures", () => {
  const value = setup([
    [8, 8, 8, STONE], [7, 9, 8, STONE], [8, 9, 7, STONE],
  ]);
  const mesh = meshVisibleFaces(createMeshInput(value.snapshot, value.storage.horizontalHalo(value.snapshot.coord)));
  assert.ok(Math.max(...mesh.ao) > Math.min(...mesh.ao));
});

test("water and opaque faces remain separate", () => {
  const value = setup([[7, 8, 8, WATER], [8, 8, 8, STONE]]);
  const mesh = meshGreedy(createMeshInput(value.snapshot, value.storage.horizontalHalo(value.snapshot.coord)));
  const ids = new Set(mesh.blockIds);
  assert.ok(ids.has(WATER));
  assert.ok(ids.has(STONE));
  assert.equal(mesh.exposedSurfaceArea, 12);
});

test("mesh buffers have renderer-neutral types, valid sizes, and bounded indices", () => {
  const value = setup([[8, 8, 8, STONE]]);
  const mesh = meshGreedy(createMeshInput(value.snapshot, value.storage.horizontalHalo(value.snapshot.coord)));
  assert.ok(mesh.positions instanceof Float32Array);
  assert.ok(mesh.normals instanceof Float32Array);
  assert.ok(mesh.indices instanceof Uint32Array);
  assert.ok(mesh.blockIds instanceof Uint16Array);
  assert.ok(mesh.ao instanceof Uint8Array);
  assert.ok(mesh.light instanceof Uint8Array);
  assert.ok(mesh.colors instanceof Uint8Array);
  assert.equal(mesh.positions.length, mesh.vertexCount * 3);
  assert.equal(mesh.normals.length, mesh.vertexCount * 3);
  assert.equal(mesh.blockIds.length, mesh.vertexCount);
  assert.equal(mesh.ao.length, mesh.vertexCount);
  assert.equal(mesh.light.length, mesh.vertexCount);
  assert.equal(mesh.colors.length, mesh.vertexCount * 3);
  assert.equal(mesh.indices.length, mesh.triangleCount * 3);
  assert.ok(mesh.indices.every((index) => index < mesh.vertexCount));
});

test("available air exposes a boundary face while a missing halo is conservatively solid", () => {
  const missing = setup([[0, 8, 8, STONE]]);
  const missingMesh = meshVisibleFaces(createMeshInput(missing.snapshot, missing.storage.horizontalHalo(missing.snapshot.coord)));
  const available = setup([[0, 8, 8, STONE]]);
  const halo = allAirHalo(available.storage);
  const availableMesh = meshVisibleFaces(createMeshInput(available.snapshot, halo));
  assert.equal(missingMesh.quadCount, 5);
  assert.equal(availableMesh.quadCount, 6);
  assert.equal(availableMesh.revisions.length, 5);
});

test("halo coordinates are validated", () => {
  const value = setup();
  const bad = {
    ...value.storage.horizontalHalo(value.snapshot.coord),
    west: { status: "unavailable", coord: { x: 99, z: 0 } },
  } as const;
  assert.throws(() => createMeshInput(value.snapshot, bad), RangeError);
});
