// 版本对比窗口:逐行标出增删、统计行数、「只看改动」折叠未改动行。
import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { KbDialog } from '@kb-ui/index'
import VersionDiff from './VersionDiff.vue'

let wrapper: VueWrapper | null = null

function mountDiff(props: Partial<{ before: { label: string; text: string } | null; after: { label: string; text: string } | null; loading: boolean; error: string }> = {}) {
  wrapper = mount(VersionDiff, {
    props: {
      before: { label: 'v1 · bob', text: 'a\nb\nc' },
      after: { label: 'v2 · alice', text: 'a\nB\nc' },
      loading: false,
      error: '',
      ...props,
    },
    attachTo: document.body,
  })
  return wrapper
}

const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const $$ = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]

beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('VersionDiff', () => {
  it('标题说明对比的是哪两版,并给出增删统计', async () => {
    mountDiff()
    await flushPromises()
    expect($('[data-testid="version-diff"]')?.textContent).toContain('v1 · bob → v2 · alice')
    expect($('[data-testid="diff-summary"]')?.textContent).toBe('+1 行 · −1 行')
  })

  it('逐行渲染:未改动 / 删除 / 新增分别带类名和行号', async () => {
    mountDiff()
    await flushPromises()
    const lines = $$('[data-testid="diff-lines"] li')
    expect(lines.map((line) => line.className.match(/is-(\w+)/)?.[1])).toEqual(['equal', 'remove', 'add', 'equal'])
    expect(lines[1].textContent).toContain('b')
    expect(lines[2].textContent).toContain('B')
    // 删除行只有旧行号,新增行只有新行号
    expect(lines[1].querySelectorAll('.kb-diff-no')[0].textContent).toBe('2')
    expect(lines[1].querySelectorAll('.kb-diff-no')[1].textContent).toBe('')
    expect(lines[2].querySelectorAll('.kb-diff-no')[1].textContent).toBe('2')
  })

  it('两版一样时说明没有改动', async () => {
    mountDiff({ before: { label: 'v1', text: '一样' }, after: { label: 'v2', text: '一样' } })
    await flushPromises()
    expect($('[data-testid="diff-summary"]')?.textContent).toBe('+0 行 · −0 行')
    expect($('[data-testid="version-diff"]')?.textContent).toContain('两版内容一样')
  })

  it('「只看改动」把没改动的行折叠起来', async () => {
    const before = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join('\n')
    const after = before.replace('l15', 'l15 改过')
    mountDiff({ before: { label: 'v1', text: before }, after: { label: 'v2', text: after } })
    await flushPromises()
    const toggle = $<HTMLInputElement>('[data-testid="diff-only-changes"]')!
    const countBefore = $$('[data-testid="diff-lines"] li').length
    toggle.checked = true
    toggle.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
    const countAfter = $$('[data-testid="diff-lines"] li').length
    expect(countAfter).toBeLessThan(countBefore)
    expect($('[data-testid="diff-lines"]')?.textContent).toContain('未改动')
  })

  it('加载中 / 出错时不渲染行,给出提示', async () => {
    mountDiff({ loading: true, before: null, after: null })
    await flushPromises()
    expect($('[data-testid="version-diff"]')?.textContent).toContain('正在读取版本正文')
    expect($('[data-testid="diff-lines"]')).toBeNull()

    wrapper?.unmount()
    document.body.innerHTML = ''
    mountDiff({ error: '版本不存在', before: null, after: null })
    await flushPromises()
    expect($('[role="alert"]')?.textContent).toBe('版本不存在')
  })

  it('点关闭发出 close', async () => {
    const mounted = mountDiff()
    await flushPromises()
    $<HTMLButtonElement>('[data-testid="diff-close"]')!.click()
    await flushPromises()
    expect(mounted.emitted('close')).toHaveLength(1)
    expect(mounted.findComponent(KbDialog).exists()).toBe(true)
  })
})
