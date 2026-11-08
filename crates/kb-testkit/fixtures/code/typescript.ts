// 示例 TypeScript 模块,用于分块测试。

import { readFile } from "node:fs/promises";

export interface Config {
  name: string;
  port: number;
  retries?: number;
}

export type Status = "idle" | "running" | "stopped";

export interface Startable {
  start(): Status;
  stop(): Status;
  isRunning(): boolean;
}

export class Service implements Startable {
  private readonly config: Config;
  private status: Status = "idle";
  private readonly counters = new Map<string, number>();

  constructor(config: Config) {
    this.config = config;
  }

  start(): Status {
    this.status = "running";
    return this.status;
  }

  stop(): Status {
    this.status = "stopped";
    return this.status;
  }

  isRunning(): boolean {
    return this.status === "running";
  }

  record(key: string): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  count(key: string): number {
    return this.counters.get(key) ?? 0;
  }

  describe(): string {
    return `${this.config.name}:${this.config.port}`;
  }
}

export function fibonacci(n: number): number {
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i += 1) {
    const next = a + b;
    a = b;
    b = next;
  }
  return a;
}

export function parsePort(value: string): number | null {
  const port = Number.parseInt(value.trim(), 10);
  return Number.isNaN(port) ? null : port;
}

export const total = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0);

export const defaultConfig: Config = { name: "demo", port: 7878 };

export async function loadConfig(path: string): Promise<Config> {
  const text = await readFile(path, "utf8");
  const name = text.trim().split("\n")[0] ?? "demo";
  return { name, port: 7878 };
}

export function run(config: Config = defaultConfig): number {
  const service = new Service(config);
  service.start();
  service.record("run");
  const value = fibonacci(10) + total([1, 2, 3]);
  service.stop();
  return value;
}

export enum Mode {
  Fast = "fast",
  Safe = "safe",
}

export class Registry<T> {
  private readonly items = new Map<string, T>();

  add(key: string, value: T): this {
    this.items.set(key, value);
    return this;
  }

  get(key: string): T | null {
    return this.items.get(key) ?? null;
  }

  get size(): number {
    return this.items.size;
  }

  entries(): IterableIterator<[string, T]> {
    return this.items.entries();
  }
}

export function withMode<T>(mode: Mode, value: T): { mode: Mode; value: T } {
  return { mode, value };
}
