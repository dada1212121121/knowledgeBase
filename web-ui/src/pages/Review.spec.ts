// 审核收件箱:状态(加载 / 空 / 报错)、卡片信息层次、单条与批量操作(含部分失败)、「⋯」里的驳回、正文折叠、分页加载。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { KbSelect } from '@kb-ui/index'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /></div>' } }))
// 确认框:应用根上才有它的宿主组件,这里换成可控的 ask——和真实的一样,答应了就执行 action(批量驳回把逐条请求放在 action 里)
const confirmState = vi.hoisted(() => ({ answer: true, calls: [] as { title: string; message?: string; confirmText?: string }[] }))
vi.mock('@kb-ui/index', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useConfirm: () => ({
    ask: async (options: { title: string; message?: string; confirmText?: string; action?: () => Promise<unknown> }) => {
      confirmState.calls.push(options)
      if (!confirmState.answer) return false
      await options.action?.()
      return true
    },
  }),
}))
import { toasts } from '@kb-ui/components/useToast'

import { CapabilityError } from '@/api/client'
import { useSessionStore } from '@/stores/session'
import Review from './Review.vue'

const NOW = Date.now()
const draft = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  collection: 'proj_sampleapp',
  project: 'SampleApp',
  title: `草稿 ${id}`,
  body_md: '短正文',
  kind: 'decision',
  tags: ['sidecar'],
  related_paths: ['backend/a.rs'],
  evidence: ['+ let delay = 1;'],
  state: 'pending',
  score: 0.86,
  decision: 'approve',
  reasons: ['具体且与证据一致'],
  duplicate_of: null,
  insight_id: null,
  created_at: NOW - 3_600_000,
  decided_at: null,
  ...extra,
})
const PENDING = [draft('d1'), draft('d2', { score: 0.5, decision: 'revise' }), draft('d3', { score: null, decision: null, reasons: [], evidence: [] })]
const COUNTS = { pending: 3, approved: 11, rejected: 3, duplicate: 4 }

let replies: Record<string, unknown> = {}
let reviewFail: Record<string, string> = {}
function backend(overrides: Record<string, unknown> = {}) {
  reviewFail = {}
  replies = { list_drafts: { drafts: PENDING, total: 3, counts: COUNTS }, review_draft: { insight_id: 'ins_1', batch_id: 'b1' }, ...overrides }
  callCapability.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
    if (name === 'review_draft' && args && reviewFail[String(args.id)]) throw new CapabilityError(reviewFail[String(args.id)]!, 'conflict', 409)
    const reply = replies[name]
    if (reply instanceof Error) throw reply
    return reply ?? {}
  })
}
const calls = (name: string) => callCapability.mock.calls.filter((call) => call[0] === name)
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const $$ = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]
const cardText = (id: string) => $(`[data-id=${id}]`)!.textContent!.replace(/\s+/g, ' ')

let wrapper: VueWrapper | null = null
async function open() {
  wrapper = mount(Review, { attachTo: document.body })
  await flushPromises()
}
const toastTexts = () => toasts.map((entry) => entry.message)

beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  callCapability.mockReset()
  confirmState.answer = true
  confirmState.calls = []
  toasts.splice(0)
  setActivePinia(createPinia())
  backend()
})

describe('Review · 状态', () => {
  it('加载中是骨架屏;出来后每条候选笔记一张卡片', async () => {
    callCapability.mockImplementation(() => new Promise(() => undefined))
    wrapper = mount(Review, { attachTo: document.body })
    await flushPromises()
    expect($('[data-testid=review-loading]')).not.toBeNull()
    wrapper.unmount()
    document.body.innerHTML = ''
    backend()
    await open()
    expect($$('[data-testid=draft-card]')).toHaveLength(3)
  })

  it('读取失败:说清楚并给「重新加载」,点了恢复', async () => {
    backend({ list_drafts: new CapabilityError('internal: boom', 'internal', 500) })
    await open()
    expect($('[data-testid=review-error]')!.textContent).toContain('没能读取收件箱')
    backend()
    $<HTMLButtonElement>('[data-testid=review-error] button')!.click()
    await flushPromises()
    expect($('[data-testid=review-error]')).toBeNull()
    expect($$('[data-testid=draft-card]')).toHaveLength(3)
  })

  it('没有待审:给下一步', async () => {
    backend({ list_drafts: { drafts: [], total: 0, counts: { pending: 0, approved: 0, rejected: 0, duplicate: 0 } } })
    await open()
    expect($('[data-testid=review-empty]')!.textContent).toContain('没有待审的候选笔记')
  })
})

describe('Review · 卡片层次', () => {
  it('标题、类型 / 来源 / 时间、摘要、AI 意见、依据、标签、操作各就各位', async () => {
    await open()
    const text = cardText('d1')
    for (const word of ['草稿 d1', '待审', '决策', 'SampleApp', '短正文', 'AI 86 分', 'AI 建议通过', '具体且与证据一致', '依据', 'sidecar', 'backend/a.rs', '通过', '修订后通过']) expect(text, word).toContain(word)
  })

  it('没有 AI 结论的草稿直说,不写 0 分;AI 评分低于 70 的用警告色提醒', async () => {
    await open()
    expect(cardText('d3')).toContain('没有 AI 审核结论')
    expect(cardText('d3')).not.toContain('AI 0 分')
    expect(cardText('d2')).toContain('AI 50 分')
    expect(cardText('d2')).toContain('AI 建议修订')
  })

  it('依据默认折叠(没有依据就没有这一项)', async () => {
    await open()
    const details = $<HTMLDetailsElement>('[data-id=d1] [data-testid=draft-evidence]')!
    expect(details.open).toBe(false)
    expect($('[data-id=d3] [data-testid=draft-evidence]')).toBeNull()
  })

  it('长正文折叠成几行,「展开全文 / 收起」切换;短正文没有这个按钮', async () => {
    backend({ list_drafts: { drafts: [draft('long', { body_md: '很长的正文。'.repeat(60) }), draft('short')], total: 2, counts: COUNTS } })
    await open()
    expect($('[data-id=long] .kb-rv-body')!.classList.contains('is-clamped')).toBe(true)
    expect($('[data-id=short] [data-testid=draft-expand]')).toBeNull()
    const button = $<HTMLButtonElement>('[data-id=long] [data-testid=draft-expand]')!
    expect(button.textContent).toContain('展开全文')
    button.click()
    await flushPromises()
    expect($('[data-id=long] .kb-rv-body')!.classList.contains('is-clamped')).toBe(false)
    expect($('[data-id=long] [data-testid=draft-expand]')!.textContent).toContain('收起')
  })

  it('已通过的草稿只读:没有操作按钮,写明转正成了哪条', async () => {
    backend({ list_drafts: { drafts: [draft('ok', { state: 'approved', insight_id: 'ins_9' })], total: 1, counts: COUNTS } })
    await open()
    expect($('[data-id=ok] [data-testid=draft-approve]')).toBeNull()
    expect($('[data-id=ok] [data-testid=draft-check]')).toBeNull()
    expect(cardText('ok')).toContain('已转正为 ins_9')
  })
})

describe('Review · 单条操作', () => {
  it('通过:发 approve 并刷新', async () => {
    await open()
    $<HTMLButtonElement>('[data-id=d1] [data-testid=draft-approve]')!.click()
    await flushPromises()
    expect(calls('review_draft')[0]![1]).toEqual({ id: 'd1', decision: 'approve' })
    expect(calls('list_drafts').length).toBeGreaterThanOrEqual(2)
  })

  it('驳回收在「⋯」里,不和「通过」并排;选「驳回」要确认,确认后才发请求', async () => {
    await open()
    expect($('[data-id=d1] footer')!.textContent).not.toContain('驳回')
    const more = wrapper!.findAll('[data-id=d1] [data-testid=draft-more]')
    expect(more).toHaveLength(1)
    confirmState.answer = false
    wrapper!.findAllComponents(KbSelect)[0]!.vm.$emit('update:modelValue', 'reject')
    await flushPromises()
    expect(confirmState.calls[0]!.title).toContain('驳回「草稿 d1」')
    expect(calls('review_draft')).toHaveLength(0) // 没确认就不发请求
    confirmState.answer = true
    wrapper!.findAllComponents(KbSelect)[0]!.vm.$emit('update:modelValue', 'reject')
    await flushPromises()
    expect(calls('review_draft')[0]![1]).toEqual({ id: 'd1', decision: 'reject', never_extract: false })
  })

  it('「驳回并不再提炼」带 never_extract', async () => {
    await open()
    wrapper!.findAllComponents(KbSelect)[0]!.vm.$emit('update:modelValue', 'never')
    await flushPromises()
    expect(confirmState.calls[0]!.confirmText).toBe('驳回并不再提炼')
    expect(calls('review_draft')[0]![1]).toEqual({ id: 'd1', decision: 'reject', never_extract: true })
  })
})

describe('Review · 多选与批量', () => {
  it('选中几条:批量条出现并写明数量,卡片高亮;取消选择收起', async () => {
    await open()
    expect($('[data-testid=batchbar]')).toBeNull()
    $<HTMLInputElement>('[data-id=d1] [data-testid=draft-check]')!.click()
    $<HTMLInputElement>('[data-id=d2] [data-testid=draft-check]')!.click()
    await flushPromises()
    expect($('[data-testid=batchbar]')!.textContent).toContain('已选 2 项')
    expect($('[data-id=d1]')!.classList.contains('is-selected')).toBe(true)
    expect($('[data-testid=batch-approve]')!.textContent).toContain('通过 2 条')
    ;[...$('[data-testid=batchbar]')!.querySelectorAll('button')].find((b) => b.textContent!.includes('取消选择'))!.click()
    await flushPromises()
    expect($('[data-testid=batchbar]')).toBeNull()
  })

  it('全选本页只选能审的', async () => {
    backend({ list_drafts: { drafts: [draft('a'), draft('b', { state: 'duplicate' }), draft('c', { state: 'approved' })], total: 3, counts: COUNTS } })
    await open()
    $<HTMLInputElement>('[data-testid=review-all]')!.click()
    await flushPromises()
    expect($('[data-testid=batchbar]')!.textContent).toContain('已选 2 项')
  })

  it('批量通过:逐条 approve,全部成功时提示条数并清空选择', async () => {
    await open()
    ;['d1', 'd2'].forEach((id) => $<HTMLInputElement>(`[data-id=${id}] [data-testid=draft-check]`)!.click())
    await flushPromises()
    $<HTMLButtonElement>('[data-testid=batch-approve]')!.click()
    await flushPromises()
    expect(calls('review_draft').map((call) => (call[1] as { id: string }).id)).toEqual(['d1', 'd2'])
    expect(calls('review_draft').every((call) => (call[1] as { decision: string }).decision === 'approve')).toBe(true)
    expect(toastTexts()).toContain('已通过 2 条')
    expect($('[data-testid=batchbar]')).toBeNull()
  })

  it('批量通过时某一条失败:后面的照常处理,结果如实说明成功几条、失败几条和原因', async () => {
    await open()
    ;['d1', 'd2', 'd3'].forEach((id) => $<HTMLInputElement>(`[data-id=${id}] [data-testid=draft-check]`)!.click())
    await flushPromises()
    reviewFail = { d2: '草稿已被别人处理' }
    $<HTMLButtonElement>('[data-testid=batch-approve]')!.click()
    await flushPromises()
    expect(calls('review_draft')).toHaveLength(3)
    expect(toastTexts()).toContain('已通过 2 条,另有 1 条没成功(第一个失败原因:草稿已被别人处理)')
  })

  it('批量驳回要先确认(写明条数),不带 never_extract', async () => {
    await open()
    ;['d1', 'd3'].forEach((id) => $<HTMLInputElement>(`[data-id=${id}] [data-testid=draft-check]`)!.click())
    await flushPromises()
    confirmState.answer = false
    $<HTMLButtonElement>('[data-testid=batch-reject]')!.click()
    await flushPromises()
    expect(confirmState.calls[0]!.title).toContain('驳回选中的 2 条候选笔记')
    expect(calls('review_draft')).toHaveLength(0)
    expect($('[data-testid=batchbar]')).not.toBeNull() // 取消确认,选择还在
    confirmState.answer = true
    $<HTMLButtonElement>('[data-testid=batch-reject]')!.click()
    await flushPromises()
    expect(toastTexts()).toContain('已驳回 2 条')
    expect(calls('review_draft').map((call) => call[1])).toEqual([
      { id: 'd1', decision: 'reject', never_extract: false },
      { id: 'd3', decision: 'reject', never_extract: false },
    ])
  })

  it('切换状态页签清空选择', async () => {
    await open()
    $<HTMLInputElement>('[data-id=d1] [data-testid=draft-check]')!.click()
    await flushPromises()
    expect($('[data-testid=batchbar]')).not.toBeNull()
    await (wrapper!.vm as unknown as { $: { setupState: { switchState: (v: string) => Promise<void> } } }).$.setupState.switchState('approved')
    await flushPromises()
    expect($('[data-testid=batchbar]')).toBeNull()
  })
})

describe('Review · 分页', () => {
  it('后端有更多:显示还剩多少条和「加载更多」,点了追加下一页(不重复)', async () => {
    const first = Array.from({ length: 3 }, (_, i) => draft(`p${i}`))
    backend({ list_drafts: { drafts: first, total: 5, counts: COUNTS } })
    await open()
    expect($('[data-testid=review-more]')!.textContent).toContain('还有 2 条没显示')
    replies.list_drafts = { drafts: [draft('p2'), draft('p3'), draft('p4')], total: 5, counts: COUNTS }
    $<HTMLButtonElement>('[data-testid=review-more] button')!.click()
    await flushPromises()
    expect(calls('list_drafts').at(-1)![1]).toMatchObject({ page: 2 })
    expect($$('[data-testid=draft-card]')).toHaveLength(5)
    expect($('[data-testid=review-more]')).toBeNull()
  })
})

describe('Review · 没有开通(AI 总开关关闭 / 角色没勾自动提炼与审核)', () => {
  /** 会话里已经拿到功能列表,且没有 ai.extract(后端在 AI 关闭时就是这样折算的) */
  function withoutExtract() {
    const session = useSessionStore()
    session.features = new Set(['docs.notes', 'search.basic'])
    session.loaded = true
    return session
  }
  const bodyText = () => document.body.textContent ?? ''

  it('没有 ai.extract:整页写「没有开通」,不请求列表、不渲染草稿,页面上没有 AI 字样', async () => {
    withoutExtract()
    await open()
    expect($('[data-testid=review-off]')!.textContent).toContain('你的账号没有开通这个功能')
    expect(calls('list_drafts')).toHaveLength(0)
    expect($$('[data-testid=draft-card]')).toHaveLength(0)
    expect($('[data-testid=review-refresh]')).toBeNull()
    expect(bodyText()).not.toMatch(/(?<![A-Za-z])AI(?![A-Za-z])/)
  })

  it('功能列表晚到:先按有权限读取,发现没有就换成「没有开通」;之后又开通了会补读一次', async () => {
    await open()
    expect($$('[data-testid=draft-card]')).toHaveLength(3)
    const session = withoutExtract()
    await flushPromises()
    expect($('[data-testid=review-off]')).not.toBeNull()
    expect($$('[data-testid=draft-card]')).toHaveLength(0)
    const before = calls('list_drafts').length
    session.features = new Set(['docs.notes', 'ai.extract'])
    await flushPromises()
    expect(calls('list_drafts').length).toBe(before + 1)
    expect($('[data-testid=review-off]')).toBeNull()
    expect($$('[data-testid=draft-card]')).toHaveLength(3)
  })

  it('列表请求返回 403「AI 功能已关闭」:不照搬服务端的话(会露出 AI 字样),也不给没用的「重新加载」', async () => {
    backend({ list_drafts: new CapabilityError('AI 功能已关闭', 'forbidden', 403) })
    await open()
    expect($('[data-testid=review-off]')!.textContent).toContain('请联系管理员')
    expect($('[data-testid=review-error]')).toBeNull()
    expect(bodyText()).not.toMatch(/(?<![A-Za-z])AI(?![A-Za-z])/)
  })
})

describe('Review · 修订后通过的键盘', () => {
  async function openEdit() {
    await open()
    $<HTMLButtonElement>('[data-testid=draft-revise]')!.click()
    await flushPromises()
    return $<HTMLInputElement>('.kb-dialog input')!
  }
  const pressEnter = (input: HTMLInputElement, init: KeyboardEventInit = {}) => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }))

  it('在标题框里按 Enter 就提交,带着改过的标题', async () => {
    const title = await openEdit()
    title.value = '改过的标题'
    title.dispatchEvent(new Event('input'))
    pressEnter(title)
    await flushPromises()
    const sent = calls('review_draft').find((call) => (call[1] as { title?: string }).title)
    expect(sent![1]).toMatchObject({ id: 'd1', decision: 'approve', title: '改过的标题' })
    expect($('.kb-dialog')).toBeNull()
  })

  it('中文输入法选词时的回车不提交', async () => {
    const title = await openEdit()
    pressEnter(title, { isComposing: true })
    await flushPromises()
    expect(calls('review_draft')).toHaveLength(0)
    expect($('.kb-dialog')).not.toBeNull()
  })

  it('提交中再按 Enter 不重复提交', async () => {
    const title = await openEdit()
    pressEnter(title)
    pressEnter(title)
    await flushPromises()
    expect(calls('review_draft').filter((call) => (call[1] as { title?: string }).title)).toHaveLength(1)
  })
})
