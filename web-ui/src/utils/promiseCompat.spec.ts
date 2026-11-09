import { afterEach, describe, expect, it } from 'vitest'
import { installPromiseCompat } from './promiseCompat'

type Compat = {
  withResolvers?: <T>() => {
    promise: Promise<T>
    resolve: (value: T | PromiseLike<T>) => void
    reject: (reason?: unknown) => void
  }
  try?: <T, A extends unknown[]>(fn: (...args: A) => T | PromiseLike<T>, ...args: A) => Promise<T>
}

const Native = Promise as unknown as Compat
const hadWithResolvers = Object.prototype.hasOwnProperty.call(Promise, 'withResolvers')
const hadTry = Object.prototype.hasOwnProperty.call(Promise, 'try')
const nativeWithResolvers = Native.withResolvers
const nativeTry = Native.try

function removeNative() {
  Reflect.deleteProperty(Promise, 'withResolvers')
  Reflect.deleteProperty(Promise, 'try')
}

afterEach(() => {
  // 测试会临时删掉全局静态方法；不恢复会污染同进程里的其它用例。
  if (hadWithResolvers) Native.withResolvers = nativeWithResolvers
  else Reflect.deleteProperty(Promise, 'withResolvers')
  if (hadTry) Native.try = nativeTry
  else Reflect.deleteProperty(Promise, 'try')
})

describe('installPromiseCompat', () => {
  it('补齐 withResolvers，并保留 resolve / reject 语义', async () => {
    removeNative()
    installPromiseCompat()

    const ok = Native.withResolvers!<number>()
    ok.resolve(42)
    await expect(ok.promise).resolves.toBe(42)

    const failed = Native.withResolvers!<number>()
    failed.reject(new Error('boom'))
    await expect(failed.promise).rejects.toThrow('boom')
  })

  it('补齐 Promise.try：同步异常也变成 rejected，参数原样透传', async () => {
    removeNative()
    installPromiseCompat()

    await expect(Native.try!((a: number, b: number) => a + b, 2, 3)).resolves.toBe(5)
    await expect(
      Native.try!(() => {
        throw new Error('sync boom')
      }),
    ).rejects.toThrow('sync boom')
  })

  it('重复调用不覆盖已有实现', () => {
    removeNative()
    installPromiseCompat()
    const first = Native.withResolvers
    installPromiseCompat()
    expect(Native.withResolvers).toBe(first)
  })
})
