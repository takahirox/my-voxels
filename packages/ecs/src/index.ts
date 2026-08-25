declare const entityBrand: unique symbol;
declare const stableKeyBrand: unique symbol;

export type Entity = number & { readonly [entityBrand]: "Entity" };
export type StableKey = string & { readonly [stableKeyBrand]: "StableKey" };

export interface ComponentType<T> {
  readonly key: StableKey;
  readonly kind: "component";
  readonly __value?: T;
}

export interface ResourceKey<T> {
  readonly key: StableKey;
  readonly kind: "resource";
  readonly __value?: T;
}

function key(value: string): StableKey {
  if (value.length === 0) throw new Error("stable keys must not be empty");
  return value as StableKey;
}

export function defineComponent<T>(value: string): ComponentType<T> {
  return Object.freeze({ key: key(value), kind: "component" as const });
}

export function defineResource<T>(value: string): ResourceKey<T> {
  return Object.freeze({ key: key(value), kind: "resource" as const });
}

type Operation =
  | { readonly kind: "spawn"; readonly entity: Entity }
  | { readonly kind: "despawn"; readonly entity: Entity }
  | { readonly kind: "set"; readonly entity: Entity; readonly key: StableKey; readonly value: unknown }
  | { readonly kind: "remove"; readonly entity: Entity; readonly key: StableKey }
  | { readonly kind: "resource"; readonly key: StableKey; readonly value: unknown }
  | { readonly kind: "removeResource"; readonly key: StableKey };

export class CommitError extends Error {
  public constructor(public readonly code: "COMMIT_CONFLICT" | "INVALID_ENTITY" | "STALE_BATCH") {
    super(code);
    this.name = "CommitError";
  }
}

export class CommandBuffer {
  readonly #operations: Operation[] = [];
  #nextEntity: number;
  #used = false;

  public constructor(private readonly world: World, private readonly revision: number, nextEntity: number) {
    this.#nextEntity = nextEntity;
  }

  public spawn(): Entity {
    const entity = this.#nextEntity++ as Entity;
    this.#operations.push({ kind: "spawn", entity });
    return entity;
  }

  public despawn(entity: Entity): this {
    this.#operations.push({ kind: "despawn", entity });
    return this;
  }

  public set<T>(entity: Entity, type: ComponentType<T>, value: T): this {
    this.#operations.push({ kind: "set", entity, key: type.key, value });
    return this;
  }

  public remove<T>(entity: Entity, type: ComponentType<T>): this {
    this.#operations.push({ kind: "remove", entity, key: type.key });
    return this;
  }

  public setResource<T>(type: ResourceKey<T>, value: T): this {
    this.#operations.push({ kind: "resource", key: type.key, value });
    return this;
  }

  public removeResource<T>(type: ResourceKey<T>): this {
    this.#operations.push({ kind: "removeResource", key: type.key });
    return this;
  }

  public commit(): void {
    if (this.#used) throw new CommitError("STALE_BATCH");
    this.#used = true;
    this.world.commit(this.revision, this.#nextEntity, this.#operations);
  }
}

export class World {
  #entities = new Set<Entity>();
  #components = new Map<StableKey, Map<Entity, unknown>>();
  #resources = new Map<StableKey, unknown>();
  #nextEntity = 0;
  #revision = 0;

  public commands(): CommandBuffer {
    return new CommandBuffer(this, this.#revision, this.#nextEntity);
  }

  public has(entity: Entity): boolean {
    return this.#entities.has(entity);
  }

  public get<T>(entity: Entity, type: ComponentType<T>): Readonly<T> | undefined {
    return this.#components.get(type.key)?.get(entity) as Readonly<T> | undefined;
  }

  public getResource<T>(type: ResourceKey<T>): Readonly<T> | undefined {
    return this.#resources.get(type.key) as Readonly<T> | undefined;
  }

  public query<T extends readonly ComponentType<unknown>[]>(...types: T): readonly Entity[] {
    return [...this.#entities]
      .filter((entity) => types.every((type) => this.#components.get(type.key)?.has(entity) === true))
      .sort((left, right) => left - right);
  }

  public commit(revision: number, nextEntity: number, operations: readonly Operation[]): void {
    if (revision !== this.#revision) throw new CommitError("STALE_BATCH");
    const entities = new Set(this.#entities);
    const components = new Map([...this.#components].map(([name, values]) => [name, new Map(values)]));
    const resources = new Map(this.#resources);
    const writes = new Set<string>();

    const claim = (target: string): void => {
      if (writes.has(target)) throw new CommitError("COMMIT_CONFLICT");
      writes.add(target);
    };
    const requireEntity = (entity: Entity): void => {
      if (!entities.has(entity)) throw new CommitError("INVALID_ENTITY");
    };

    for (const operation of operations) {
      if (operation.kind === "spawn") {
        claim(`entity:${operation.entity}`);
        if (entities.has(operation.entity)) throw new CommitError("COMMIT_CONFLICT");
        entities.add(operation.entity);
      } else if (operation.kind === "despawn") {
        claim(`entity:${operation.entity}`);
        requireEntity(operation.entity);
        entities.delete(operation.entity);
        for (const values of components.values()) values.delete(operation.entity);
      } else if (operation.kind === "set" || operation.kind === "remove") {
        requireEntity(operation.entity);
        claim(`component:${operation.key}:${operation.entity}`);
        let values = components.get(operation.key);
        if (values === undefined) {
          values = new Map();
          components.set(operation.key, values);
        }
        if (operation.kind === "set") values.set(operation.entity, operation.value);
        else values.delete(operation.entity);
      } else {
        claim(`resource:${operation.key}`);
        if (operation.kind === "resource") resources.set(operation.key, operation.value);
        else resources.delete(operation.key);
      }
    }

    this.#entities = entities;
    this.#components = components;
    this.#resources = resources;
    this.#nextEntity = nextEntity;
    this.#revision++;
  }
}
