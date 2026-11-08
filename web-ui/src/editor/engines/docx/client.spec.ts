import { afterEach, describe, expect, it, vi } from 'vitest'

// 引擎模块由页面自己下载编译（docxWasm.ts），这里换成可控的假实现：测的是「客户端把它交给 Worker」这一步
const moduleSource = vi.hoisted(() => ({ get: undefined as undefined | (() => Promise<WebAssembly.Module>) }))
vi.mock('../docxWasm', () => ({ docxEditWasmModule: () => moduleSource.get!() }))

import { KbDocxWorkerClient } from './client'

/** 最小的合法 wasm 模块（只有魔数和版本号），能被 `new WebAssembly.Module` 接受 */
const EMPTY_WASM = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])

function fakePort() {
  const posted: Array<{ type: string; id?: number; hostModule?: boolean; module?: unknown }> = []
  return {
    posted,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null,
    onmessageerror: null,
    postMessage: (message: (typeof posted)[number]) => void posted.push(message),
    terminate: vi.fn(),
  }
}

describe('KbDocxWorkerClient.warm', () => {
  const clients: KbDocxWorkerClient[] = []
  const open = () => {
    const port = fakePort()
    const client = new KbDocxWorkerClient(port as never)
    clients.push(client)
    return { port, client }
  }
  afterEach(() => {
    for (const client of clients.splice(0)) client.destroy()
    vi.restoreAllMocks()
  })

  it('先发 warm 请求，再把页面里编译好的模块原样发给 Worker，Worker 应答后才算预热完成', async () => {
    const module = new WebAssembly.Module(EMPTY_WASM)
    moduleSource.get = () => Promise.resolve(module)
    const { port, client } = open()
    let done = false
    const warm = client.prewarm().then(() => (done = true))
    await vi.waitFor(() => expect(port.posted.map((message) => message.type)).toEqual(['warm', 'editModule']))
    expect(port.posted[0]).toMatchObject({ type: 'warm', hostModule: true })
    // 同一个 Module 对象：Worker 不会再自己下载、编译
    expect(port.posted[1]!.module).toBe(module)
    expect(done).toBe(false)
    port.onmessage?.({ data: { id: port.posted[0]!.id, ok: true } })
    await warm
    expect(done).toBe(true)
  })

  it('模块拿不到（下载失败）时发 null，让 Worker 退回自己取，而不是卡住 10 秒', async () => {
    moduleSource.get = () => Promise.reject(new Error('网络断了'))
    const { port, client } = open()
    void client.prewarm().catch(() => undefined)
    await vi.waitFor(() => expect(port.posted.map((message) => message.type)).toEqual(['warm', 'editModule']))
    expect(port.posted[1]!.module).toBeNull()
  })

  it('不自己发网络请求：下载只经页面共用的 docxEditWasmModule', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    moduleSource.get = () => Promise.resolve(new WebAssembly.Module(EMPTY_WASM))
    const { port, client } = open()
    void client.prewarm().catch(() => undefined)
    await vi.waitFor(() => expect(port.posted.length).toBe(2))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('两个 Worker（编辑会话与无损探针）拿到的是同一份模块', async () => {
    const module = new WebAssembly.Module(EMPTY_WASM)
    moduleSource.get = vi.fn(() => Promise.resolve(module))
    const first = open()
    const second = open()
    void first.client.prewarm().catch(() => undefined)
    void second.client.prewarm().catch(() => undefined)
    await vi.waitFor(() => expect(first.port.posted.length + second.port.posted.length).toBe(4))
    expect(first.port.posted[1]!.module).toBe(second.port.posted[1]!.module)
  })
})
