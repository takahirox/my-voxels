import type { ComponentType, ResourceKey, StableKey } from "../../ecs/src/index.js";
export type { ComponentType, Entity, ResourceKey, StableKey } from "../../ecs/src/index.js";

export type Stage = "collect" | "prepare" | "simulate" | "resolve" | "commit" | "replicate" | "present" | "cleanup";
export type RuntimeState = "created" | "starting" | "running" | "stopping" | "stopped" | "failed";
export interface EventType<T> { readonly key: StableKey; readonly kind: "event"; readonly __value?: T }
export interface CommandType<P, R = void> { readonly key: StableKey; readonly kind: "command"; readonly __payload?: P; readonly result?: R }
export type CapabilityMultiplicity = "single" | "collection";
export type CapabilityRequirement = "required" | "optional";
export type CapabilityScope = "runtime" | "module";
export type ResolveResult<T> = T | readonly T[] | undefined;
export interface CapabilityToken<T> { readonly key: StableKey; readonly multiplicity: CapabilityMultiplicity; readonly requirement: CapabilityRequirement; readonly scope: CapabilityScope; readonly __value?: T }
export interface CapabilityProvider<T> { readonly token: CapabilityToken<T>; readonly key: StableKey; readonly value: T | (() => T | Promise<T>); readonly delayed?: boolean }
export interface SystemContext { read<T>(type: ComponentType<T> | ResourceKey<T>): Readonly<T>; write<T>(type: ComponentType<T> | ResourceKey<T>, value: T): void }
export interface ModuleContext { resolve<T>(token: CapabilityToken<T>): ResolveResult<T> }
export interface Diagnostic { readonly code: string; readonly severity: "fatal" | "error" | "warning" | "info"; readonly message: string; readonly module?: StableKey; readonly system?: StableKey; readonly capability?: StableKey; readonly relatedKeys?: readonly StableKey[]; readonly cause?: unknown }
export class RuntimeError extends Error { public constructor(public readonly diagnostic: Diagnostic) { super(diagnostic.message); this.name = "RuntimeError"; } }
export interface SystemDefinition { readonly key: StableKey; readonly stage: Stage; readonly before?: readonly StableKey[]; readonly after?: readonly StableKey[]; readonly reads: readonly StableKey[]; readonly writes: readonly StableKey[]; run(context: SystemContext): void }
export interface ModuleDefinition { readonly key: StableKey; readonly requires: readonly CapabilityToken<unknown>[]; readonly provides: readonly CapabilityProvider<unknown>[]; readonly systems: readonly SystemDefinition[]; start?(context: ModuleContext): void | Promise<void>; stop?(context: ModuleContext): void | Promise<void> }

const stableKey = (value: string): StableKey => { if (value.length === 0) throw new Error("stable keys must not be empty"); return value as StableKey; };
const frozenKeys = (values: readonly StableKey[] | undefined): readonly StableKey[] | undefined => values === undefined ? undefined : Object.freeze([...values]);

export function defineCapability<T>(definition: Omit<CapabilityToken<T>, "key"> & { readonly key: string }): CapabilityToken<T> {
  return Object.freeze({ ...definition, key: stableKey(definition.key) });
}
export function provide<T>(token: CapabilityToken<T>, key: string, value: T | (() => T | Promise<T>), options?: { readonly delayed?: boolean }): CapabilityProvider<T> {
  return Object.freeze(options?.delayed === true ? { token, key: stableKey(key), value, delayed: true } : { token, key: stableKey(key), value });
}
export function defineModule<T extends Omit<ModuleDefinition, "key"> & { readonly key: string }>(definition: T): ModuleDefinition {
  const systems = definition.systems.map((system) => Object.freeze({ ...system, before: frozenKeys(system.before), after: frozenKeys(system.after), reads: Object.freeze([...system.reads]), writes: Object.freeze([...system.writes]) }));
  return Object.freeze({ ...definition, key: stableKey(definition.key), requires: Object.freeze([...definition.requires]), provides: Object.freeze([...definition.provides]), systems: Object.freeze(systems) }) as unknown as ModuleDefinition;
}

export interface ResolvedProvider { readonly module: ModuleDefinition; readonly provider: CapabilityProvider<unknown> }
export interface ModuleGraph { readonly modules: readonly ModuleDefinition[]; readonly providers: ReadonlyMap<StableKey, readonly ResolvedProvider[]>; readonly diagnostics: readonly Diagnostic[] }
const compareKey = (a: { readonly key: StableKey }, b: { readonly key: StableKey }): number => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
const diagnostic = (code: string, message: string, relatedKeys: readonly StableKey[], fields: Partial<Diagnostic> = {}): Diagnostic => Object.freeze({ code, severity: "fatal", message, ...fields, relatedKeys: Object.freeze([...relatedKeys].sort()) });

export function resolveModuleGraph(registrations: readonly ModuleDefinition[]): ModuleGraph {
  const modules = [...registrations].sort(compareKey);
  const diagnostics: Diagnostic[] = [];
  const uniqueModules = new Map<StableKey, ModuleDefinition>();
  for (const module of modules) {
    if (uniqueModules.has(module.key)) diagnostics.push(diagnostic("MODULE_DUPLICATE", `Duplicate module key: ${module.key}`, [module.key], { module: module.key }));
    else uniqueModules.set(module.key, module);
  }
  const providerKeys = new Map<StableKey, ResolvedProvider>();
  const providers = new Map<StableKey, ResolvedProvider[]>();
  for (const module of uniqueModules.values()) for (const provider of [...module.provides].sort(compareKey)) {
    const prior = providerKeys.get(provider.key);
    if (prior !== undefined) diagnostics.push(diagnostic("PROVIDER_DUPLICATE", `Duplicate provider key: ${provider.key}`, [prior.module.key, module.key, provider.key], { capability: provider.token.key }));
    else providerKeys.set(provider.key, { module, provider });
    const group = providers.get(provider.token.key) ?? [];
    group.push({ module, provider }); providers.set(provider.token.key, group);
  }
  for (const group of providers.values()) group.sort((a, b) => compareKey(a.provider, b.provider));
  const edges = new Map<StableKey, Set<StableKey>>([...uniqueModules.keys()].map((key) => [key, new Set()]));
  const indegree = new Map<StableKey, number>([...uniqueModules.keys()].map((key) => [key, 0]));
  for (const module of uniqueModules.values()) for (const token of [...module.requires].sort(compareKey)) {
    const matches = providers.get(token.key) ?? [];
    if (matches.length === 0 && token.requirement === "required") diagnostics.push(diagnostic("CAPABILITY_MISSING", `Required capability has no provider: ${token.key}`, [module.key, token.key], { module: module.key, capability: token.key }));
    if (matches.length > 1 && token.multiplicity === "single") diagnostics.push(diagnostic("CAPABILITY_AMBIGUOUS", `Single capability has multiple providers: ${token.key}`, [module.key, token.key, ...matches.map((match) => match.provider.key)], { module: module.key, capability: token.key }));
    for (const match of matches) if (match.module.key !== module.key && !edges.get(match.module.key)?.has(module.key)) { edges.get(match.module.key)?.add(module.key); indegree.set(module.key, (indegree.get(module.key) ?? 0) + 1); }
  }
  const ready = [...indegree].filter(([, degree]) => degree === 0).map(([key]) => key).sort();
  const ordered: ModuleDefinition[] = [];
  while (ready.length > 0) { const key = ready.shift()!; ordered.push(uniqueModules.get(key)!); for (const target of [...(edges.get(key) ?? [])].sort()) { const degree = (indegree.get(target) ?? 0) - 1; indegree.set(target, degree); if (degree === 0) { ready.push(target); ready.sort(); } } }
  if (ordered.length !== uniqueModules.size) { const cycleKeys = [...indegree].filter(([, degree]) => degree > 0).map(([key]) => key).sort(); diagnostics.push(diagnostic("MODULE_CYCLE", `Module dependency cycle: ${cycleKeys.join(" -> ")}`, cycleKeys)); }
  const readonlyProviders = new Map([...providers].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, Object.freeze([...value])]));
  diagnostics.sort((a, b) => a.code.localeCompare(b.code) || (a.relatedKeys?.join("\0") ?? "").localeCompare(b.relatedKeys?.join("\0") ?? ""));
  return Object.freeze({ modules: Object.freeze(ordered), providers: readonlyProviders, diagnostics: Object.freeze(diagnostics) });
}

export function resolveCapability<T>(graph: ModuleGraph, token: CapabilityToken<T>): CapabilityProvider<T> | readonly CapabilityProvider<T>[] | undefined {
  const values = (graph.providers.get(token.key) ?? []).map((entry) => entry.provider as CapabilityProvider<T>);
  return token.multiplicity === "collection" ? Object.freeze(values) : values[0];
}
