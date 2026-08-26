import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Camera,
  DoubleSide,
  Frustum,
  Group,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Object3D,
  Sphere,
  Vector3,
} from "three";

import { type VoxelMesh } from "../../voxel-mesher/src/index.js";
import { CHUNK_SIZE, WATER, type ChunkCoord } from "../../voxel-storage/src/index.js";

export interface BakedVertexColors {
  readonly colors: Uint8Array;
}

export interface ChunkRenderMetadata {
  readonly coord: ChunkCoord;
  readonly revision: bigint | undefined;
  readonly quadCount: number;
  readonly triangleCount: number;
  readonly vertexCount: number;
}

export interface ChunkRenderStats {
  readonly loaded: number;
  readonly visible: number;
  readonly culled: number;
  readonly triangles: number;
}

type OwnedChunk = Group & { userData: { chunk: ChunkRenderMetadata } };
type MaterialKind = "opaque" | "water";

const key = (coord: ChunkCoord): string => `${coord.x},${coord.z}`;

function validate(mesh: VoxelMesh, colors: Uint8Array): void {
  if (mesh.positions.length !== mesh.vertexCount * 3 || mesh.normals.length !== mesh.vertexCount * 3 ||
      mesh.blockIds.length !== mesh.vertexCount || colors.length !== mesh.vertexCount * 3 ||
      mesh.indices.length !== mesh.triangleCount * 3) {
    throw new RangeError("voxel mesh buffers do not match their declared counts");
  }
}

function selectedTriangles(mesh: VoxelMesh, kind: MaterialKind): number[] {
  const result: number[] = [];
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const a = mesh.indices[offset]!;
    const b = mesh.indices[offset + 1]!;
    const c = mesh.indices[offset + 2]!;
    if (a >= mesh.vertexCount || b >= mesh.vertexCount || c >= mesh.vertexCount) {
      throw new RangeError("voxel mesh index is outside the vertex buffer");
    }
    const block = mesh.blockIds[a]!;
    if (mesh.blockIds[b] !== block || mesh.blockIds[c] !== block) {
      throw new RangeError("a voxel triangle must use one block id");
    }
    if ((block === WATER ? "water" : "opaque") === kind) result.push(a, b, c);
  }
  return result;
}

function geometryFor(mesh: VoxelMesh, colors: Uint8Array, sourceIndices: readonly number[]): BufferGeometry {
  const positions = new Float32Array(sourceIndices.length * 3);
  const normals = new Float32Array(sourceIndices.length * 3);
  const vertexColors = new Uint8Array(sourceIndices.length * 3);
  const indices = new Uint32Array(sourceIndices.length);
  for (let target = 0; target < sourceIndices.length; target++) {
    const source = sourceIndices[target]!;
    const sourceOffset = source * 3;
    const targetOffset = target * 3;
    positions[targetOffset] = mesh.positions[sourceOffset]!;
    positions[targetOffset + 1] = mesh.positions[sourceOffset + 1]!;
    positions[targetOffset + 2] = mesh.positions[sourceOffset + 2]!;
    normals[targetOffset] = mesh.normals[sourceOffset]!;
    normals[targetOffset + 1] = mesh.normals[sourceOffset + 1]!;
    normals[targetOffset + 2] = mesh.normals[sourceOffset + 2]!;
    vertexColors[targetOffset] = colors[sourceOffset]!;
    vertexColors[targetOffset + 1] = colors[sourceOffset + 1]!;
    vertexColors[targetOffset + 2] = colors[sourceOffset + 2]!;
    indices[target] = target;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(normals, 3));
  geometry.setAttribute("color", new BufferAttribute(vertexColors, 3, true));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.boundingBox = new Box3(
    new Vector3(...mesh.bounds.min),
    new Vector3(...mesh.bounds.max),
  );
  geometry.boundingSphere = new Sphere();
  geometry.boundingBox.getBoundingSphere(geometry.boundingSphere);
  return geometry;
}

function materialFor(kind: MaterialKind): MeshLambertMaterial {
  return new MeshLambertMaterial(kind === "water"
    ? { vertexColors: true, transparent: true, opacity: 0.72, depthWrite: false, side: DoubleSide }
    : { vertexColors: true });
}

export function createChunkGroup(
  coord: ChunkCoord,
  mesh: VoxelMesh,
  baked: BakedVertexColors = mesh,
): Group {
  validate(mesh, baked.colors);
  const group = new Group() as OwnedChunk;
  group.name = `chunk:${key(coord)}`;
  group.position.set(coord.x * CHUNK_SIZE, 0, coord.z * CHUNK_SIZE);
  const revision = mesh.revisions.find((entry) => entry.coord.x === coord.x && entry.coord.z === coord.z)?.revision;
  group.userData.chunk = Object.freeze({
    coord: Object.freeze({ x: coord.x, z: coord.z }),
    revision,
    quadCount: mesh.quadCount,
    triangleCount: mesh.triangleCount,
    vertexCount: mesh.vertexCount,
  });
  for (const kind of ["opaque", "water"] as const) {
    const indices = selectedTriangles(mesh, kind);
    if (indices.length === 0) continue;
    const child = new Mesh(geometryFor(mesh, baked.colors, indices), materialFor(kind));
    child.name = kind;
    child.userData.triangleCount = indices.length / 3;
    group.add(child);
  }
  return group;
}

function ownedMeshes(root: Object3D): Mesh[] {
  const result: Mesh[] = [];
  root.traverse((object: Object3D) => {
    if (object instanceof Mesh) result.push(object);
  });
  return result;
}

function disposeChunk(chunk: Group): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<MeshLambertMaterial>();
  for (const mesh of ownedMeshes(chunk)) {
    geometries.add(mesh.geometry);
    const values = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of values) if (material instanceof MeshLambertMaterial) materials.add(material);
  }
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  chunk.clear();
}

export class ChunkRenderSink {
  readonly root = new Group();
  readonly #chunks = new Map<string, OwnedChunk>();
  #wireframe = false;
  #disposed = false;
  #stats: ChunkRenderStats = Object.freeze({ loaded: 0, visible: 0, culled: 0, triangles: 0 });

  public get size(): number { return this.#chunks.size; }
  public get stats(): ChunkRenderStats { return this.#stats; }

  public get(coord: ChunkCoord): Group | undefined {
    return this.#chunks.get(key(coord));
  }

  public upsert(coord: ChunkCoord, mesh: VoxelMesh, baked: BakedVertexColors = mesh): Group {
    if (this.#disposed) throw new Error("chunk render sink is disposed");
    const replacement = createChunkGroup(coord, mesh, baked) as OwnedChunk;
    this.applyWireframe(replacement);
    const previous = this.#chunks.get(key(coord));
    if (previous !== undefined) {
      this.root.remove(previous);
      disposeChunk(previous);
    }
    this.#chunks.set(key(coord), replacement);
    this.root.add(replacement);
    this.refreshStats();
    return replacement;
  }

  public unload(coord: ChunkCoord): boolean {
    const chunk = this.#chunks.get(key(coord));
    if (chunk === undefined) return false;
    this.#chunks.delete(key(coord));
    this.root.remove(chunk);
    disposeChunk(chunk);
    this.refreshStats();
    return true;
  }

  public setWireframe(enabled: boolean): void {
    this.#wireframe = enabled;
    for (const chunk of this.#chunks.values()) this.applyWireframe(chunk);
  }

  public updateVisibility(camera: Camera): ChunkRenderStats {
    camera.updateMatrixWorld();
    this.root.updateMatrixWorld(true);
    const projection = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const frustum = new Frustum().setFromProjectionMatrix(projection);
    for (const chunk of this.#chunks.values()) {
      chunk.visible = ownedMeshes(chunk).some((mesh) => frustum.intersectsObject(mesh));
    }
    return this.refreshStats();
  }

  public dispose(): void {
    if (this.#disposed) return;
    for (const chunk of this.#chunks.values()) disposeChunk(chunk);
    this.#chunks.clear();
    this.root.clear();
    this.#disposed = true;
    this.refreshStats();
  }

  private applyWireframe(chunk: Group): void {
    for (const mesh of ownedMeshes(chunk)) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (material instanceof MeshLambertMaterial) material.wireframe = this.#wireframe;
      }
    }
  }

  private refreshStats(): ChunkRenderStats {
    let visible = 0;
    let triangles = 0;
    for (const chunk of this.#chunks.values()) {
      if (chunk.visible) visible++;
      for (const mesh of ownedMeshes(chunk)) triangles += mesh.userData.triangleCount as number;
    }
    this.#stats = Object.freeze({ loaded: this.#chunks.size, visible, culled: this.#chunks.size - visible, triangles });
    return this.#stats;
  }
}
