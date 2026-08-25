import { World, type ComponentType, type ResourceKey, type StableKey } from "../../ecs/src/index.js";
import { RuntimeError, resolveModuleGraph, type CapabilityProvider, type CapabilityToken, type Diagnostic, type ModuleContext, type ModuleDefinition, type RuntimeState, type Stage, type SystemContext, type SystemDefinition } from "../../module-api/src/index.js";

export interface Clock { readonly stepSeconds: number }
export interface RuntimeConfig { readonly clock: Clock; readonly modules: readonly ModuleDefinition[] }
export interface Runtime { readonly state: RuntimeState; readonly world: World; readonly tickCount: number; readonly interpolationAlpha: number; start(): Promise<void>; stop(): Promise<void>; tick(): void; advance(elapsedSeconds: number): number }

const stages: readonly Stage[] = ["collect", "prepare", "simulate", "resolve", "commit", "replicate", "present", "cleanup"];
const fatal = (code: string, message: string, relatedKeys: readonly StableKey[] = [], fields: Partial<Diagnostic> = {}): RuntimeError => new RuntimeError(Object.freeze({ code, severity: "fatal", message, ...fields, relatedKeys: Object.freeze([...relatedKeys].sort()) }));
const keyCompare = (a: StableKey, b: StableKey): number => a < b ? -1 : a > b ? 1 : 0;

interface Scheduled { readonly module: ModuleDefinition; readonly system: SystemDefinition }

function schedule(modules: readonly ModuleDefinition[]): readonly Scheduled[] {
  const nodes = new Map<StableKey, Scheduled>();
  for (const module of modules) for (const system of module.systems) {
    if (nodes.has(system.key)) throw fatal("SYSTEM_DUPLICATE", `Duplicate system key: ${system.key}`, [system.key], { system: system.key });
    if (!stages.includes(system.stage)) throw fatal("STAGE_INVALID", `Invalid stage for system: ${system.key}`, [system.key], { system: system.key });
    nodes.set(system.key, { module, system });
  }
  const edges = new Map<StableKey, Set<StableKey>>([...nodes.keys()].map((key) => [key, new Set()]));
  const add = (from: StableKey, to: StableKey): void => { if (from !== to) edges.get(from)!.add(to); };
  const values = [...nodes.values()];
  for (const left of values) for (const right of values) if (stages.indexOf(left.system.stage) < stages.indexOf(right.system.stage)) add(left.system.key, right.system.key);
  for (const node of values) {
    for (const target of node.system.before ?? []) { if (!nodes.has(target)) throw fatal("SYSTEM_REFERENCE_MISSING", `Missing system reference: ${target}`, [node.system.key, target], { system: node.system.key }); add(node.system.key, target); }
    for (const source of node.system.after ?? []) { if (!nodes.has(source)) throw fatal("SYSTEM_REFERENCE_MISSING", `Missing system reference: ${source}`, [node.system.key, source], { system: node.system.key }); add(source, node.system.key); }
  }
  const providers = new Map<StableKey, ModuleDefinition[]>();
  for (const module of modules) for (const provider of module.provides) { const group = providers.get(provider.token.key) ?? []; group.push(module); providers.set(provider.token.key, group); }
  for (const consumer of modules) for (const token of consumer.requires) for (const provider of providers.get(token.key) ?? []) for (const a of provider.systems) for (const b of consumer.systems) add(a.key, b.key);
  const degree = new Map<StableKey, number>([...nodes.keys()].map((key) => [key, 0]));
  for (const targets of edges.values()) for (const target of targets) degree.set(target, degree.get(target)! + 1);
  const ready = [...degree].filter(([, n]) => n === 0).map(([key]) => key).sort(keyCompare); const result: Scheduled[] = [];
  while (ready.length) { const key = ready.shift()!; result.push(nodes.get(key)!); for (const target of [...edges.get(key)!].sort(keyCompare)) { const n = degree.get(target)! - 1; degree.set(target, n); if (n === 0) { ready.push(target); ready.sort(keyCompare); } } }
  if (result.length !== nodes.size) { const cycle = [...degree].filter(([, n]) => n > 0).map(([key]) => key).sort(keyCompare); throw fatal("SYSTEM_CYCLE", `System ordering cycle: ${cycle.join(" -> ")}`, cycle); }
  return Object.freeze(result);
}

class HeadlessRuntime implements Runtime {
  #state: RuntimeState = "created"; #start?: Promise<void>; #stop?: Promise<void>; #cancel = false; #started: ModuleDefinition[] = []; #ticks = 0; #accumulator = 0;
  readonly world = new World();
  readonly #modules: readonly ModuleDefinition[]; readonly #schedule: readonly Scheduled[]; readonly #providers: ReadonlyMap<StableKey, readonly { readonly module: ModuleDefinition; readonly provider: CapabilityProvider<unknown> }[]>;
  readonly #runtimeValues = new Map<CapabilityProvider<unknown>, unknown>(); readonly #moduleValues = new Map<ModuleDefinition, Map<CapabilityProvider<unknown>, unknown>>(); readonly #available = new Set<CapabilityProvider<unknown>>();
  constructor(readonly config: RuntimeConfig) {
    if (!Number.isFinite(config.clock.stepSeconds) || config.clock.stepSeconds <= 0) throw fatal("CLOCK_INVALID", "Clock stepSeconds must be finite and positive");
    const graph = resolveModuleGraph(config.modules); if (graph.diagnostics.length) throw new RuntimeError(graph.diagnostics[0]!);
    this.#modules = graph.modules; this.#providers = graph.providers; this.#schedule = schedule(graph.modules);
  }
  get state(): RuntimeState { return this.#state; } get tickCount(): number { return this.#ticks; } get interpolationAlpha(): number { return this.#accumulator / this.config.clock.stepSeconds; }
  #context(module: ModuleDefinition): ModuleContext { return { resolve: <T>(token: CapabilityToken<T>) => { const entries = this.#providers.get(token.key) ?? []; const values = entries.map(({ provider }) => { if (!this.#available.has(provider)) throw fatal("CAPABILITY_DELAYED", `Capability value is not available: ${token.key}`, [module.key, token.key], { module: module.key, capability: token.key }); const map = token.scope === "runtime" ? this.#runtimeValues : this.#moduleValues.get(module)!; return map.get(provider) as T; }); return (token.multiplicity === "collection" ? Object.freeze(values) : values[0]) as T | readonly T[] | undefined; } }; }
  async #materialize(provider: CapabilityProvider<unknown>, consumer: ModuleDefinition): Promise<void> { const map = provider.token.scope === "runtime" ? this.#runtimeValues : this.#moduleValues.get(consumer)!; if (!map.has(provider)) map.set(provider, typeof provider.value === "function" ? await (provider.value as () => unknown | Promise<unknown>)() : provider.value); this.#available.add(provider); }
  start(): Promise<void> {
    if (this.#start) return this.#start; if (this.#state !== "created") return this.#state === "running" ? Promise.resolve() : Promise.reject(fatal("RUNTIME_TERMINAL", `Cannot start runtime in state: ${this.#state}`));
    this.#state = "starting";
    this.#start = (async () => { try {
      for (const module of this.#modules) this.#moduleValues.set(module, new Map());
      for (const module of this.#modules) for (const token of module.requires) for (const entry of this.#providers.get(token.key) ?? []) if (entry.provider.delayed !== true) await this.#materialize(entry.provider, module);
      for (const module of this.#modules) { if (this.#cancel) break; await module.start?.(this.#context(module)); this.#started.push(module); for (const provider of module.provides) if (provider.delayed === true) { for (const consumer of this.#modules.filter((item) => item.requires.some((token) => token.key === provider.token.key))) await this.#materialize(provider, consumer); } }
      if (this.#cancel) { await this.#cleanup(); this.#state = "stopped"; return; } this.#state = "running";
    } catch (cause) { await this.#cleanup(); this.#state = "failed"; if (cause instanceof RuntimeError) throw cause; throw fatal("MODULE_START_FAILED", "Module startup failed", [], { cause }); } })(); return this.#start;
  }
  async #cleanup(): Promise<void> { let failure: unknown; for (const module of [...this.#started].reverse()) try { await module.stop?.(this.#context(module)); } catch (cause) { failure ??= cause; } this.#started = []; if (failure !== undefined) throw fatal("MODULE_STOP_FAILED", "Module shutdown failed", [], { cause: failure }); }
  stop(): Promise<void> {
    if (this.#stop) return this.#stop; if (this.#state === "stopped") return Promise.resolve(); if (this.#state === "failed") return Promise.reject(fatal("RUNTIME_TERMINAL", "Failed runtime is terminal"));
    this.#cancel = true; this.#stop = (async () => { if (this.#state === "starting") { try { await this.#start; } catch { return; } const settled: RuntimeState = this.state; if (settled === "stopped" || settled === "failed") return; } this.#state = "stopping"; try { await this.#cleanup(); this.#state = "stopped"; } catch (error) { this.#state = "failed"; throw error; } })(); return this.#stop;
  }
  tick(): void { if (this.#state !== "running") throw fatal("RUNTIME_NOT_RUNNING", "Runtime must be running to tick"); for (const stage of stages) { const commands = this.world.commands(); const context: SystemContext = { read: <T>(type: ComponentType<T> | ResourceKey<T>) => { if (type.kind === "component") throw fatal("COMPONENT_ENTITY_REQUIRED", "SystemContext component reads require a query"); const value = this.world.getResource(type); if (value === undefined) throw fatal("RESOURCE_MISSING", `Resource is missing: ${type.key}`, [type.key]); return value; }, write: <T>(type: ComponentType<T> | ResourceKey<T>, value: T) => { if (type.kind === "component") throw fatal("COMPONENT_ENTITY_REQUIRED", "SystemContext component writes require an entity"); commands.setResource(type, value); } }; for (const item of this.#schedule) if (item.system.stage === stage) item.system.run(context); commands.commit(); } this.#ticks++; }
  advance(elapsedSeconds: number): number { if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) throw fatal("ELAPSED_INVALID", "Elapsed seconds must be finite and non-negative"); this.#accumulator += elapsedSeconds; let count = 0; while (this.#accumulator + Number.EPSILON >= this.config.clock.stepSeconds) { this.tick(); this.#accumulator -= this.config.clock.stepSeconds; count++; } return count; }
}

export function createRuntime(config: RuntimeConfig): Runtime { return new HeadlessRuntime(config); }
