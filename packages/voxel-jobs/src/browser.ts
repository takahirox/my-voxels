import type {
  JobExecutionContext,
  VoxelExecutor,
  VoxelJob,
  VoxelJobType,
} from "./index.js";

export type StructuredClonePrimitive = null | undefined | boolean | number | bigint | string;
export type StructuredCloneValue =
  | StructuredClonePrimitive
  | ArrayBuffer
  | ArrayBufferView
  | readonly StructuredCloneValue[]
  | object;

export interface WorkerMessageEvent {
  readonly data: unknown;
}

export interface WorkerErrorEvent {
  readonly error?: unknown;
  readonly message?: string;
}

export interface WorkerLike {
  postMessage(message: StructuredCloneValue, transfer?: readonly ArrayBuffer[]): void;
  addEventListener(type: "message", listener: (event: WorkerMessageEvent) => void): void;
  addEventListener(type: "error", listener: (event: WorkerErrorEvent) => void): void;
  removeEventListener(type: "message", listener: (event: WorkerMessageEvent) => void): void;
  removeEventListener(type: "error", listener: (event: WorkerErrorEvent) => void): void;
  terminate(): void;
}

export interface BrowserWorkerRequest {
  readonly id: string;
  readonly type: VoxelJobType;
  readonly input: StructuredCloneValue;
}

export type BrowserWorkerResponse =
  | Readonly<{ id: string; ok: true; result: StructuredCloneValue }>
  | Readonly<{ id: string; ok: false; error: Readonly<{ message: string; name?: string }> }>;

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly abort: () => void;
}

let executorSequence = 0;

function protocolError(message: string): Error {
  return new Error(`voxel worker protocol error: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseResponse(value: unknown): BrowserWorkerResponse {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 ||
    typeof value.ok !== "boolean") {
    throw protocolError("invalid response envelope");
  }
  if (value.ok) {
    if (!("result" in value)) throw protocolError("successful response has no result");
    return { id: value.id, ok: true, result: value.result as StructuredCloneValue };
  }
  if (!isRecord(value.error) || typeof value.error.message !== "string") {
    throw protocolError("failed response has no error message");
  }
  if (value.error.name !== undefined && typeof value.error.name !== "string") {
    throw protocolError("failed response has an invalid error name");
  }
  return {
    id: value.id,
    ok: false,
    error: value.error.name === undefined
      ? { message: value.error.message }
      : { message: value.error.message, name: value.error.name },
  };
}

export function collectTransferableArrayBuffers(value: unknown): readonly ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const visited = new WeakSet<object>();
  const visit = (current: unknown): void => {
    if (current === null || typeof current !== "object") return;
    if (current instanceof ArrayBuffer) {
      buffers.add(current);
      return;
    }
    if (ArrayBuffer.isView(current)) {
      if (current.buffer instanceof ArrayBuffer) buffers.add(current.buffer);
      return;
    }
    if (visited.has(current)) return;
    visited.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    for (const item of Object.values(current)) visit(item);
  };
  visit(value);
  return Object.freeze([...buffers]);
}

export class BrowserWorkerExecutor implements VoxelExecutor {
  readonly #worker: WorkerLike;
  readonly #prefix = `voxel-${++executorSequence}-`;
  readonly #pending = new Map<string, PendingRequest>();
  #nextId = 0;
  #disposed = false;

  readonly #messageListener = (event: WorkerMessageEvent): void => {
    let response: BrowserWorkerResponse;
    try {
      response = parseResponse(event.data);
    } catch (error) {
      this.#rejectAll(error);
      return;
    }
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return;
    this.#pending.delete(response.id);
    pending.signal.removeEventListener("abort", pending.abort);
    if (response.ok) {
      pending.resolve(response.result);
    } else {
      const error = new Error(response.error.message);
      error.name = response.error.name ?? "WorkerError";
      pending.reject(error);
    }
  };

  readonly #errorListener = (event: WorkerErrorEvent): void => {
    this.#rejectAll(event.error ?? new Error(event.message ?? "voxel worker failed"));
  };

  public constructor(worker: WorkerLike) {
    this.#worker = worker;
    worker.addEventListener("message", this.#messageListener);
    worker.addEventListener("error", this.#errorListener);
  }

  public execute<TResult>(
    job: VoxelJob<unknown, TResult>,
    context: JobExecutionContext,
  ): Promise<TResult> {
    if (this.#disposed) return Promise.reject(new Error("browser worker executor is disposed"));
    if (context.signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
    const id = `${this.#prefix}${++this.#nextId}`;
    const request: BrowserWorkerRequest = { id, type: job.type, input: job.input as StructuredCloneValue };
    return new Promise<TResult>((resolve, reject) => {
      const abort = (): void => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        reject(new DOMException("aborted", "AbortError"));
      };
      this.#pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        signal: context.signal,
        abort,
      });
      context.signal.addEventListener("abort", abort, { once: true });
      try {
        this.#worker.postMessage(request, collectTransferableArrayBuffers(request.input));
      } catch (error) {
        this.#pending.delete(id);
        context.signal.removeEventListener("abort", abort);
        reject(error);
      }
    });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#worker.removeEventListener("message", this.#messageListener);
    this.#worker.removeEventListener("error", this.#errorListener);
    this.#rejectAll(new Error("browser worker executor disposed"));
    this.#worker.terminate();
  }

  #rejectAll(error: unknown): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.signal.removeEventListener("abort", pending.abort);
      pending.reject(error);
    }
  }
}

export function workerCountForHardwareConcurrency(hardwareConcurrency: number | undefined): number {
  const logicalCores = Number.isFinite(hardwareConcurrency) && hardwareConcurrency !== undefined
    ? Math.floor(hardwareConcurrency)
    : 1;
  return Math.max(1, Math.min(6, logicalCores - 2));
}

export class BrowserWorkerPool implements VoxelExecutor {
  readonly #executors: readonly BrowserWorkerExecutor[];
  #next = 0;
  #disposed = false;

  public constructor(workers: readonly WorkerLike[]) {
    if (workers.length === 0) throw new RangeError("browser worker pool requires at least one worker");
    this.#executors = Object.freeze(workers.map((worker) => new BrowserWorkerExecutor(worker)));
  }

  public get count(): number {
    return this.#executors.length;
  }

  public execute<TResult>(
    job: VoxelJob<unknown, TResult>,
    context: JobExecutionContext,
  ): Promise<TResult> {
    if (this.#disposed) return Promise.reject(new Error("browser worker pool is disposed"));
    const executor = this.#executors[this.#next % this.#executors.length]!;
    this.#next = (this.#next + 1) % this.#executors.length;
    return executor.execute(job, context);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const executor of this.#executors) executor.dispose();
  }
}
