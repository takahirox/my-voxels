import {
  AIR,
  CHUNK_SIZE,
  CHUNK_VOLUME,
  WATER,
  WORLD_HEIGHT,
  voxelIndex,
  type BlockId,
  type ChunkRevisionRef,
} from "../../voxel-storage/src/index.js";
import {
  revisionSetsEqual,
  type MeshInput,
  type VoxelMesh,
} from "../../voxel-mesher/src/index.js";

export class LightVolume {
  readonly #sunlight: Uint8Array;
  public readonly revisions: readonly ChunkRevisionRef[];

  public constructor(sunlight: Uint8Array, revisions: readonly ChunkRevisionRef[]) {
    if (sunlight.length !== CHUNK_VOLUME) throw new RangeError(`light volume must contain ${CHUNK_VOLUME} samples`);
    if (sunlight.some((value) => value > 15)) throw new RangeError("sunlight must be in [0, 15]");
    this.#sunlight = sunlight.slice();
    this.revisions = Object.freeze(revisions.map((item) => Object.freeze({
      coord: Object.freeze({ x: item.coord.x, z: item.coord.z }), revision: item.revision,
    })));
    Object.freeze(this);
  }

  public get(x: number, y: number, z: number): number {
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) ||
      x < 0 || x >= CHUNK_SIZE || y < 0 || y >= WORLD_HEIGHT || z < 0 || z >= CHUNK_SIZE) {
      return 0;
    }
    return this.#sunlight[voxelIndex({ x, y, z })]!;
  }

  public get data(): Uint8Array {
    return this.#sunlight.slice();
  }
}

export function computeSunlight(input: MeshInput): LightVolume {
  const light = new Uint8Array(CHUNK_VOLUME);
  for (let z = 0; z < CHUNK_SIZE; z++) for (let x = 0; x < CHUNK_SIZE; x++) {
    let level = 15;
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      const block = input.snapshot.get({ x, y, z });
      if (block === AIR) {
        light[voxelIndex({ x, y, z })] = level;
      } else if (block === WATER) {
        level = Math.max(1, level - 1);
        light[voxelIndex({ x, y, z })] = level;
      } else {
        level = 0;
      }
    }
  }
  return new LightVolume(light, input.revisions);
}

export interface MaterialColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export type MaterialPalette = Readonly<Record<number, MaterialColor>>;

export const DEFAULT_MATERIAL_PALETTE: MaterialPalette = Object.freeze({
  1: Object.freeze({ r: 95, g: 175, b: 75 }),
  2: Object.freeze({ r: 130, g: 92, b: 58 }),
  3: Object.freeze({ r: 145, g: 145, b: 150 }),
  4: Object.freeze({ r: 70, g: 135, b: 220 }),
});

export interface BakedVertexLight {
  readonly status: "baked";
  readonly light: Uint8Array;
  readonly colors: Uint8Array;
  readonly vertexCount: number;
  readonly revisions: readonly ChunkRevisionRef[];
}

export interface ObsoleteVertexLight {
  readonly status: "obsolete";
  readonly reason: "revision-mismatch";
}

export type BakeVertexLightResult = BakedVertexLight | ObsoleteVertexLight;

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function requireColor(color: MaterialColor | undefined, block: BlockId): MaterialColor {
  if (color === undefined) throw new RangeError(`palette has no color for block ${block}`);
  for (const channel of [color.r, color.g, color.b]) {
    if (!Number.isFinite(channel) || channel < 0 || channel > 255) throw new RangeError("palette channels must be in [0, 255]");
  }
  return color;
}

export function bakeVertexLight(
  mesh: VoxelMesh,
  volume: LightVolume,
  palette: MaterialPalette = DEFAULT_MATERIAL_PALETTE,
): BakeVertexLightResult {
  if (!revisionSetsEqual(mesh.revisions, volume.revisions)) {
    return Object.freeze({ status: "obsolete", reason: "revision-mismatch" });
  }
  const light = new Uint8Array(mesh.vertexCount);
  const colors = new Uint8Array(mesh.vertexCount * 3);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const offset = vertex * 3;
    const nx = mesh.normals[offset]!;
    const ny = mesh.normals[offset + 1]!;
    const nz = mesh.normals[offset + 2]!;
    const x = Math.floor(mesh.positions[offset]! + nx * 0.01);
    const y = Math.floor(mesh.positions[offset + 1]! + ny * 0.01);
    const z = Math.floor(mesh.positions[offset + 2]! + nz * 0.01);
    const sunlight = volume.get(x, y, z);
    light[vertex] = sunlight;
    const directionShade = ny > 0 ? 1 : ny < 0 ? 0.55 : nx !== 0 ? 0.8 : 0.7;
    const aoShade = 1 - mesh.ao[vertex]! * 0.16;
    const skyLight = 0.28 + sunlight / 15 * 0.72;
    const illumination = skyLight * directionShade * aoShade;
    const color = requireColor(palette[mesh.blockIds[vertex]!], mesh.blockIds[vertex]! as BlockId);
    colors[offset] = clampByte(color.r * illumination);
    colors[offset + 1] = clampByte(color.g * illumination);
    colors[offset + 2] = clampByte(color.b * illumination);
  }
  return Object.freeze({ status: "baked", light, colors, vertexCount: mesh.vertexCount, revisions: volume.revisions });
}
