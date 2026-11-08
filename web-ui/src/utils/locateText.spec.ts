// 「在正文里找到」:Markdown 原文 → 可查找的显示文字;在被行内标记拆开的文本节点里找到并选中。
import { describe, expect, it } from 'vitest'
import { locateNeedle, selectTextIn } from './locateText'

describe('locateNeedle', () => {
  it('取第一行非空内容，去掉行首标记和行内写法', () => {
    expect(locateNeedle('\n\n## 部署步骤\n先备份')).toBe('部署步骤')
    expect(locateNeedle('- [ ] 写**发布**说明')).toBe('写发布说明')
    expect(locateNeedle('1. 运行 `kb search` 看 [文档](a.md)')).toBe('运行 kb search 看 文档')
    expect(locateNeedle('> 引用里的 ~~旧~~ 话')).toBe('引用里的 旧 话')
    expect(locateNeedle('强调 *这里* 不变 2*3')).toBe('强调 这里 不变 2*3')
    expect(locateNeedle('   ')).toBe('')
  })
})

describe('selectTextIn', () => {
  it('跨文本节点的文字也能选中', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>守护进程<strong>重启期间</strong>，连接失败直接退出。</p>'
    document.body.append(root)
    expect(selectTextIn(root, '重启期间，连接失败')).toBe(true)
    expect(document.getSelection()?.toString()).toBe('重启期间，连接失败')
    root.remove()
  })

  it('找不到返回 false，不改动现有选区', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>正文</p>'
    document.body.append(root)
    expect(selectTextIn(root, '不存在的话')).toBe(false)
    expect(selectTextIn(root, '')).toBe(false)
    root.remove()
  })
})
