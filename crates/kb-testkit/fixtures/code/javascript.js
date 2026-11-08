// 示例 JavaScript 模块,用于分块测试。

import { readFile } from "node:fs/promises";

export class Config {
  constructor(name, port = 7878) {
    this.name = name;
    this.port = port;
    this.retries = 3;
  }

  describe() {
    return `${this.name}:${this.port}`;
  }

  withRetries(retries) {
    this.retries = retries;
    return this;
  }
}

export class Service {
  constructor(config) {
    this.config = config;
    this.running = false;
    this.counters = new Map();
  }

  start() {
    this.running = true;
    return this.running;
  }

  stop() {
    this.running = false;
    return this.running;
  }

  record(key) {
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  count(key) {
    return this.counters.get(key) ?? 0;
  }
}

export function fibonacci(n) {
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i += 1) {
    const next = a + b;
    a = b;
    b = next;
  }
  return a;
}

export function parsePort(value) {
  const port = Number.parseInt(String(value).trim(), 10);
  return Number.isNaN(port) ? null : port;
}

export const total = (values) => values.reduce((sum, value) => sum + value, 0);

export const defaultConfig = new Config("demo");

export async function loadConfig(path) {
  const text = await readFile(path, "utf8");
  const name = text.trim().split("\n")[0] ?? "demo";
  return new Config(name);
}

function helper(config) {
  const service = new Service(config);
  service.start();
  service.record("helper");
  return service.count("helper");
}

export function run(config = defaultConfig) {
  const value = fibonacci(10) + total([1, 2, 3]) + helper(config);
  return value;
}

export class Registry {
  constructor() {
    this.items = new Map();
  }

  add(key, value) {
    this.items.set(key, value);
    return this;
  }

  get(key) {
    return this.items.get(key) ?? null;
  }

  get size() {
    return this.items.size;
  }

  *keys() {
    yield* this.items.keys();
  }
}

export async function withRetries(task, retries = 3) {
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("task failed");
}

function makeCounter() {
  let count = 0;
  return function next() {
    count += 1;
    return count;
  };
}

export const counter = makeCounter();
