// @ts-expect-error Node types are supplied by the supported Node runtime.
import assert from "node:assert/strict";
// @ts-expect-error Node types are supplied by the supported Node runtime.
import test from "node:test";

import { AIR, GRASS, SOIL, STONE, WATER, voxelIndex, type BlockId } from "../../voxel-storage/src/index.js";
import { WATER_LEVEL, generateTerrain, terrainHeight } from "./index.js";

function at(blocks: Uint16Array, x: number, y: number, z: number): BlockId {
  return blocks[voxelIndex({ x, y, z })] as BlockId;
}

test("generation is deterministic and does not mutate storage", () => {
  const first = generateTerrain(42n, { x: -3, z: 5 });
  const second = generateTerrain(42n, { x: -3, z: 5 });
  assert.deepEqual(first.blocks, second.blocks);
  assert.notEqual(first.blocks, second.blocks);
  assert.notDeepEqual(first.blocks, generateTerrain(43n, { x: -3, z: 5 }).blocks);
});

test("columns contain stone, soil, grass, optional water, then air", () => {
  const seed = 7n;
  const chunk = generateTerrain(seed, { x: 0, z: 0 });
  const blocks = chunk.blocks;
  for (const [x, z] of [[0, 0], [7, 11], [15, 15]] as const) {
    const height = terrainHeight(seed, x, z);
    assert.equal(at(blocks, x, 0, z), STONE);
    assert.equal(at(blocks, x, height - 4, z), STONE);
    assert.equal(at(blocks, x, height - 3, z), SOIL);
    assert.equal(at(blocks, x, height - 1, z), SOIL);
    assert.equal(at(blocks, x, height, z), GRASS);
    if (height < WATER_LEVEL) {
      assert.equal(at(blocks, x, height + 1, z), WATER);
      assert.equal(at(blocks, x, WATER_LEVEL, z), WATER);
    }
    assert.equal(at(blocks, x, Math.max(height, WATER_LEVEL) + 1, z), AIR);
  }
});

test("height field stays bounded and locally smooth over positive and negative coordinates", () => {
  for (const seed of [0n, 7n, 0xffff_ffff_ffff_ffffn]) {
    let steepSteps = 0;
    let steps = 0;
    for (let z = -96; z <= 96; z += 3) {
      for (let x = -96; x <= 96; x += 3) {
        const height = terrainHeight(seed, x, z);
        assert.ok(height >= 23 && height <= 38, `${height} at ${x},${z}`);
        for (const [dx, dz] of [[1, 0], [0, 1]] as const) {
          const difference = Math.abs(height - terrainHeight(seed, x + dx, z + dz));
          assert.ok(difference <= 2, `step ${difference} at ${x},${z}`);
          steepSteps += Number(difference === 2);
          steps++;
        }
      }
    }
    assert.ok(steepSteps < steps / 20);
  }
});

test("different seeds produce different smooth height fields", () => {
  const first = Array.from({ length: 64 }, (_, index) => terrainHeight(100n, index % 8 - 4, Math.floor(index / 8) - 4));
  const second = Array.from({ length: 64 }, (_, index) => terrainHeight(101n, index % 8 - 4, Math.floor(index / 8) - 4));
  assert.notDeepEqual(first, second);
});

test("adjacent chunks use one global coordinate function at their seam", () => {
  const seed = 123456789n;
  const west = generateTerrain(seed, { x: -1, z: 2 }).blocks;
  const east = generateTerrain(seed, { x: 0, z: 2 }).blocks;
  for (let z = 0; z < 16; z++) {
    const globalZ = 2 * 16 + z;
    const westHeight = terrainHeight(seed, -1, globalZ);
    const eastHeight = terrainHeight(seed, 0, globalZ);
    assert.equal(at(west, 15, westHeight, z), GRASS);
    assert.equal(at(east, 0, eastHeight, z), GRASS);
    assert.ok(Math.abs(westHeight - eastHeight) <= 2);
  }
});

test("generation order and unrelated chunks cannot affect output", () => {
  const seed = 999n;
  const before = generateTerrain(seed, { x: 4, z: -2 }).blocks;
  generateTerrain(seed, { x: 100, z: 100 });
  generateTerrain(seed, { x: -100, z: -100 });
  const after = generateTerrain(seed, { x: 4, z: -2 }).blocks;
  assert.deepEqual(after, before);
});

test("seed and coordinate validation is explicit", () => {
  assert.throws(() => generateTerrain(-1n, { x: 0, z: 0 }), RangeError);
  assert.throws(() => generateTerrain(0x1_0000_0000_0000_0000n, { x: 0, z: 0 }), RangeError);
  assert.throws(() => terrainHeight(0n, Number.MAX_SAFE_INTEGER + 1, 0), RangeError);
  assert.throws(() => generateTerrain(0n, { x: 0.5, z: 0 }), RangeError);
});
