export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

export function formatDuration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(2)} s`;
}

export function average(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export class FrameSampler {
  readonly #frames: number[] = [];
  push(milliseconds: number): void {
    if (Number.isFinite(milliseconds) && milliseconds > 0) this.#frames.push(milliseconds);
    if (this.#frames.length > 90) this.#frames.shift();
  }
  get frameMs(): number | undefined { return average(this.#frames); }
  get fps(): number | undefined {
    const frame = this.frameMs;
    return frame === undefined ? undefined : 1_000 / frame;
  }
}
