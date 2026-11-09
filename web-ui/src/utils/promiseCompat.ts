// PDF.js 6 直接调用 `Promise.withResolvers` / `Promise.try`；Chrome 114、部分国产浏览器
// （QuarkPC、旧版 360 等）还没有这两个 API。缺失时 PDF 模块在动态加载阶段就抛 TypeError，
// 查看器只能显示笼统的“PDF 渲染失败”。这里在加载 PDF.js 之前补齐，避免把浏览器版本问题
// 误报成文件损坏。

type Resolvers<T> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

type PromiseCompat = {
  withResolvers?: <T>() => Resolvers<T>
  try?: <T, A extends unknown[]>(fn: (...args: A) => T | PromiseLike<T>, ...args: A) => Promise<T>
}

/** 补齐 PDF.js 依赖、但旧浏览器缺失的 Promise 静态方法；重复调用无副作用。 */
export function installPromiseCompat(): void {
  const Ctor = Promise as unknown as PromiseCompat

  if (typeof Ctor.withResolvers !== 'function') {
    Ctor.withResolvers = function <T>(): Resolvers<T> {
      let resolve!: Resolvers<T>['resolve']
      let reject!: Resolvers<T>['reject']
      const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }
  }

  if (typeof Ctor.try !== 'function') {
    Ctor.try = function <T, A extends unknown[]>(
      fn: (...args: A) => T | PromiseLike<T>,
      ...args: A
    ): Promise<T> {
      // 与 Promise.try 规范一致：同步异常也转成 rejected promise。
      return new Promise<T>((resolve, reject) => {
        try {
          resolve(fn(...args))
        } catch (error) {
          reject(error)
        }
      })
    }
  }
}
