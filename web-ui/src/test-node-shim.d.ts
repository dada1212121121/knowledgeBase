/**
 * 测试里读真实字体 / 真实 deck 文件要用的几个 Node 接口的最小声明。
 *
 * 为什么不装 @types/node：项目没有这个依赖（vue-tsc 只加载 vite/client 的类型），测试之外的代码也不该用 Node 接口。
 * 这里只声明规格文件实际调用的签名，类型检查仍然对这些调用生效；vitest 运行时用的是真正的 Node 模块。
 */
declare module 'node:fs' {
  export function readFileSync(path: string): Uint8Array
  export function readdirSync(path: string): string[]
}
declare module 'node:path' {
  export function resolve(...parts: string[]): string
}

/** vitest 给每个测试文件注入 import.meta.dirname（Node 22 的同名属性） */
interface ImportMeta {
  readonly dirname: string
}
