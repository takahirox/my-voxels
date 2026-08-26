import {
  AIR,
  CHUNK_SIZE,
  CHUNK_VOLUME,
  GRASS,
  SOIL,
  STONE,
  WATER,
  ChunkCandidate,
  voxelIndex,
  type BlockId,
  type ChunkCoord,
} from "../../voxel-storage/src/index.js";

export const WATER_LEVEL = 30;

function requireSeed(seed: bigint): void {
  if (seed < 0n || seed > 0xffff_ffff_ffff_ffffn) throw new RangeError("seed must be an unsigned 64-bit bigint");
}

function mix(value: bigint): bigint {
  let mixed = BigInt.asUintN(64, value);
  mixed = BigInt.asUintN(64, (mixed ^ (mixed >> 30n)) * 0xbf58_476d_1ce4_e5b9n);
  mixed = BigInt.asUintN(64, (mixed ^ (mixed >> 27n)) * 0x94d0_49bb_1331_11ebn);
  return BigInt.asUintN(64, mixed ^ (mixed >> 31n));
}

function coordinateNoise(seed: bigint, x: number, z: number): number {
  const packed = BigInt.asUintN(64, BigInt(x) * 0x9e37_79b9_7f4a_7c15n + BigInt(z) * 0xc2b2_ae3d_27d4_eb4fn);
  return Number(mix(seed ^ packed) & 0xffffn) / 0xffff;
}

/** A deterministic global-coordinate height, independent of chunk generation order. */
export function terrainHeight(seed: bigint, globalX: number, globalZ: number): number {
  requireSeed(seed);
  if (!Number.isSafeInteger(globalX) || !Number.isSafeInteger(globalZ)) throw new RangeError("terrain coordinates must be safe integers");
  let rolling = 0;
  let weight = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const sampleWeight = dx === 0 && dz === 0 ? 4 : dx === 0 || dz === 0 ? 2 : 1;
      rolling += coordinateNoise(seed, globalX + dx, globalZ + dz) * sampleWeight;
      weight += sampleWeight;
    }
  }
  return 22 + Math.floor((rolling / weight) * 17);
}

export function generateTerrain(seed: bigint, coord: ChunkCoord): ChunkCandidate {
  requireSeed(seed);
  if (!Number.isSafeInteger(coord.x) || !Number.isSafeInteger(coord.z)) throw new RangeError("chunk coordinates must be safe integers");
  const blocks = new Uint16Array(CHUNK_VOLUME);
  for (let z = 0; z < CHUNK_SIZE; z++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      const height = terrainHeight(seed, coord.x * CHUNK_SIZE + x, coord.z * CHUNK_SIZE + z);
      for (let y = 0; y < 64; y++) {
        let block: BlockId = AIR;
        if (y === height) block = GRASS;
        else if (y < height && y >= height - 3) block = SOIL;
        else if (y < height - 3) block = STONE;
        else if (y <= WATER_LEVEL) block = WATER;
        blocks[voxelIndex({ x, y, z })] = block;
      }
    }
  }
  return new ChunkCandidate(coord, blocks);
}
