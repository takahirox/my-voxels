import { generateTerrain } from "../../terrain-generator/src/index.js";
import {
  DEFAULT_MATERIAL_PALETTE,
  LightVolume,
  bakeVertexLight,
  computeSunlight,
  type MaterialPalette,
} from "../../voxel-lighting/src/index.js";
import { meshGreedy, type MeshInput, type VoxelMesh } from "../../voxel-mesher/src/index.js";
import {
  ChunkSnapshot,
  type ChunkCoord,
  type ChunkRevision,
  type ChunkRevisionRef,
  type HaloEntry,
  type HorizontalHalo,
} from "../../voxel-storage/src/index.js";
import type {
  BrowserWorkerRequest,
  BrowserWorkerResponse,
  StructuredCloneValue,
  WorkerMessageEvent,
} from "./browser.js";

export interface ChunkCoordWire {
  readonly x: number;
  readonly z: number;
}

export interface ChunkRevisionRefWire {
  readonly coord: ChunkCoordWire;
  readonly revision: string;
}

export interface ChunkSnapshotWire {
  readonly coord: ChunkCoordWire;
  readonly revision: string;
  readonly blocks: Uint16Array;
}

export type HaloEntryWire =
  | Readonly<{ status: "available"; chunk: ChunkSnapshotWire }>
  | Readonly<{ status: "unavailable"; coord: ChunkCoordWire }>;

export interface HorizontalHaloWire {
  readonly west: HaloEntryWire;
  readonly east: HaloEntryWire;
  readonly north: HaloEntryWire;
  readonly south: HaloEntryWire;
}

export interface MeshInputWire {
  readonly snapshot: ChunkSnapshotWire;
  readonly halo: HorizontalHaloWire;
  readonly revisions: readonly ChunkRevisionRefWire[];
}

export interface VoxelMeshWire {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly blockIds: Uint16Array;
  readonly ao: Uint8Array;
  readonly light: Uint8Array;
  readonly colors: Uint8Array;
  readonly bounds: Readonly<{
    min: readonly [number, number, number];
    max: readonly [number, number, number];
  }>;
  readonly quadCount: number;
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly exposedSurfaceArea: number;
  readonly revisions: readonly ChunkRevisionRefWire[];
}

export interface LightVolumeWire {
  readonly data: Uint8Array;
  readonly revisions: readonly ChunkRevisionRefWire[];
}

export interface TerrainJobInputWire {
  readonly seed: string;
  readonly coord: ChunkCoordWire;
}

export interface MeshJobInputWire {
  readonly meshInput: MeshInputWire;
}

export interface LightingJobInputWire {
  readonly meshInput: MeshInputWire;
}

export interface BakeJobInputWire {
  readonly mesh: VoxelMeshWire;
  readonly volume: LightVolumeWire;
  readonly palette?: MaterialPalette;
}

export interface TerrainResultWire {
  readonly coord: ChunkCoordWire;
  readonly blocks: Uint16Array;
}

export type BakedVertexLightWire = Readonly<{
  status: "baked";
  light: Uint8Array;
  colors: Uint8Array;
  vertexCount: number;
  revisions: readonly ChunkRevisionRefWire[];
}>;

export type ObsoleteVertexLightWire = Readonly<{
  status: "obsolete";
  reason: "revision-mismatch";
}>;

export type BakeVertexLightResultWire = BakedVertexLightWire | ObsoleteVertexLightWire;

function coordFromWire(coord: ChunkCoordWire): ChunkCoord {
  return { x: coord.x, z: coord.z };
}

function revisionFromWire(revision: string): ChunkRevision {
  return BigInt(revision) as ChunkRevision;
}

function revisionRefFromWire(value: ChunkRevisionRefWire): ChunkRevisionRef {
  return { coord: coordFromWire(value.coord), revision: revisionFromWire(value.revision) };
}

function revisionRefToWire(value: ChunkRevisionRef): ChunkRevisionRefWire {
  return { coord: { x: value.coord.x, z: value.coord.z }, revision: value.revision.toString() };
}

function snapshotFromWire(value: ChunkSnapshotWire): ChunkSnapshot {
  return new ChunkSnapshot(
    coordFromWire(value.coord),
    revisionFromWire(value.revision),
    value.blocks,
  );
}

function haloEntryFromWire(value: HaloEntryWire): HaloEntry {
  return value.status === "available"
    ? { status: "available", chunk: snapshotFromWire(value.chunk) }
    : { status: "unavailable", coord: coordFromWire(value.coord) };
}

function haloFromWire(value: HorizontalHaloWire): HorizontalHalo {
  return {
    west: haloEntryFromWire(value.west),
    east: haloEntryFromWire(value.east),
    north: haloEntryFromWire(value.north),
    south: haloEntryFromWire(value.south),
  };
}

function meshInputFromWire(value: MeshInputWire): MeshInput {
  return {
    snapshot: snapshotFromWire(value.snapshot),
    halo: haloFromWire(value.halo),
    revisions: value.revisions.map(revisionRefFromWire),
  };
}

function meshFromWire(value: VoxelMeshWire): VoxelMesh {
  return {
    ...value,
    revisions: value.revisions.map(revisionRefFromWire),
  };
}

function meshToWire(value: VoxelMesh): VoxelMeshWire {
  return {
    ...value,
    bounds: { min: value.bounds.min, max: value.bounds.max },
    revisions: value.revisions.map(revisionRefToWire),
  };
}

function lightFromWire(value: LightVolumeWire): LightVolume {
  return new LightVolume(value.data, value.revisions.map(revisionRefFromWire));
}

function lightToWire(value: LightVolume): LightVolumeWire {
  return { data: value.data, revisions: value.revisions.map(revisionRefToWire) };
}

function requireRecord(value: StructuredCloneValue): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("voxel worker input must be an object");
  }
  return value as Record<string, unknown>;
}

export function dispatchVoxelWorkerRequest(request: BrowserWorkerRequest): StructuredCloneValue {
  const input = requireRecord(request.input);
  switch (request.type) {
    case "terrain": {
      const wire = input as unknown as TerrainJobInputWire;
      const candidate = generateTerrain(BigInt(wire.seed), coordFromWire(wire.coord));
      const result: TerrainResultWire = {
        coord: { x: candidate.coord.x, z: candidate.coord.z },
        blocks: candidate.blocks,
      };
      return result;
    }
    case "mesh": {
      const wire = input as unknown as MeshJobInputWire;
      return meshToWire(meshGreedy(meshInputFromWire(wire.meshInput)));
    }
    case "lighting": {
      const wire = input as unknown as LightingJobInputWire;
      return lightToWire(computeSunlight(meshInputFromWire(wire.meshInput)));
    }
    case "bake": {
      const wire = input as unknown as BakeJobInputWire;
      const result = bakeVertexLight(
        meshFromWire(wire.mesh),
        lightFromWire(wire.volume),
        wire.palette ?? DEFAULT_MATERIAL_PALETTE,
      );
      if (result.status === "obsolete") {
        const obsolete: ObsoleteVertexLightWire = {
          status: "obsolete",
          reason: "revision-mismatch",
        };
        return obsolete;
      }
      const baked: BakedVertexLightWire = {
        status: "baked",
        light: result.light,
        colors: result.colors,
        vertexCount: result.vertexCount,
        revisions: result.revisions.map(revisionRefToWire),
      };
      return baked;
    }
  }
}

interface WorkerEntryScope {
  postMessage(message: BrowserWorkerResponse, transfer?: readonly ArrayBuffer[]): void;
  addEventListener(type: "message", listener: (event: WorkerMessageEvent) => void): void;
}

function errorWire(error: unknown): Readonly<{ message: string; name?: string }> {
  if (error instanceof Error) return { message: error.message, name: error.name };
  return { message: String(error) };
}

export function installVoxelWorkerEntry(scope: WorkerEntryScope): void {
  scope.addEventListener("message", (event) => {
    const request = event.data as BrowserWorkerRequest;
    try {
      const result = dispatchVoxelWorkerRequest(request);
      const response: BrowserWorkerResponse = { id: request.id, ok: true, result };
      const transfer = ((): readonly ArrayBuffer[] => {
        const buffers = new Set<ArrayBuffer>();
        const visit = (value: unknown): void => {
          if (value === null || typeof value !== "object") return;
          if (value instanceof ArrayBuffer) buffers.add(value);
          else if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) buffers.add(value.buffer);
          else for (const child of Object.values(value)) visit(child);
        };
        visit(result);
        return [...buffers];
      })();
      scope.postMessage(response, transfer);
    } catch (error) {
      scope.postMessage({ id: request.id, ok: false, error: errorWire(error) });
    }
  });
}

const workerScope = globalThis as Partial<WorkerEntryScope>;
if (
  typeof document === "undefined" &&
  typeof workerScope.postMessage === "function" &&
  typeof workerScope.addEventListener === "function"
) {
  installVoxelWorkerEntry(workerScope as WorkerEntryScope);
}
