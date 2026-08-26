import {
  AIR,
  CHUNK_SIZE,
  WATER,
  WORLD_HEIGHT,
  type BlockId,
  type ChunkRevisionRef,
  type ChunkSnapshot,
  type HorizontalHalo,
} from "../../voxel-storage/src/index.js";

export type FaceDirection = "west" | "east" | "down" | "up" | "north" | "south";
export type MaterialClass = "opaque" | "water";

export interface MeshInput {
  readonly snapshot: ChunkSnapshot;
  readonly halo: HorizontalHalo;
  readonly revisions: readonly ChunkRevisionRef[];
}

export interface MeshBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface VoxelMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly blockIds: Uint16Array;
  readonly ao: Uint8Array;
  readonly light: Uint8Array;
  readonly colors: Uint8Array;
  readonly bounds: MeshBounds;
  readonly quadCount: number;
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly exposedSurfaceArea: number;
  readonly revisions: readonly ChunkRevisionRef[];
}

interface DirectionSpec {
  readonly name: FaceDirection;
  readonly normal: readonly [number, number, number];
  readonly u: readonly [number, number, number];
  readonly v: readonly [number, number, number];
}

const DIRECTIONS: readonly DirectionSpec[] = [
  { name: "west", normal: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { name: "east", normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { name: "down", normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { name: "up", normal: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] },
  { name: "north", normal: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0] },
  { name: "south", normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
] as const;

const key = (coord: { readonly x: number; readonly z: number }): string => `${coord.x},${coord.z}`;
const ref = (chunk: ChunkSnapshot): ChunkRevisionRef => Object.freeze({
  coord: Object.freeze({ x: chunk.coord.x, z: chunk.coord.z }),
  revision: chunk.revision,
});

export function createMeshInput(snapshot: ChunkSnapshot, halo: HorizontalHalo): MeshInput {
  const expected = {
    west: { x: snapshot.coord.x - 1, z: snapshot.coord.z },
    east: { x: snapshot.coord.x + 1, z: snapshot.coord.z },
    north: { x: snapshot.coord.x, z: snapshot.coord.z - 1 },
    south: { x: snapshot.coord.x, z: snapshot.coord.z + 1 },
  } as const;
  const revisions: ChunkRevisionRef[] = [ref(snapshot)];
  for (const name of ["west", "east", "north", "south"] as const) {
    const entry = halo[name];
    const coord = entry.status === "available" ? entry.chunk.coord : entry.coord;
    if (coord.x !== expected[name].x || coord.z !== expected[name].z) {
      throw new RangeError(`${name} halo is not adjacent to the mesh chunk`);
    }
    if (entry.status === "available") revisions.push(ref(entry.chunk));
  }
  const seen = new Set<string>();
  for (const item of revisions) {
    if (seen.has(key(item.coord))) throw new RangeError("duplicate mesh revision input");
    seen.add(key(item.coord));
  }
  return Object.freeze({ snapshot, halo, revisions: Object.freeze(revisions) });
}

function material(block: BlockId): MaterialClass {
  return block === WATER ? "water" : "opaque";
}

function sample(input: MeshInput, x: number, y: number, z: number): BlockId | undefined {
  if (y < 0 || y >= WORLD_HEIGHT) return undefined;
  if (x >= 0 && x < CHUNK_SIZE && z >= 0 && z < CHUNK_SIZE) {
    return input.snapshot.get({ x, y, z });
  }
  let entry;
  let localX = x;
  let localZ = z;
  if (x < 0 && z >= 0 && z < CHUNK_SIZE) {
    entry = input.halo.west;
    localX += CHUNK_SIZE;
  } else if (x >= CHUNK_SIZE && z >= 0 && z < CHUNK_SIZE) {
    entry = input.halo.east;
    localX -= CHUNK_SIZE;
  } else if (z < 0 && x >= 0 && x < CHUNK_SIZE) {
    entry = input.halo.north;
    localZ += CHUNK_SIZE;
  } else if (z >= CHUNK_SIZE && x >= 0 && x < CHUNK_SIZE) {
    entry = input.halo.south;
    localZ -= CHUNK_SIZE;
  } else {
    return undefined;
  }
  return entry.status === "available" ? entry.chunk.get({ x: localX, y, z: localZ }) : undefined;
}

function exposed(block: BlockId, neighbor: BlockId | undefined): boolean {
  if (neighbor === undefined) return false;
  return neighbor === AIR || (neighbor !== block && material(neighbor) !== material(block));
}

function occupied(input: MeshInput, x: number, y: number, z: number): boolean {
  const value = sample(input, x, y, z);
  return value === undefined || value !== AIR;
}

function cornerAo(input: MeshInput, x: number, y: number, z: number, direction: DirectionSpec): readonly [number, number, number, number] {
  const result: number[] = [];
  for (const [su, sv] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
    const us = su === 0 ? -1 : 1;
    const vs = sv === 0 ? -1 : 1;
    const ox = x + direction.normal[0];
    const oy = y + direction.normal[1];
    const oz = z + direction.normal[2];
    const side1 = occupied(input, ox + direction.u[0] * us, oy + direction.u[1] * us, oz + direction.u[2] * us);
    const side2 = occupied(input, ox + direction.v[0] * vs, oy + direction.v[1] * vs, oz + direction.v[2] * vs);
    const diagonal = occupied(input,
      ox + direction.u[0] * us + direction.v[0] * vs,
      oy + direction.u[1] * us + direction.v[1] * vs,
      oz + direction.u[2] * us + direction.v[2] * vs);
    result.push(side1 && side2 ? 3 : Number(side1) + Number(side2) + Number(diagonal));
  }
  return result as unknown as readonly [number, number, number, number];
}

interface Face {
  readonly direction: DirectionSpec;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly block: BlockId;
  readonly ao: readonly [number, number, number, number];
  readonly width: number;
  readonly height: number;
}

function faceOrigin(face: Face): [number, number, number] {
  return [
    face.x + (face.direction.normal[0] > 0 ? 1 : 0),
    face.y + (face.direction.normal[1] > 0 ? 1 : 0),
    face.z + (face.direction.normal[2] > 0 ? 1 : 0),
  ];
}

function buildMesh(faces: readonly Face[], revisions: readonly ChunkRevisionRef[]): VoxelMesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const blockIds: number[] = [];
  const ao: number[] = [];
  let area = 0;
  for (const face of faces) {
    const base = positions.length / 3;
    const origin = faceOrigin(face);
    const corners = [[0, 0], [face.width, 0], [face.width, face.height], [0, face.height]] as const;
    for (let i = 0; i < 4; i++) {
      const corner = corners[i]!;
      positions.push(
        origin[0] + face.direction.u[0] * corner[0] + face.direction.v[0] * corner[1],
        origin[1] + face.direction.u[1] * corner[0] + face.direction.v[1] * corner[1],
        origin[2] + face.direction.u[2] * corner[0] + face.direction.v[2] * corner[1],
      );
      normals.push(...face.direction.normal);
      blockIds.push(face.block);
      ao.push(face.ao[i]!);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    area += face.width * face.height;
  }
  const vertexCount = positions.length / 3;
  return Object.freeze({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    blockIds: new Uint16Array(blockIds),
    ao: new Uint8Array(ao),
    light: new Uint8Array(vertexCount),
    colors: new Uint8Array(vertexCount * 3),
    bounds: Object.freeze({ min: [0, 0, 0] as const, max: [CHUNK_SIZE, WORLD_HEIGHT, CHUNK_SIZE] as const }),
    quadCount: faces.length,
    triangleCount: faces.length * 2,
    vertexCount,
    exposedSurfaceArea: area,
    revisions,
  });
}

function unitFaces(input: MeshInput): Face[] {
  const faces: Face[] = [];
  for (let y = 0; y < WORLD_HEIGHT; y++) for (let z = 0; z < CHUNK_SIZE; z++) for (let x = 0; x < CHUNK_SIZE; x++) {
    const block = sample(input, x, y, z)!;
    if (block === AIR) continue;
    for (const direction of DIRECTIONS) {
      const neighbor = sample(input, x + direction.normal[0], y + direction.normal[1], z + direction.normal[2]);
      if (exposed(block, neighbor)) faces.push({ direction, x, y, z, block, ao: cornerAo(input, x, y, z, direction), width: 1, height: 1 });
    }
  }
  return faces;
}

export function meshVisibleFaces(input: MeshInput): VoxelMesh {
  return buildMesh(unitFaces(input), input.revisions);
}

function planeCoordinates(face: Face): readonly [number, number, number] {
  const n = face.direction.normal;
  const layer = n[0] !== 0 ? face.x : n[1] !== 0 ? face.y : face.z;
  const u = face.direction.u;
  const v = face.direction.v;
  const a = u[0] !== 0 ? face.x : u[1] !== 0 ? face.y : face.z;
  const b = v[0] !== 0 ? face.x : v[1] !== 0 ? face.y : face.z;
  return [layer, a, b];
}

function signature(face: Face): string {
  return `${face.block}/${material(face.block)}/${face.direction.name}/${face.ao.join("")}`;
}

export function meshGreedy(input: MeshInput): VoxelMesh {
  const groups = new Map<string, Map<string, Face>>();
  for (const face of unitFaces(input)) {
    const [layer, a, b] = planeCoordinates(face);
    const groupKey = `${face.direction.name}/${layer}`;
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = new Map();
      groups.set(groupKey, group);
    }
    group.set(`${a},${b}`, face);
  }
  const merged: Face[] = [];
  for (const group of groups.values()) {
    const remaining = new Map(group);
    while (remaining.size > 0) {
      const firstEntry = remaining.entries().next().value as [string, Face];
      const [a, b] = firstEntry[0].split(",").map(Number) as [number, number];
      const first = firstEntry[1];
      const wanted = signature(first);
      let width = 1;
      while (signature(remaining.get(`${a + width},${b}`) ?? first) === wanted && remaining.has(`${a + width},${b}`)) width++;
      let height = 1;
      outer: while (true) {
        for (let du = 0; du < width; du++) {
          const candidate = remaining.get(`${a + du},${b + height}`);
          if (candidate === undefined || signature(candidate) !== wanted) break outer;
        }
        height++;
      }
      for (let dv = 0; dv < height; dv++) for (let du = 0; du < width; du++) remaining.delete(`${a + du},${b + dv}`);
      merged.push({ ...first, width, height });
    }
  }
  return buildMesh(merged, input.revisions);
}

export function revisionSetsEqual(a: readonly ChunkRevisionRef[], b: readonly ChunkRevisionRef[]): boolean {
  if (a.length !== b.length) return false;
  const expected = new Map(a.map((item) => [key(item.coord), item.revision]));
  return b.every((item) => expected.get(key(item.coord)) === item.revision);
}
