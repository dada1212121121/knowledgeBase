// 示例 JavaScript 模块。

export class Config {
  constructor(name) {
    this.name = name;
  }

  describe() {
    return `config:${this.name}`;
  }
}

export function run(config) {
  return config.describe().length;
}
