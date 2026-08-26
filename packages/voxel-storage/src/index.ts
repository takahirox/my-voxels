declare const blockIdBrand: unique symbol;
declare const chunkRevisionBrand: unique symbol;

export type BlockId = number & { readonly [blockIdBrand]: "BlockId" };
export type ChunkRevision = bigint & { readonly [chunkRevisionBrand]: "ChunkRevision" };

export const AIR = 0 as BlockId;
export const GRASS = 1 as BlockId;
export const SOIL = 2 as BlockId;
export const STONE = 3 as BlockId;
export const WATER = 4 as BlockId;

export const CHUNK_SIZE = 16;
export const SECTION_HEIGHT = 16;
export const WORLD_HEIGHT = 64;
export const SECTION_COUNT = WORLD_HEIGHT / SECTION_HEIGHT;
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT;

export interface ChunkCoord {
  readonly x: number;
  readonly z: number;
}

export interface LocalVoxelCoord {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface WorldVoxelCoord {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ChunkRevisionRef {
  readonly coord: ChunkCoord;
  readonly revision: ChunkRevision;
}

export type ChunkState = "ready" | "unloaded";

const coordKey = (coord: ChunkCoord): string => `${coord.x},${coord.z}`;
const frozenCoord = (coord: ChunkCoord): ChunkCoord => Object.freeze({ x: coord.x, z: coord.z });

function requireSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be a safe integer`);
}

export function blockId(value: number): BlockId {
  if (!Number.isInteger(value) || value < AIR || value > WATER) throw new RangeError("invalid block id");
  return value as BlockId;
}

export function validateChunkCoord(coord: ChunkCoord): void {
  requireSafeInteger(coord.x, "chunk x");
  requireSafeInteger(coord.z, "chunk z");
}

export function worldToChunk(position: WorldVoxelCoord): { readonly chunk: ChunkCoord; readonly local: LocalVoxelCoord } {
  requireSafeInteger(position.x, "world x");
  requireSafeInteger(position.y, "world y");
  requireSafeInteger(position.z, "world z");
  if (position.y < 0 || position.y >= WORLD_HEIGHT) throw new RangeError("world y is outside [0, 64)");
  const chunkX = Math.floor(position.x / CHUNK_SIZE);
  const chunkZ = Math.floor(position.z / CHUNK_SIZE);
  return Object.freeze({
    chunk: frozenCoord({ x: chunkX, z: chunkZ }),
    local: Object.freeze({
      x: position.x - chunkX * CHUNK_SIZE,
      y: position.y,
      z: position.z - chunkZ * CHUNK_SIZE,
    }),
  });
}

export function voxelIndex(local: LocalVoxelCoord): number {
  requireSafeInteger(local.x, "local x");
  requireSafeInteger(local.y, "local y");
  requireSafeInteger(local.z, "local z");
  if (local.x < 0 || local.x >= CHUNK_SIZE || local.z < 0 || local.z >= CHUNK_SIZE || local.y < 0 || local.y >= WORLD_HEIGHT) {
    throw new RangeError("local voxel coordinate is out of bounds");
  }
  return local.x + local.z * CHUNK_SIZE + local.y * CHUNK_SIZE * CHUNK_SIZE;
}

function copyAndValidateBlocks(blocks: Uint16Array): Uint16Array {
  if (blocks.length !== CHUNK_VOLUME) throw new RangeError(`chunk must contain ${CHUNK_VOLUME} blocks`);
  const copy = blocks.slice();
  for (const value of copy) blockId(value);
  return copy;
}

export class ChunkCandidate {
  readonly #blocks: Uint16Array;
  public readonly coord: ChunkCoord;

  public constructor(coord: ChunkCoord, blocks: Uint16Array) {
    validateChunkCoord(coord);
    this.coord = frozenCoord(coord);
    this.#blocks = copyAndValidateBlocks(blocks);
    Object.freeze(this);
  }

  public get blocks(): Uint16Array {
    return this.#blocks.slice();
  }
}

export class ChunkSnapshot {
  readonly #blocks: Uint16Array;
  public readonly coord: ChunkCoord;
  public readonly revision: ChunkRevision;

  public constructor(coord: ChunkCoord, revision: ChunkRevision, blocks: Uint16Array) {
    this.coord = frozenCoord(coord);
    this.revision = revision;
    this.#blocks = blocks.slice();
    Object.freeze(this);
  }

  public get blocks(): Uint16Array {
    return this.#blocks.slice();
  }

  public get(local: LocalVoxelCoord): BlockId {
    return this.#blocks[voxelIndex(local)] as BlockId;
  }
}

export type HaloEntry =
  | { readonly status: "available"; readonly chunk: ChunkSnapshot }
  | { readonly status: "unavailable"; readonly coord: ChunkCoord };

export interface HorizontalHalo {
  readonly west: HaloEntry;
  readonly east: HaloEntry;
  readonly north: HaloEntry;
  readonly south: HaloEntry;
}

interface StoredChunk {
  readonly revision: ChunkRevision;
  readonly blocks: Uint16Array;
}

export type ChunkCommitResult =
  | { readonly status: "committed"; readonly snapshot: ChunkSnapshot }
  | { readonly status: "stale" };

export class VoxelStorage {
  readonly #chunks = new Map<string, StoredChunk>();
  readonly #lastRevision = new Map<string, bigint>();

  public state(coord: ChunkCoord): ChunkState {
    validateChunkCoord(coord);
    return this.#chunks.has(coordKey(coord)) ? "ready" : "unloaded";
  }

  public snapshot(coord: ChunkCoord): ChunkSnapshot | undefined {
    validateChunkCoord(coord);
    const stored = this.#chunks.get(coordKey(coord));
    return stored === undefined ? undefined : new ChunkSnapshot(coord, stored.revision, stored.blocks);
  }

  public get(position: WorldVoxelCoord): BlockId | undefined {
    const converted = worldToChunk(position);
    return this.snapshot(converted.chunk)?.get(converted.local);
  }

  public revisionsMatch(expected: readonly ChunkRevisionRef[]): boolean {
    const seen = new Set<string>();
    for (const item of expected) {
      validateChunkCoord(item.coord);
      const key = coordKey(item.coord);
      if (seen.has(key)) return false;
      seen.add(key);
      const current = this.#chunks.get(key);
      if (current === undefined || current.revision !== item.revision) return false;
    }
    return true;
  }

  public commit(candidate: ChunkCandidate, expected: readonly ChunkRevisionRef[] = []): ChunkCommitResult {
    if (!this.revisionsMatch(expected)) return Object.freeze({ status: "stale" });
    const key = coordKey(candidate.coord);
    const revision = ((this.#lastRevision.get(key) ?? 0n) + 1n) as ChunkRevision;
    const blocks = candidate.blocks;
    this.#chunks.set(key, { revision, blocks });
    this.#lastRevision.set(key, revision);
    return Object.freeze({ status: "committed", snapshot: new ChunkSnapshot(candidate.coord, revision, blocks) });
  }

  public unload(coord: ChunkCoord): void {
    validateChunkCoord(coord);
    this.#chunks.delete(coordKey(coord));
  }

  public horizontalHalo(coord: ChunkCoord): HorizontalHalo {
    validateChunkCoord(coord);
    const entry = (neighbor: ChunkCoord): HaloEntry => {
      const snapshot = this.snapshot(neighbor);
      return snapshot === undefined
        ? Object.freeze({ status: "unavailable", coord: frozenCoord(neighbor) })
        : Object.freeze({ status: "available", chunk: snapshot });
    };
    return Object.freeze({
      west: entry({ x: coord.x - 1, z: coord.z }),
      east: entry({ x: coord.x + 1, z: coord.z }),
      north: entry({ x: coord.x, z: coord.z - 1 }),
      south: entry({ x: coord.x, z: coord.z + 1 }),
    });
  }
}
