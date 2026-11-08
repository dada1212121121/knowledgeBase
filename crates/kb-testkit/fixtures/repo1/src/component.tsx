// 示例 TypeScript 模块。
export interface Config {
  name: string;
  retries?: number;
}

export class Runner {
  constructor(private readonly config: Config) {}

  run(): number {
    return this.config.name.length + (this.config.retries ?? 0);
  }
}

export const defaultConfig: Config = { name: "demo" };
