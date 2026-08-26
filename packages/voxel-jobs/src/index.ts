export * from "./browser.js";

export const VOXEL_JOB_TYPES = ["terrain", "mesh", "lighting", "bake"] as const;

export type VoxelJobType = (typeof VOXEL_JOB_TYPES)[number];
export type JobId = string;
export type Revision = Readonly<Record<string, number>>;

export interface JobDependency {
  readonly id: JobId;
  readonly type: VoxelJobType;
}

export interface JobPriorityInput {
  readonly visible: boolean;
  readonly distance: number;
  readonly downstream: number;
  readonly enqueuedAt: number;
  readonly sequence: number;
}

export interface JobPriorityPolicy {
  readonly ageQuantumMs: number;
  readonly maxAgeBoost: number;
}

export interface JobPriority {
  readonly visibleRank: 0 | 1;
  readonly distanceRank: number;
  readonly downstreamRank: number;
  readonly ageRank: number;
  readonly sequence: number;
}

export interface VoxelJob<TInput = unknown, TResult = unknown> {
  readonly id: JobId;
  readonly type: VoxelJobType;
  readonly revision: Revision;
  readonly dependencies: readonly JobDependency[];
  readonly priority: JobPriorityInput;
  readonly input: TInput;
  readonly commit: (result: TResult) => void | Promise<void>;
}

export interface CreateVoxelJobOptions<TInput, TResult> {
  readonly id: JobId;
  readonly type: VoxelJobType;
  readonly revision: Revision;
  readonly dependencies?: readonly JobDependency[];
  readonly visible: boolean;
  readonly distance: number;
  readonly downstream?: number;
  readonly enqueuedAt: number;
  readonly sequence: number;
  readonly input: TInput;
  readonly commit: (result: TResult) => void | Promise<void>;
}

export interface JobExecutionContext {
  readonly signal: AbortSignal;
}

export interface VoxelExecutor {
  execute<TResult>(job: VoxelJob<unknown, TResult>, context: JobExecutionContext): Promise<TResult>;
}

export type InlineJobHandler = (
  job: VoxelJob<unknown, unknown>,
  context: JobExecutionContext,
) => unknown | Promise<unknown>;

export class InlineVoxelExecutor implements VoxelExecutor {
  readonly #handlers: Readonly<Partial<Record<VoxelJobType, InlineJobHandler>>>;

  public constructor(handlers: Readonly<Partial<Record<VoxelJobType, InlineJobHandler>>>) {
    this.#handlers = Object.freeze({ ...handlers });
    Object.freeze(this);
  }

  public async execute<TResult>(
    job: VoxelJob<unknown, TResult>,
    context: JobExecutionContext,
  ): Promise<TResult> {
    const handler = this.#handlers[job.type];
    if (handler === undefined) throw new Error(`no inline handler for ${job.type}`);
    return await handler(job as VoxelJob<unknown, unknown>, context) as TResult;
  }
}

export type JobFailureReason = "dependency" | "execution" | "commit";

export type JobOutcome<TResult = unknown> =
  | Readonly<{ status: "succeeded"; result: TResult }>
  | Readonly<{ status: "failed"; reason: JobFailureReason; error: unknown }>
  | Readonly<{ status: "cancelled" }>
  | Readonly<{ status: "stale"; result: TResult }>;

export interface Assignment {
  readonly id: JobId;
  readonly type: VoxelJobType;
  readonly sequence: number;
  readonly assignedAt: number;
}

export interface JobTypeCounts {
  readonly terrain: number;
  readonly mesh: number;
  readonly lighting: number;
  readonly bake: number;
}

export interface SchedulerMetrics {
  readonly queued: JobTypeCounts;
  readonly running: JobTypeCounts;
  readonly assignments: readonly Assignment[];
  readonly durationsMs: readonly number[];
  readonly ready: number;
  readonly stale: number;
  readonly cancelled: number;
  readonly failed: number;
}

export interface VoxelSchedulerOptions {
  readonly concurrency: number;
  readonly executor: VoxelExecutor;
  readonly validateRevision: (revision: Revision, job: VoxelJob) => boolean | Promise<boolean>;
  readonly priority?: Partial<JobPriorityPolicy>;
  readonly now?: () => number;
}

const DEFAULT_PRIORITY_POLICY: JobPriorityPolicy = Object.freeze({
  ageQuantumMs: 1_000,
  maxAgeBoost: 32,
});

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function freezeRevision(revision: Revision): Revision {
  const copy: Record<string, number> = {};
  for (const key of Object.keys(revision).sort()) {
    const value = revision[key];
    if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`revision ${key} must be a non-negative safe integer`);
    }
    copy[key] = value;
  }
  return Object.freeze(copy);
}

export function createVoxelJob<TInput, TResult>(
  options: CreateVoxelJobOptions<TInput, TResult>,
): VoxelJob<TInput, TResult> {
  if (options.id.length === 0) throw new RangeError("job id must not be empty");
  requireFinite(options.distance, "distance");
  requireFinite(options.enqueuedAt, "enqueuedAt");
  const downstream = options.downstream ?? 0;
  if (!Number.isSafeInteger(downstream) || downstream < 0) {
    throw new RangeError("downstream must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(options.sequence) || options.sequence < 0) {
    throw new RangeError("sequence must be a non-negative safe integer");
  }
  const dependencies = Object.freeze((options.dependencies ?? []).map((dependency) => Object.freeze({
    id: dependency.id,
    type: dependency.type,
  })));
  const priority = Object.freeze({
    visible: options.visible,
    distance: Math.max(0, options.distance),
    downstream,
    enqueuedAt: options.enqueuedAt,
    sequence: options.sequence,
  });
  return Object.freeze({
    id: options.id,
    type: options.type,
    revision: freezeRevision(options.revision),
    dependencies,
    priority,
    input: options.input,
    commit: options.commit,
  });
}

export function calculateJobPriority(
  input: JobPriorityInput,
  now: number,
  policy: JobPriorityPolicy = DEFAULT_PRIORITY_POLICY,
): JobPriority {
  requireFinite(now, "now");
  if (!(policy.ageQuantumMs > 0) || !Number.isFinite(policy.ageQuantumMs)) {
    throw new RangeError("ageQuantumMs must be positive and finite");
  }
  if (!Number.isSafeInteger(policy.maxAgeBoost) || policy.maxAgeBoost < 0) {
    throw new RangeError("maxAgeBoost must be a non-negative safe integer");
  }
  const ageRank = Math.min(
    policy.maxAgeBoost,
    Math.max(0, Math.floor((now - input.enqueuedAt) / policy.ageQuantumMs)),
  );
  return Object.freeze({
    visibleRank: input.visible ? 0 : 1,
    distanceRank: Math.max(0, input.distance - ageRank),
    downstreamRank: -input.downstream,
    ageRank: -ageRank,
    sequence: input.sequence,
  });
}

export function compareJobPriority(left: JobPriority, right: JobPriority): number {
  return left.visibleRank - right.visibleRank ||
    left.distanceRank - right.distanceRank ||
    left.downstreamRank - right.downstreamRank ||
    left.ageRank - right.ageRank ||
    left.sequence - right.sequence;
}

interface PendingJob {
  readonly job: VoxelJob;
  readonly resolve: (outcome: JobOutcome) => void;
  state: "queued" | "running";
  controller?: AbortController;
}

function emptyCounts(): Record<VoxelJobType, number> {
  return { terrain: 0, mesh: 0, lighting: 0, bake: 0 };
}

function frozenCounts(source: Readonly<Record<VoxelJobType, number>>): JobTypeCounts {
  return Object.freeze({ ...source });
}

function failedOutcome(reason: JobFailureReason, error: unknown): JobOutcome {
  return Object.freeze({ status: "failed", reason, error });
}

export class VoxelJobScheduler {
  readonly #concurrency: number;
  readonly #executor: VoxelExecutor;
  readonly #validateRevision: VoxelSchedulerOptions["validateRevision"];
  readonly #policy: JobPriorityPolicy;
  readonly #now: () => number;
  readonly #pending = new Map<JobId, PendingJob>();
  readonly #outcomes = new Map<JobId, JobOutcome>();
  readonly #queued = emptyCounts();
  readonly #running = emptyCounts();
  readonly #assignments: Assignment[] = [];
  readonly #durations: number[] = [];
  #runningTotal = 0;
  #ready = 0;
  #stale = 0;
  #cancelled = 0;
  #failed = 0;
  #pumpQueued = false;

  public constructor(options: VoxelSchedulerOptions) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
      throw new RangeError("concurrency must be a positive safe integer");
    }
    const policy = {
      ageQuantumMs: options.priority?.ageQuantumMs ?? DEFAULT_PRIORITY_POLICY.ageQuantumMs,
      maxAgeBoost: options.priority?.maxAgeBoost ?? DEFAULT_PRIORITY_POLICY.maxAgeBoost,
    };
    calculateJobPriority({ visible: false, distance: 0, downstream: 0, enqueuedAt: 0, sequence: 0 }, 0, policy);
    this.#concurrency = options.concurrency;
    this.#executor = options.executor;
    this.#validateRevision = options.validateRevision;
    this.#policy = Object.freeze(policy);
    this.#now = options.now ?? Date.now;
  }

  public enqueue<TResult>(job: VoxelJob<unknown, TResult>): Promise<JobOutcome<TResult>> {
    if (this.#pending.has(job.id) || this.#outcomes.has(job.id)) {
      throw new Error(`duplicate job id ${job.id}`);
    }
    const promise = new Promise<JobOutcome>((resolve) => {
      this.#pending.set(job.id, {
        job: job as unknown as VoxelJob,
        resolve,
        state: "queued",
      });
      this.#queued[job.type]++;
    });
    this.#schedulePump();
    return promise as Promise<JobOutcome<TResult>>;
  }

  public cancel(id: JobId): boolean {
    const pending = this.#pending.get(id);
    if (pending === undefined) return false;
    if (pending.state === "running") {
      pending.controller?.abort();
      return true;
    }
    this.#queued[pending.job.type]--;
    this.#finish(pending, Object.freeze({ status: "cancelled" }));
    this.#cancelled++;
    this.#schedulePump();
    return true;
  }

  public outcome(id: JobId): JobOutcome | undefined {
    return this.#outcomes.get(id);
  }

  public metrics(): SchedulerMetrics {
    return Object.freeze({
      queued: frozenCounts(this.#queued),
      running: frozenCounts(this.#running),
      assignments: Object.freeze(this.#assignments.map((assignment) => Object.freeze({ ...assignment }))),
      durationsMs: Object.freeze([...this.#durations]),
      ready: this.#ready,
      stale: this.#stale,
      cancelled: this.#cancelled,
      failed: this.#failed,
    });
  }

  #schedulePump(): void {
    if (this.#pumpQueued) return;
    this.#pumpQueued = true;
    queueMicrotask(() => {
      this.#pumpQueued = false;
      this.#pump();
    });
  }

  #dependencyOutcome(job: VoxelJob): "ready" | "waiting" | JobOutcome {
    for (const dependency of job.dependencies) {
      const outcome = this.#outcomes.get(dependency.id);
      if (outcome === undefined) {
        if (!this.#pending.has(dependency.id)) {
          return failedOutcome("dependency", new Error(`unknown dependency ${dependency.id}`));
        }
        return "waiting";
      }
      if (outcome.status !== "succeeded") {
        return failedOutcome("dependency", new Error(`dependency ${dependency.id} ${outcome.status}`));
      }
    }
    return "ready";
  }

  #pump(): void {
    let madeProgress = true;
    while (madeProgress) {
      madeProgress = false;
      const ready: PendingJob[] = [];
      for (const pending of this.#pending.values()) {
        if (pending.state !== "queued") continue;
        const dependency = this.#dependencyOutcome(pending.job);
        if (dependency === "waiting") continue;
        if (dependency !== "ready") {
          this.#queued[pending.job.type]--;
          this.#failed++;
          this.#finish(pending, dependency);
          madeProgress = true;
          continue;
        }
        ready.push(pending);
      }
      this.#ready = ready.length;
      if (this.#runningTotal >= this.#concurrency || ready.length === 0) continue;
      const now = this.#now();
      ready.sort((left, right) => compareJobPriority(
        calculateJobPriority(left.job.priority, now, this.#policy),
        calculateJobPriority(right.job.priority, now, this.#policy),
      ));
      const slots = Math.min(this.#concurrency - this.#runningTotal, ready.length);
      for (let index = 0; index < slots; index++) {
        const pending = ready[index];
        if (pending !== undefined) this.#start(pending);
      }
      madeProgress = slots > 0;
    }
  }

  #start(pending: PendingJob): void {
    const controller = new AbortController();
    pending.state = "running";
    pending.controller = controller;
    this.#queued[pending.job.type]--;
    this.#running[pending.job.type]++;
    this.#runningTotal++;
    const startedAt = this.#now();
    this.#assignments.push(Object.freeze({
      id: pending.job.id,
      type: pending.job.type,
      sequence: pending.job.priority.sequence,
      assignedAt: startedAt,
    }));
    void this.#run(pending, controller, startedAt);
  }

  async #run(pending: PendingJob, controller: AbortController, startedAt: number): Promise<void> {
    let outcome: JobOutcome;
    try {
      const result = await this.#executor.execute(pending.job, { signal: controller.signal });
      if (controller.signal.aborted) {
        outcome = Object.freeze({ status: "cancelled" });
        this.#cancelled++;
      } else if (!await this.#validateRevision(pending.job.revision, pending.job)) {
        outcome = Object.freeze({ status: "stale", result });
        this.#stale++;
      } else {
        try {
          await pending.job.commit(result);
          outcome = Object.freeze({ status: "succeeded", result });
        } catch (error) {
          outcome = failedOutcome("commit", error);
          this.#failed++;
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        outcome = Object.freeze({ status: "cancelled" });
        this.#cancelled++;
      } else {
        outcome = failedOutcome("execution", error);
        this.#failed++;
      }
    }
    this.#durations.push(Math.max(0, this.#now() - startedAt));
    this.#running[pending.job.type]--;
    this.#runningTotal--;
    this.#finish(pending, outcome);
    this.#schedulePump();
  }

  #finish(pending: PendingJob, outcome: JobOutcome): void {
    this.#pending.delete(pending.job.id);
    this.#outcomes.set(pending.job.id, outcome);
    pending.resolve(outcome);
  }
}
