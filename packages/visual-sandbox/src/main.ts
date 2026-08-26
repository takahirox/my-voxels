import "./style.css";

import {
  ACESFilmicToneMapping, Box3, Box3Helper, Clock, Color, DirectionalLight,
  Fog, Group, HemisphereLight, MathUtils, PerspectiveCamera, Scene,
  SRGBColorSpace, Vector3, WebGLRenderer,
} from "three";

import { ChunkRenderSink } from "../../renderer-three/src/index.js";
import {
  BrowserWorkerPool, InlineVoxelExecutor, VoxelJobScheduler, createVoxelJob,
  workerCountForHardwareConcurrency, type Revision, type VoxelExecutor,
} from "../../voxel-jobs/src/index.js";
import type { BrowserWorkerRequest, WorkerLike } from "../../voxel-jobs/src/browser.js";
import {
  dispatchVoxelWorkerRequest, type BakeVertexLightResultWire, type ChunkSnapshotWire,
  type HorizontalHaloWire, type LightVolumeWire, type MeshInputWire,
  type TerrainResultWire, type VoxelMeshWire,
} from "../../voxel-jobs/src/worker-entry.js";
import { ChunkCandidate, VoxelStorage, type ChunkCoord, type ChunkSnapshot } from "../../voxel-storage/src/index.js";
import type { VoxelMesh } from "../../voxel-mesher/src/index.js";
import {
  applySandboxEdgeTreatment, chunkKey, cloneMeshInputWire,
  deterministicChunks, distanceFromCamera, parseSandboxConfig,
} from "./config.js";
import { FrameSampler, average, formatCount, formatDuration } from "./stats.js";

const byId = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (value === null) throw new Error(`missing UI element #${id}`);
  return value as T;
};

const config = parseSandboxConfig(location.search);
const canvas = byId<HTMLCanvasElement>("world");
const scene = new Scene();
scene.fog = new Fog(0xb4d9dc, 80, 190);
const camera = new PerspectiveCamera(58, 1, 0.1, 500);
camera.position.set(54, 58, 66);
camera.rotation.order = "YXZ";
camera.rotation.set(-0.48, 0.72, 0);

const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = false;

const sink = new ChunkRenderSink();
scene.add(sink.root);
scene.add(new HemisphereLight(0xd9f4ff, 0x52633a, 1.65));
const sun = new DirectionalLight(0xfff2cf, 2.2);
sun.position.set(-45, 90, 35);
scene.add(sun);

const workerCount = config.executor === "inline" ? 1 : workerCountForHardwareConcurrency(navigator.hardwareConcurrency);
let pool: BrowserWorkerPool | undefined;
let executor: VoxelExecutor;
if (config.executor === "inline") {
  executor = new InlineVoxelExecutor(Object.fromEntries(["terrain", "mesh", "lighting", "bake"].map((type) => [
    type, (job: { readonly id: string; readonly input: unknown }) => dispatchVoxelWorkerRequest({
      id: job.id, type: type as BrowserWorkerRequest["type"], input: job.input as BrowserWorkerRequest["input"],
    }),
  ])));
} else {
  const workers: WorkerLike[] = Array.from({ length: workerCount }, () => new Worker(
    new URL("../../voxel-jobs/src/worker-entry.ts", import.meta.url), { type: "module" },
  ) as unknown as WorkerLike);
  pool = new BrowserWorkerPool(workers);
  executor = pool;
}

const storage = new VoxelStorage();
const expected = new Map<string, bigint>();
const readyTimes: number[] = [];
const startedAt = performance.now();
let firstVisibleAt: number | undefined;
let sequence = 0;
let completedStages = 0;
let vertices = 0;
const totalStages = 16 * 4;

function revisionRecord(refs: readonly { readonly coord: ChunkCoord; readonly revision: string }[]): Revision {
  return Object.freeze(Object.fromEntries(refs.map((ref) => [chunkKey(ref.coord), Number(BigInt(ref.revision))])));
}

function revisionValid(revision: Revision): boolean {
  return Object.entries(revision).every(([key, value]) => expected.get(key) === BigInt(value));
}

const scheduler = new VoxelJobScheduler({ concurrency: workerCount, executor, validateRevision: revisionValid, now: performance.now.bind(performance) });

function snapshotWire(snapshot: ChunkSnapshot): ChunkSnapshotWire {
  return { coord: { ...snapshot.coord }, revision: snapshot.revision.toString(), blocks: snapshot.blocks };
}

function haloWire(coord: ChunkCoord): HorizontalHaloWire {
  const halo = storage.horizontalHalo(coord);
  const entry = (value: typeof halo.west): HorizontalHaloWire["west"] => value.status === "available"
    ? { status: "available", chunk: snapshotWire(value.chunk) }
    : { status: "unavailable", coord: { ...value.coord } };
  return { west: entry(halo.west), east: entry(halo.east), north: entry(halo.north), south: entry(halo.south) };
}

function meshInput(coord: ChunkCoord): MeshInputWire {
  const snapshot = storage.snapshot(coord);
  if (snapshot === undefined) throw new Error(`chunk ${chunkKey(coord)} is not resident`);
  const halo = haloWire(coord);
  const revisions = [snapshot, ...Object.values(halo).flatMap((entry) => entry.status === "available" ? [entry.chunk] : [])]
    .map((item) => ({ coord: { ...item.coord }, revision: item.revision.toString() }));
  return { snapshot: snapshotWire(snapshot), halo, revisions };
}

function meshFromWire(wire: VoxelMeshWire): VoxelMesh {
  return { ...wire, revisions: wire.revisions.map((ref) => ({ coord: ref.coord, revision: BigInt(ref.revision) as never })) };
}

function cloneMeshForBake(wire: VoxelMeshWire): VoxelMeshWire {
  return {
    positions: wire.positions.slice(),
    normals: wire.normals.slice(),
    indices: wire.indices.slice(),
    blockIds: wire.blockIds.slice(),
    ao: wire.ao.slice(),
    light: wire.light.slice(),
    colors: wire.colors.slice(),
    bounds: {
      min: [...wire.bounds.min] as [number, number, number],
      max: [...wire.bounds.max] as [number, number, number],
    },
    quadCount: wire.quadCount,
    triangleCount: wire.triangleCount,
    vertexCount: wire.vertexCount,
    exposedSurfaceArea: wire.exposedSurfaceArea,
    revisions: wire.revisions.map((ref) => ({ coord: { ...ref.coord }, revision: ref.revision })),
  };
}

function cloneLightForBake(wire: LightVolumeWire): LightVolumeWire {
  return {
    data: wire.data.slice(),
    revisions: wire.revisions.map((ref) => ({ coord: { ...ref.coord }, revision: ref.revision })),
  };
}

function progress(label: string): void {
  completedStages++;
  const amount = Math.min(100, Math.round(completedStages / totalStages * 100));
  byId("status").textContent = label;
  byId("percent").textContent = `${amount}%`;
  byId("progress").style.width = `${amount}%`;
}

async function runPipeline(): Promise<void> {
  const coords = deterministicChunks();
  const terrain = coords.map((coord) => {
    const id = `terrain:${chunkKey(coord)}`;
    return scheduler.enqueue<TerrainResultWire>(createVoxelJob({
      id, type: "terrain", revision: {}, visible: true, distance: distanceFromCamera(coord), downstream: 3,
      enqueuedAt: performance.now(), sequence: sequence++, input: { seed: config.seed.toString(), coord },
      commit: (result) => {
        const blocks = applySandboxEdgeTreatment(result.coord, result.blocks);
        const committed = storage.commit(new ChunkCandidate(result.coord, blocks));
        if (committed.status !== "committed") throw new Error(`${id} became stale`);
        expected.set(chunkKey(coord), committed.snapshot.revision);
        progress(`Terrain resident · ${expected.size} / 16 chunks`);
      },
    }));
  });
  const terrainOutcomes = await Promise.all(terrain);
  if (terrainOutcomes.some((outcome) => outcome.status !== "succeeded")) throw new Error("terrain stage did not complete");

  await Promise.all(coords.map(async (coord) => {
    const source = meshInput(coord);
    const refs = source.revisions;
    const revision = revisionRecord(refs);
    const suffix = chunkKey(coord);
    let meshResult: VoxelMeshWire | undefined;
    let lightResult: LightVolumeWire | undefined;
    const meshId = `mesh:${suffix}`;
    const lightId = `lighting:${suffix}`;
    const meshPromise = scheduler.enqueue<VoxelMeshWire>(createVoxelJob({
      id: meshId, type: "mesh", revision, dependencies: [{ id: `terrain:${suffix}`, type: "terrain" }],
      visible: true, distance: distanceFromCamera(coord), downstream: 2, enqueuedAt: performance.now(), sequence: sequence++,
      input: { meshInput: cloneMeshInputWire(source) }, commit: (result) => { meshResult = result; progress(`Meshing landscape · ${suffix}`); },
    }));
    const lightPromise = scheduler.enqueue<LightVolumeWire>(createVoxelJob({
      id: lightId, type: "lighting", revision, dependencies: [{ id: `terrain:${suffix}`, type: "terrain" }],
      visible: true, distance: distanceFromCamera(coord), downstream: 2, enqueuedAt: performance.now(), sequence: sequence++,
      input: { meshInput: cloneMeshInputWire(source) }, commit: (result) => { lightResult = result; progress(`Lighting landscape · ${suffix}`); },
    }));
    const pair = await Promise.all([meshPromise, lightPromise]);
    if (pair.some((outcome) => outcome.status !== "succeeded") || meshResult === undefined || lightResult === undefined) {
      throw new Error(`mesh or lighting failed for ${suffix}`);
    }
    const bakeStarted = performance.now();
    const outcome = await scheduler.enqueue<BakeVertexLightResultWire>(createVoxelJob({
      id: `bake:${suffix}`, type: "bake", revision,
      dependencies: [{ id: meshId, type: "mesh" }, { id: lightId, type: "lighting" }],
      visible: true, distance: distanceFromCamera(coord), downstream: 1, enqueuedAt: performance.now(), sequence: sequence++,
      input: {
        mesh: cloneMeshForBake(meshResult),
        volume: cloneLightForBake(lightResult),
      },
      commit: (baked) => {
        if (baked.status !== "baked" || !revisionValid(revision)) throw new Error(`obsolete bake for ${suffix}`);
        const mesh = meshFromWire(meshResult!);
        sink.upsert(coord, mesh, baked);
        vertices += mesh.vertexCount;
        readyTimes.push(performance.now() - bakeStarted);
        if (firstVisibleAt === undefined) firstVisibleAt = performance.now();
        progress(`Uploading chunks · ${sink.size} / 16 visible`);
      },
    }));
    if (outcome.status !== "succeeded") throw new Error(`bake failed for ${suffix}`);
  }));
  byId("status").textContent = "Landscape ready · drag to explore";
}

const bounds = new Group();
scene.add(bounds);
for (const coord of deterministicChunks()) {
  const helper = new Box3Helper(new Box3(
    new Vector3(coord.x * 16, 0, coord.z * 16), new Vector3(coord.x * 16 + 16, 64, coord.z * 16 + 16),
  ), 0xe7f3c6);
  helper.visible = false;
  bounds.add(helper);
}

let yaw = camera.rotation.y, pitch = camera.rotation.x, dragging = false;
let previousX = 0, previousY = 0;
const keys = new Set<string>();
const onPointerDown = (event: PointerEvent): void => { dragging = true; previousX = event.clientX; previousY = event.clientY; canvas.setPointerCapture(event.pointerId); };
const onPointerMove = (event: PointerEvent): void => {
  if (!dragging) return;
  yaw -= (event.clientX - previousX) * .004;
  pitch = MathUtils.clamp(pitch - (event.clientY - previousY) * .004, -1.5, 1.5);
  previousX = event.clientX; previousY = event.clientY;
};
const onPointerUp = (): void => { dragging = false; };
const typing = (): boolean => document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
const onKeyDown = (event: KeyboardEvent): void => { if (!typing()) keys.add(event.code); };
const onKeyUp = (event: KeyboardEvent): void => { keys.delete(event.code); };
canvas.addEventListener("pointerdown", onPointerDown);
canvas.addEventListener("pointermove", onPointerMove);
canvas.addEventListener("pointerup", onPointerUp);
window.addEventListener("keydown", onKeyDown);
window.addEventListener("keyup", onKeyUp);

function setLinks(): void {
  const base = new URL(location.href);
  base.searchParams.set("seed", config.seed.toString());
  base.searchParams.set("camera", config.camera);
  const worker = new URL(base); worker.searchParams.delete("executor");
  const inline = new URL(base); inline.searchParams.set("executor", "inline");
  byId<HTMLAnchorElement>("worker-link").href = worker.href;
  byId<HTMLAnchorElement>("inline-link").href = inline.href;
  byId<HTMLAnchorElement>("benchmark-link").href = worker.href;
}
setLinks();
byId("identity").textContent = `seed ${config.seed} · ${config.camera} · ${config.executor}`;
byId("workers").textContent = String(workerCount);
byId<HTMLInputElement>("wireframe").addEventListener("change", (event) => sink.setWireframe((event.target as HTMLInputElement).checked));
byId<HTMLInputElement>("bounds").addEventListener("change", (event) => { bounds.children.forEach((child) => { child.visible = (event.target as HTMLInputElement).checked; }); });
byId<HTMLInputElement>("fog").addEventListener("change", (event) => { scene.fog = (event.target as HTMLInputElement).checked ? new Fog(0xb4d9dc, 80, 190) : null; });

const sampler = new FrameSampler();
const clock = new Clock();
let animation = 0;
function resize(): void {
  const width = innerWidth, height = innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

function updateDashboard(): void {
  const metrics = scheduler.metrics();
  const stats = sink.stats;
  byId("fps").textContent = sampler.fps === undefined ? "—" : sampler.fps.toFixed(0);
  byId("frame").textContent = formatDuration(sampler.frameMs);
  byId("draws").textContent = formatCount(renderer.info.render.calls);
  byId("chunks").textContent = `${stats.visible} / ${stats.loaded}`;
  byId("vertices").textContent = formatCount(vertices);
  byId("triangles").textContent = formatCount(stats.triangles);
  byId("ttv").textContent = formatDuration(firstVisibleAt === undefined ? undefined : firstVisibleAt - startedAt);
  byId("avg-job").textContent = formatDuration(average(metrics.durationsMs));
  byId("avg-ready").textContent = formatDuration(average(readyTimes));
  byId("outcomes").textContent = `${metrics.stale} / ${metrics.cancelled} / ${metrics.failed}`;
  byId("queue").textContent = (["terrain", "mesh", "lighting", "bake"] as const)
    .map((type) => `${type} ${metrics.queued[type]}/${metrics.running[type]}`).join(" · ");
  byId("assignments").textContent = metrics.assignments.slice(-4).reverse().map((item) => `${item.type} · ${item.id.split(":").at(-1)}`).join("\n") || "Waiting for workers…";
}

function frame(): void {
  const delta = Math.min(clock.getDelta(), .05);
  sampler.push(delta * 1_000);
  camera.rotation.set(pitch, yaw, 0);
  const movement = new Vector3(
    Number(keys.has("KeyD")) - Number(keys.has("KeyA")),
    Number(keys.has("Space") || keys.has("KeyE")) - Number(keys.has("ShiftLeft") || keys.has("KeyQ")),
    Number(keys.has("KeyS")) - Number(keys.has("KeyW")),
  );
  if (movement.lengthSq() > 0 && !typing()) {
    movement.normalize().applyEuler(camera.rotation).multiplyScalar(22 * delta);
    camera.position.add(movement);
  }
  sink.updateVisibility(camera);
  renderer.render(scene, camera);
  updateDashboard();
  animation = requestAnimationFrame(frame);
}
animation = requestAnimationFrame(frame);

let disposed = false;
function dispose(): void {
  if (disposed) return;
  disposed = true;
  cancelAnimationFrame(animation);
  window.removeEventListener("resize", resize);
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("keyup", onKeyUp);
  canvas.removeEventListener("pointerdown", onPointerDown);
  canvas.removeEventListener("pointermove", onPointerMove);
  canvas.removeEventListener("pointerup", onPointerUp);
  sink.dispose(); pool?.dispose(); renderer.dispose();
  bounds.clear();
}
window.addEventListener("pagehide", dispose, { once: true });

void runPipeline().catch((error: unknown) => {
  const fatal = byId("fatal");
  fatal.hidden = false;
  fatal.textContent = `Sandbox failed: ${error instanceof Error ? error.message : String(error)}`;
  byId("status").textContent = "Unable to build landscape";
});
