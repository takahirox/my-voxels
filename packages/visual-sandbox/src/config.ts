import type { MeshInputWire } from "../../voxel-jobs/src/worker-entry.js";
import {
  AIR, CHUNK_SIZE, CHUNK_VOLUME, GRASS, SOIL, STONE, WATER,
  WORLD_HEIGHT, voxelIndex, type ChunkCoord,
} from "../../voxel-storage/src/index.js";

export const DEFAULT_SEED = 1234n;
export const DEFAULT_CAMERA = "benchmark-1";

export interface SandboxConfig {
  readonly seed: bigint;
  readonly camera: typeof DEFAULT_CAMERA;
  readonly executor: "worker" | "inline";
}

export function parseSandboxConfig(search: string): SandboxConfig {
  const params = new URLSearchParams(search);
  const rawSeed = params.get("seed");
  let seed = DEFAULT_SEED;
  if (rawSeed !== null) {
    if (!/^(0|[1-9][0-9]{0,19})$/.test(rawSeed)) throw new Error("seed must be an unsigned 64-bit integer");
    seed = BigInt(rawSeed);
    if (seed > 0xffff_ffff_ffff_ffffn) throw new Error("seed must be an unsigned 64-bit integer");
  }
  const camera = params.get("camera") ?? DEFAULT_CAMERA;
  if (camera !== DEFAULT_CAMERA) throw new Error(`unknown camera preset: ${camera}`);
  const executor = params.get("executor");
  if (executor !== null && executor !== "inline") throw new Error(`unknown executor: ${executor}`);
  return Object.freeze({ seed, camera: DEFAULT_CAMERA, executor: executor === "inline" ? "inline" : "worker" });
}

export function deterministicChunks(): readonly ChunkCoord[] {
  const result: ChunkCoord[] = [];
  for (let z = -2; z < 2; z++) for (let x = -2; x < 2; x++) result.push(Object.freeze({ x, z }));
  return Object.freeze(result);
}

export function chunkKey(coord: ChunkCoord): string {
  return `${coord.x},${coord.z}`;
}

export function cloneMeshInputWire(source: MeshInputWire): MeshInputWire {
  const coord = (value: { readonly x: number; readonly z: number }): { x: number; z: number } => ({ x: value.x, z: value.z });
  const snapshot = (value: MeshInputWire["snapshot"]): MeshInputWire["snapshot"] => ({
    coord: coord(value.coord), revision: value.revision, blocks: value.blocks.slice(),
  });
  const entry = (value: MeshInputWire["halo"]["west"]): MeshInputWire["halo"]["west"] => value.status === "available"
    ? { status: "available", chunk: snapshot(value.chunk) }
    : { status: "unavailable", coord: coord(value.coord) };
  return {
    snapshot: snapshot(source.snapshot),
    halo: {
      west: entry(source.halo.west), east: entry(source.halo.east),
      north: entry(source.halo.north), south: entry(source.halo.south),
    },
    revisions: source.revisions.map((item) => ({ coord: coord(item.coord), revision: item.revision })),
  };
}

export function distanceFromCamera(coord: ChunkCoord): number {
  const centerX = coord.x * 16 + 8;
  const centerZ = coord.z * 16 + 8;
  return Math.hypot(centerX - 54, centerZ - 66);
}

const EDGE_FADE_START = 22;
const EDGE_FADE_END = 31;
const EDGE_SKIRT_HEIGHT = 18;
const WATER_FADE_THRESHOLD = 0.78;

function smoothEdgeFactor(worldX: number, worldZ: number): number {
  const radius = Math.hypot(worldX + 0.5, worldZ + 0.5);
  const linear = Math.max(0, Math.min(1, (EDGE_FADE_END - radius) / (EDGE_FADE_END - EDGE_FADE_START)));
  return linear * linear * (3 - 2 * linear);
}

/** Shapes the finite 4x4 demo into a rounded island without changing the generic terrain generator. */
export function applySandboxEdgeTreatment(coord: ChunkCoord, source: Uint16Array): Uint16Array {
  if (source.length !== CHUNK_VOLUME) throw new RangeError(`chunk must contain ${CHUNK_VOLUME} blocks`);
  const result = source.slice();
  for (let z = 0; z < CHUNK_SIZE; z++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      const factor = smoothEdgeFactor(coord.x * CHUNK_SIZE + x, coord.z * CHUNK_SIZE + z);
      if (factor === 1) continue;

      let originalGround = -1;
      for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
        const block = source[voxelIndex({ x, y, z })];
        if (block !== AIR && block !== WATER) {
          originalGround = y;
          break;
        }
      }
      const ground = factor === 0 || originalGround < 0
        ? -1
        : Math.floor(EDGE_SKIRT_HEIGHT + (originalGround - EDGE_SKIRT_HEIGHT) * factor);
      const base = ground < 0 ? -1 : Math.floor(EDGE_SKIRT_HEIGHT * (1 - factor));
      for (let y = 0; y < WORLD_HEIGHT; y++) {
        let block = AIR;
        if (y >= base) {
          if (y < ground - 3) block = STONE;
          else if (y < ground) block = SOIL;
          else if (y === ground) block = GRASS;
          else if (factor >= WATER_FADE_THRESHOLD && y <= 30) block = WATER;
        }
        result[voxelIndex({ x, y, z })] = block;
      }
    }
  }
  return result;
}
