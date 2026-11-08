// 添加数据 · 网页来源的「AI 规范化」:默认值跟后端走,开着时可写提取要求(留空 = 自动);
// 关掉不传提取要求;没有「自动提炼与审核」功能点时整块不出现,也不传这两个参数。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))

import { useSessionStore } from '@/stores/session'
import AddDataDialog from './AddDataDialog.vue'

let wrapper: VueWrapper | null = null
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const button = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.includes(text))!

async function open(props: Record<string, unknown> = {}) {
  wrapper = mount(AddDataDialog, {
    props: { collections: ['_global'], kinds: ['web', 'upload'], initialKind: 'web', initialUri: 'https://shop.example/p/1', ...props },
    attachTo: document.body,
  })
  await flushPromises()
}
async function typeInto(selector: string, value: string) {
  const input = $<HTMLInputElement | HTMLTextAreaElement>(`${selector} textarea, ${selector} input, textarea${selector}, input${selector}`)!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}
async function toggleAi() {
  $<HTMLElement>('[data-testid=add-ai-extract] [role=switch]')!.click()
  await flushPromises()
}
async function submit() {
  button('添加').click()
  await flushPromises()
}
const sent = () => callCapability.mock.calls.find((call) => call[0] === 'add_source')?.[1] as Record<string, unknown>

beforeEach(() => {
  setActivePinia(createPinia())
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  callCapability.mockReset()
  callCapability.mockResolvedValue({ source: { id: 's1' } })
})

describe('添加数据 · 网页 AI 规范化', () => {
  it('默认打开、提取要求留空:按自动整理提交', async () => {
    await open()
    expect($('[data-testid=add-ai-extract] [role=switch]')!.getAttribute('aria-checked')).toBe('true')
    expect($('[data-testid=add-extract-prompt]')).not.toBeNull()
    await submit()
    expect(sent()).toMatchObject({ kind: 'web', uri: 'https://shop.example/p/1', ai_extract: true, extract_prompt: '' })
  })

  it('写了提取要求:去掉首尾空白后提交', async () => {
    await open()
    await typeInto('[data-testid=add-extract-prompt]', '  只要产品名称、价格和规格参数  ')
    await submit()
    expect(sent()).toMatchObject({ ai_extract: true, extract_prompt: '只要产品名称、价格和规格参数' })
  })

  it('默认值跟后端:后端说默认关就是关;关着时不显示提取要求,提交的要求为空', async () => {
    await open({ aiExtractDefault: false })
    expect($('[data-testid=add-ai-extract] [role=switch]')!.getAttribute('aria-checked')).toBe('false')
    expect($('[data-testid=add-extract-prompt]')).toBeNull()
    await submit()
    expect(sent()).toMatchObject({ ai_extract: false, extract_prompt: '' })
  })

  it('提取要求超过 2000 字:标出原因,「添加」不可点', async () => {
    await open()
    await typeInto('[data-testid=add-extract-prompt]', '要'.repeat(2001))
    expect($('[data-testid=add-extract-prompt-error]')!.textContent).toContain('2000')
    expect(button('添加').disabled).toBe(true)
    // 关掉 AI 规范化后要求不再提交,也就不再拦着
    await toggleAi()
    expect(button('添加').disabled).toBe(false)
  })

  it('没有「自动提炼与审核」功能点:整块不出现,也不传这两个参数(后端按关处理)', async () => {
    const session = useSessionStore()
    session.loaded = true
    session.features = new Set(['sources.web'])
    await open()
    expect($('[data-testid=add-ai-extract]')).toBeNull()
    await submit()
    expect(sent()).not.toHaveProperty('ai_extract')
    expect(sent()).not.toHaveProperty('extract_prompt')
  })

  it('只有网页来源有这一块', async () => {
    await open({ initialKind: 'upload' })
    expect($('[data-testid=add-ai-extract]')).toBeNull()
  })
})
