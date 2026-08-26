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
    assert.ok(Math.abs(westHeight - eastHeight) <= 4);
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
