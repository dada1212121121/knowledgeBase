import { describe, expect, it } from 'vitest'
import { isChunkLoadError, mermaidFailureText } from './chunkError'

describe('懒加载文件拿不到', () => {
  it('各浏览器的动态 import 失败文案都认得', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/mermaid.core-abc.js'))).toBe(true)
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true)
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true)
    expect(isChunkLoadError('Loading chunk 12 failed.')).toBe(true)
  })
  it('流程图语法错误不算', () => {
    expect(isChunkLoadError(new Error('Parse error on line 2'))).toBe(false)
  })
  it('流程图失败文案：旧版本提示刷新，语法错误照旧写第一行', () => {
    expect(mermaidFailureText(new TypeError('Failed to fetch dynamically imported module: x'))).toContain('刷新')
    expect(mermaidFailureText(new Error('Parse error on line 2\nexpecting x'))).toBe('流程图语法有误:Parse error on line 2')
  })
})
