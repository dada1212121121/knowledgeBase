// 上传队列:总进度按字节加权、阶段和已送字节写进条目、失败清掉阶段。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const hold: { release: () => void; fail: (error: Error) => void } = { release: () => undefined, fail: () => undefined }
let script: (options: {
  onProgress?: (percent: number) => void
  onBytes?: (sent: number, total: number) => void
  onPhase?: (phase: 'hashing' | 'checking' | 'sending' | 'merging') => void
}) => void = () => undefined

vi.mock('@/api/upload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/upload')>()
  return {
    ...actual,
    uploadFile: vi.fn(
      (_file: File, options: Parameters<typeof script>[0]) =>
        new Promise((resolve, reject) => {
          script(options)
          hold.release = () => resolve({ upload_id: 'u', batch_id: 'b', collection: 'c', files: [], skipped: [], job_id: null })
          hold.fail = (error) => reject(error)
        }),
    ),
  }
})

import { useUploadStore } from './upload'

const fileOf = (name: string, size: number) => new File([new Uint8Array(size)], name)

describe('上传队列的进度', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    script = () => undefined
  })

  it('总进度按字节加权:大文件传了一半,十个小文件还没动,总进度接近一半而不是 5%', async () => {
    const store = useUploadStore()
    store.enqueue([fileOf('big.bin', 1000)], { collection: 'c' })
    store.enqueue(Array.from({ length: 10 }, (_, index) => fileOf(`s${index}.txt`, 1)), { collection: 'c' })
    // 并发上限 2:big 和 s0 在跑,其余排队
    const big = store.items[0]!
    big.sent = 500
    big.percent = 50
    expect(store.totalBytes).toBe(1010)
    expect(store.sentBytes).toBe(500)
    expect(store.summary.percent).toBe(Math.round((500 / 1010) * 100))
    // 按文件数平均会是 (50 + 0 × 10) / 11 ≈ 5%,这里要明确不是
    expect(store.summary.percent).toBeGreaterThan(40)
  })

  it('完成和跳过的文件按全部送出算', () => {
    const store = useUploadStore()
    store.enqueue([fileOf('a.txt', 100), fileOf('b.txt', 300)], { collection: 'c' })
    store.items[0]!.state = 'done'
    store.items[1]!.state = 'skipped'
    expect(store.sentBytes).toBe(400)
    expect(store.summary.percent).toBe(100)
  })

  it('阶段和已送字节会写进条目,完成后清掉阶段、字节补满', async () => {
    const store = useUploadStore()
    script = (options) => {
      options.onPhase?.('hashing')
      options.onPhase?.('sending')
      options.onBytes?.(30, 100)
      options.onProgress?.(30)
    }
    store.enqueue([fileOf('a.bin', 100)], { collection: 'c' })
    const item = store.items[0]!
    expect(item.phase).toBe('sending')
    expect(item.sent).toBe(30)
    expect(item.percent).toBe(30)
    hold.release()
    await vi.waitFor(() => expect(item.state).toBe('done'))
    expect(item.phase).toBeUndefined()
    expect(item.sent).toBe(100)
    expect(item.percent).toBe(100)
  })

  it('失败后阶段清掉,已送字节保留(界面据此显示传到哪儿断的)', async () => {
    const store = useUploadStore()
    script = (options) => {
      options.onPhase?.('sending')
      options.onBytes?.(40, 100)
    }
    store.enqueue([fileOf('a.bin', 100)], { collection: 'c' })
    const item = store.items[0]!
    hold.fail(new Error('网络中断'))
    await vi.waitFor(() => expect(item.state).toBe('failed'))
    expect(item.phase).toBeUndefined()
    expect(item.sent).toBe(40)
    expect(item.error).toBe('网络中断')
  })
})
