// @ts-expect-error Node types are supplied by the supported Node runtime.
import assert from "node:assert/strict";
// @ts-expect-error Node types are supplied by the supported Node runtime.
import test from "node:test";

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
} from "three";

import { ChunkRenderSink, createChunkGroup } from "./index.js";
import { type VoxelMesh } from "../../voxel-mesher/src/index.js";
import { STONE, WATER, type BlockId, type ChunkRevision } from "../../voxel-storage/src/index.js";

function fixture(): VoxelMesh {
  return Object.freeze({
    positions: new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
      0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
    ]),
    normals: new Float32Array([
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
      0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
    ]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
    blockIds: new Uint16Array([
      STONE, STONE, STONE, STONE, WATER, WATER, WATER, WATER,
    ] as readonly BlockId[]),
    ao: new Uint8Array(8),
    light: new Uint8Array(8),
    colors: new Uint8Array([
      255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0,
      0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255,
    ]),
    bounds: Object.freeze({ min: [0, 0, 0] as const, max: [1, 1, 1] as const }),
    quadCount: 2,
    triangleCount: 4,
    vertexCount: 8,
    exposedSurfaceArea: 2,
    revisions: Object.freeze([{ coord: Object.freeze({ x: 2, z: -3 }), revision: 7n as ChunkRevision }]),
  });
}

function child(
  group: ReturnType<typeof createChunkGroup>,
  name: string,
): Mesh<BufferGeometry, MeshLambertMaterial> {
  const value = group.getObjectByName(name);
  if (!(value instanceof Mesh) || Array.isArray(value.material) || !(value.material instanceof MeshLambertMaterial)) throw new Error(`missing Lambert mesh ${name}`);
  return value as Mesh<BufferGeometry, MeshLambertMaterial>;
}

test("conversion creates typed, bounded, independently owned geometry", () => {
  const source = fixture();
  const positions = source.positions.slice();
  const colors = source.colors.slice();
  const group = createChunkGroup({ x: 2, z: -3 }, source);
  assert.deepEqual(group.position.toArray(), [32, 0, -48]);
  assert.deepEqual(group.userData.chunk, {
    coord: { x: 2, z: -3 }, revision: 7n, quadCount: 2, triangleCount: 4, vertexCount: 8,
  });
  for (const name of ["opaque", "water"]) {
    const geometry = child(group, name).geometry;
    assert.ok(geometry.getAttribute("position") instanceof BufferAttribute);
    assert.ok(geometry.getAttribute("position").array instanceof Float32Array);
    assert.ok(geometry.getAttribute("normal").array instanceof Float32Array);
    assert.ok(geometry.getIndex()!.array instanceof Uint32Array);
    assert.ok(geometry.getAttribute("color").array instanceof Uint8Array);
    assert.equal(geometry.getAttribute("color").normalized, true);
    assert.ok(geometry.boundingBox);
    assert.ok(geometry.boundingSphere);
  }
  child(group, "opaque").geometry.getAttribute("position").setX(0, 99);
  assert.deepEqual(source.positions, positions);
  assert.deepEqual(source.colors, colors);
});

test("triangles are deterministically partitioned into Lambert materials", () => {
  const group = createChunkGroup({ x: 2, z: -3 }, fixture());
  const opaque = child(group, "opaque");
  const water = child(group, "water");
  assert.ok(opaque.material instanceof MeshLambertMaterial);
  assert.ok(water.material instanceof MeshLambertMaterial);
  assert.equal(opaque.geometry.getIndex()!.count, 6);
  assert.equal(water.geometry.getIndex()!.count, 6);
  assert.equal(opaque.material.transparent, false);
  assert.equal(water.material.transparent, true);
  assert.equal(water.material.side, DoubleSide);
  assert.equal(water.material.depthWrite, false);
});

test("sink replaces and unloads chunks while disposing each owned resource once", () => {
  const sink = new ChunkRenderSink();
  const first = sink.upsert({ x: 2, z: -3 }, fixture());
  const disposed = new Map<object, number>();
  first.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    for (const resource of [object.geometry, object.material]) {
      resource.addEventListener("dispose", () => disposed.set(resource, (disposed.get(resource) ?? 0) + 1));
    }
  });
  const replacement = sink.upsert({ x: 2, z: -3 }, fixture());
  assert.notEqual(replacement, first);
  assert.equal(sink.size, 1);
  assert.deepEqual([...disposed.values()], [1, 1, 1, 1]);

  const replacementDisposed = new Map<object, number>();
  replacement.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    for (const resource of [object.geometry, object.material]) {
      resource.addEventListener("dispose", () => replacementDisposed.set(resource, (replacementDisposed.get(resource) ?? 0) + 1));
    }
  });
  assert.equal(sink.unload({ x: 2, z: -3 }), true);
  assert.equal(sink.unload({ x: 2, z: -3 }), false);
  sink.dispose();
  sink.dispose();
  assert.deepEqual([...replacementDisposed.values()], [1, 1, 1, 1]);
});

test("wireframe, frustum visibility and statistics are updated", () => {
  const sink = new ChunkRenderSink();
  sink.upsert({ x: 0, z: 0 }, fixture());
  sink.upsert({ x: 100, z: 100 }, fixture());
  sink.setWireframe(true);
  for (const group of sink.root.children) group.traverse((object) => {
    if (object instanceof Mesh) assert.equal((object.material as MeshLambertMaterial).wireframe, true);
  });

  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0.5, 0.5, 5);
  camera.lookAt(0.5, 0.5, 0);
  const stats = sink.updateVisibility(camera);
  assert.deepEqual(stats, { loaded: 2, visible: 1, culled: 1, triangles: 8 });
  assert.equal(sink.get({ x: 0, z: 0 })!.visible, true);
  assert.equal(sink.get({ x: 100, z: 100 })!.visible, false);
});
