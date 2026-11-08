import { describe, expect, it } from 'vitest'
import { recoveryFor, rememberRecovery } from './recovery'

/**
 * 恢复副本的浏览器存储（IndexedDB）在 jsdom 里不存在：这里只验"没有存储时不抛错、明确返回失败"，
 * 页面上的下载链接（Blob URL）才是兜底，它的接线在 OfficeEditor 的 e2e 里验。
 */
describe('恢复副本存储', () => {
  it('没有 IndexedDB（隐私模式 / 测试环境）时静默失败，不抛错', async () => {
    expect(typeof indexedDB).toBe('undefined')
    expect(await rememberRecovery('c:a.pptx', new Uint8Array([1, 2, 3]))).toBe(false)
    expect(await recoveryFor('c:a.pptx')).toBeNull()
  })
})
