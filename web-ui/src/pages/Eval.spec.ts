// 评测页:容错(历史返回空对象)、四种状态、指标的中文标签与帮助文字、和上一次比较、运行的进度与失败、手机卡片。
// 回归自一次真实故障:fixture 没给 `runs`,`history.value` 变成 undefined,模板里的 `history.length` 直接抛错,整页白屏。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { PHONE_QUERY } from '@kb-ui/index'
import { toasts } from '@kb-ui/components/useToast'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /></div>' } }))

import { CapabilityError } from '@/api/client'
import { useSessionStore } from '@/stores/session'
import Eval from './Eval.vue'

const run = (over: Record<string, unknown> = {}) => ({
  at: Date.UTC(2026, 9, 20, 14, 42),
  run_id: 'ev_new',
  mode: 'hybrid+rerank',
  hit_at_1: 0.9,
  hit_at_3: 0.94,
  hit_at_k: 0.96,
  hit_at_10: 0.98,
  k: 5,
  mrr: 0.927,
  p95_ms: 212,
  degraded_cases: 0,
  reranked_cases: 50,
  cases: [
    { query: '双哈希增量索引', rank: 1, expect: 'docs/ARCHITECTURE.md' },
    { query: 'UDS 套接字通信', rank: 2, expect: 'src/router.rs' },
    { query: '迁移断点续跑', rank: null, expect: 'docs/PLAN.md' },
  ],
  ...over,
})
const OLD = run({ run_id: 'ev_old', at: Date.UTC(2026, 9, 19, 14, 42), hit_at_1: 0.85, hit_at_k: 0.97, mrr: 0.94, cases: undefined })
const HISTORY = [run(), OLD]

let replies: Record<string, unknown> = {}
function backend(overrides: Record<string, unknown> = {}) {
  replies = { eval_history: { runs: HISTORY }, eval_run: run({ run_id: 'ev_fresh', hit_at_1: 0.95 }), ...overrides }
  callCapability.mockImplementation(async (name: string) => {
    const reply = replies[name]
    if (reply instanceof Error) throw reply
    if (typeof reply === 'function') return (reply as () => unknown)()
    return reply ?? {}
  })
}
const calls = (name: string) => callCapability.mock.calls.filter((call) => call[0] === name)
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const $$ = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]
const text = () => document.body.textContent!.replace(/\s+/g, ' ')
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((ok, fail) => ((resolve = ok), (reject = fail)))
  return { promise, resolve, reject }
}

let wrapper: VueWrapper | null = null
const errors: unknown[] = []
async function open(options: { phone?: boolean; features?: string[] } = {}) {
  window.matchMedia = ((query: string) => ({ matches: !!options.phone && query === PHONE_QUERY, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  if (options.features) {
    const session = useSessionStore()
    session.features = new Set(options.features)
    session.loaded = true
  }
  // Vue 会「接住」渲染期异常,只留旧 DOM;所以除了断言文案,还要断言没有渲染错误
  wrapper = mount(Eval, { attachTo: document.body, global: { config: { errorHandler: (err) => errors.push(err) } } })
  await flushPromises()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(Date.UTC(2026, 9, 20, 16, 42))
  wrapper?.unmount()
  wrapper = null
  errors.length = 0
  toasts.splice(0)
  document.body.innerHTML = ''
  callCapability.mockReset()
  setActivePinia(createPinia())
  backend()
})
afterEach(() => vi.useRealTimers())

describe('Eval · 容错与四种状态', () => {
  it('eval_history 返回空对象时不崩,并落到空态', async () => {
    backend({ eval_history: {} })
    await open()

    expect(errors).toEqual([])
    expect(calls('eval_history')).toHaveLength(1)
    expect(text()).toContain('还没有跑过评测')
    // 没有记录就没有「历次结果」表,也不画一堆空指标
    expect($('[data-testid=eval-history]')).toBeNull()
    expect($('[data-testid=eval-metrics]')).toBeNull()
  })

  it('空态有一个可点的下一步:运行评测', async () => {
    backend({ eval_history: { runs: [] } })
    await open()
    const button = [...$('[data-testid=eval-empty]')!.querySelectorAll('button')].find((item) => item.textContent!.includes('运行评测'))
    expect(button).toBeTruthy()
    button!.click()
    await flushPromises()
    expect(calls('eval_run')).toHaveLength(1)
  })

  it('读历史时先显示骨架屏,不显示「加载中」文字', async () => {
    const pending = deferred<unknown>()
    backend({ eval_history: () => pending.promise })
    window.matchMedia = (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
    wrapper = mount(Eval, { attachTo: document.body })
    await flushPromises()
    expect($('[data-testid=admin-loading]')).not.toBeNull()
    expect($('[data-testid=eval-metrics]')).toBeNull()
    pending.resolve({ runs: HISTORY })
    await flushPromises()
    expect($('[data-testid=admin-loading]')).toBeNull()
    expect($('[data-testid=eval-metrics]')).not.toBeNull()
  })

  it('读历史失败:整块报错说清楚原因,点重试恢复', async () => {
    backend({ eval_history: new CapabilityError('internal: 评测历史文件损坏', 'internal', 500) })
    await open()
    const alert = $('[data-testid=admin-error]')!
    expect(alert.textContent).toContain('读取评测记录失败:评测历史文件损坏')
    expect(alert.textContent).not.toContain('internal')
    // 页面标题和运行按钮还在,不是整页空白
    expect(text()).toContain('评测')
    expect($('[data-testid=eval-run]')).not.toBeNull()

    backend()
    ;[...alert.querySelectorAll('button')].find((item) => item.textContent!.includes('重试'))!.click()
    await flushPromises()
    expect($('[data-testid=admin-error]')).toBeNull()
    expect($('[data-testid=eval-metrics]')).not.toBeNull()
  })

  it('服务端 403:显示没有权限,不给重试', async () => {
    backend({ eval_history: new CapabilityError('你的账号没有开通这个功能', 'forbidden', 403) })
    await open()
    expect($('[data-testid=admin-forbidden]')!.textContent).toContain('你的账号没有开通这个功能')
    expect($('[data-testid=admin-error]')).toBeNull()
    expect(text()).not.toContain('重试')
    // 没有权限时不显示运行评测
    expect($('[data-testid=eval-run]')).toBeNull()
  })

  it('账号没有「检索调优」功能:直接说明原因,也不去调接口', async () => {
    await open({ features: ['docs.notes', 'search.basic'] })
    expect($('[data-testid=admin-forbidden]')).not.toBeNull()
    expect(calls('eval_history')).toHaveLength(0)
    expect($('[data-testid=eval-run]')).toBeNull()
  })
})

describe('Eval · 刷新页面时会话稍后才取回来', () => {
  it('先按「有权限」读取,会话取回来发现没有这个功能:页面切成未开通,不显示运行按钮', async () => {
    await open()
    expect($('[data-testid=eval-metrics]')).not.toBeNull()
    const session = useSessionStore()
    session.features = new Set(['docs.notes'])
    session.loaded = true
    await flushPromises()
    expect($('[data-testid=admin-forbidden]')).not.toBeNull()
    expect($('[data-testid=eval-metrics]')).toBeNull()
    expect($('[data-testid=eval-run]')).toBeNull()
  })

  it('一开始没有功能,管理员稍后开通:不用刷新页面,自动读取', async () => {
    await open({ features: ['docs.notes'] })
    expect($('[data-testid=admin-forbidden]')).not.toBeNull()
    expect(calls('eval_history')).toHaveLength(0)
    useSessionStore().features = new Set(['search.tune'])
    await flushPromises()
    expect(calls('eval_history')).toHaveLength(1)
    expect($('[data-testid=eval-metrics]')).not.toBeNull()
  })
})

describe('Eval · 指标', () => {
  it('四个指标用中文标签,每个带一句帮助文字,键名放在帮助文字里', async () => {
    await open()
    const cards = $$('[data-testid=eval-metrics] .metric')
    expect(cards.map((card) => card.querySelector('.k')!.textContent)).toEqual(['第 1 条命中率', '前 5 条命中率', '平均排名得分', '只用了关键词的查询'])
    expect(cards.map((card) => card.querySelector('.v')!.textContent)).toEqual(['90.0%', '96.0%', '0.927', '0'])
    expect(cards[0]!.textContent).toContain('hit_at_1')
    expect(cards[2]!.textContent).toContain('mrr')
    // 标签本身不出现英文指标名
    for (const card of cards) expect(card.querySelector('.k')!.textContent).not.toMatch(/hit@|MRR|k =/)
  })

  it('和上一次比:带正负号的文字,不只靠颜色', async () => {
    await open()
    const cards = $$('[data-testid=eval-metrics] .metric')
    expect(cards[0]!.querySelector('.kb-ev-delta')!.textContent).toContain('+5.0 个百分点')
    expect(cards[0]!.querySelector('.kb-ev-delta')!.classList.contains('is-up')).toBe(true)
    expect(cards[1]!.querySelector('.kb-ev-delta')!.textContent).toContain('−1.0 个百分点')
    expect(cards[1]!.querySelector('.kb-ev-delta')!.classList.contains('is-down')).toBe(true)
    expect(cards[2]!.querySelector('.kb-ev-delta')!.textContent).toContain('−0.013')
  })

  it('上一次的返回条数不同:一项都不比,并说明为什么', async () => {
    backend({ eval_history: { runs: [run(), { ...OLD, k: 10 }] } })
    await open()
    // 不是同一道题:一个 ↑ 也不要给,否则读者会把「返回条数变了」当成「检索变好了」
    expect($('.kb-ev-delta')).toBeNull()
    expect($('[data-testid=eval-incomparable]')!.textContent).toContain('返回条数')
  })

  it('上一次跑的不是同一批用例:同样一项都不比', async () => {
    backend({ eval_history: { runs: [run({ set_hash: 'aaa' }), run({ run_id: 'ev_old', set_hash: 'bbb' })] } })
    await open()
    expect($('.kb-ev-delta')).toBeNull()
    expect($('[data-testid=eval-incomparable]')!.textContent).toContain('同一批用例')
  })

  it('只有一次记录:不显示「对比上一次」', async () => {
    backend({ eval_history: { runs: [run()] } })
    await open()
    expect($('.kb-ev-delta')).toBeNull()
  })

  it('有降级的查询:提醒这次的数字不要当基线', async () => {
    backend({ eval_history: { runs: [run({ degraded_cases: 50, mode: 'fts' })] } })
    await open()
    expect($('[data-testid=eval-degraded]')!.textContent).toContain('50 条')
    expect($('[data-testid=metric-degraded] .v')!.textContent).toBe('50')
    expect($('[data-testid=eval-meta]')!.textContent).toContain('只用关键词')
  })

  it('没有降级就不出现提醒', async () => {
    await open()
    expect($('[data-testid=eval-degraded]')).toBeNull()
  })

  it('检索方式在界面上写人话,不露 hybrid+rerank 这种取值', async () => {
    await open()
    expect($('[data-testid=eval-meta]')!.textContent).toContain('关键词 + 语义 + 重排')
    const row = $$('[data-testid=eval-history] [data-testid=rt-row]')[0]!
    expect(row.textContent).toContain('关键词 + 语义 + 重排')
  })

  it('「这些列是什么意思」里不露 hybrid / rerank 这类英文取值,指标键名只在帮助文字里', async () => {
    await open()
    const legend = $('[data-testid=eval-history] .kb-ev-cols')!.textContent!
    expect(legend).toContain('关键词 + 语义 + 重排')
    expect(legend).not.toMatch(/hybrid|rerank|fts/i)
    expect(legend).toContain('hit_at_3')
    expect(legend).toContain('p95_ms')
  })

  it('说清这次量的是哪份黄金集:文件名照实显示,老记录没有就不编', async () => {
    backend({ eval_history: { runs: [run({ set: 'golden.example.toml' })] } })
    await open()
    expect($('[data-testid=eval-meta]')!.textContent).toContain('用例集 golden.example.toml')
  })

  it('历史里缺 hit@3 / p95 的老记录显示「—」,不编数字', async () => {
    backend({ eval_history: { runs: [run({ hit_at_3: undefined, hit_at_10: null, p95_ms: undefined, run_id: undefined })] } })
    await open()
    const row = $$('[data-testid=eval-history] [data-testid=rt-row]')[0]!
    expect(row.textContent).toMatch(/—.*—.*—/)
    expect(errors).toEqual([])
  })
})

describe('Eval · 运行评测', () => {
  it('点运行:按所选返回条数发请求,等待时显示进度和已用时间,结束后更新结果并刷新历史', async () => {
    const pending = deferred<unknown>()
    backend({ eval_run: () => pending.promise })
    await open()
    $<HTMLButtonElement>('[data-testid=eval-run]')!.click()
    await flushPromises()

    expect(calls('eval_run')[0]![1]).toEqual({ k: 5 })
    const waiting = $('[data-testid=eval-running]')!
    expect(waiting.textContent).toContain('正在评测,已用 0 秒')
    expect(waiting.getAttribute('role')).toBe('status')
    // 评测中不能重复点
    expect($<HTMLButtonElement>('[data-testid=eval-run]')!.disabled).toBe(true)
    expect($<HTMLButtonElement>('[data-testid=eval-run]')!.textContent).toContain('评测中')

    vi.advanceTimersByTime(3000)
    await flushPromises()
    expect($('[data-testid=eval-running]')!.textContent).toContain('已用 3 秒')

    backend({ eval_history: { runs: [run({ run_id: 'ev_fresh', hit_at_1: 0.95 }), ...HISTORY] } })
    pending.resolve(run({ run_id: 'ev_fresh', hit_at_1: 0.95 }))
    await flushPromises()

    expect($('[data-testid=eval-running]')).toBeNull()
    expect($<HTMLButtonElement>('[data-testid=eval-run]')!.disabled).toBe(false)
    expect($('[data-testid=metric-hit1] .v')!.textContent).toBe('95.0%')
    expect(calls('eval_history')).toHaveLength(2)
    expect(toasts.map((toast) => toast.message)).toContain('评测完成:第 1 条命中率 95.0%')
    expect($('[data-testid=eval-meta]')!.textContent).toContain('刚跑完的这一次')
    // 定时器收掉了
    expect(vi.getTimerCount()).toBe(0)
  })

  it('选 10 条再运行,请求里带 k=10', async () => {
    await open()
    const select = wrapper!.findAllComponents({ name: 'KbSelect' })[0]!
    select.vm.$emit('update:modelValue', 10)
    await flushPromises()
    $<HTMLButtonElement>('[data-testid=eval-run]')!.click()
    await flushPromises()
    expect(calls('eval_run')[0]![1]).toEqual({ k: 10 })
  })

  it('填了抽样条数和种子就按填的发;留空只发返回条数,种子由后端现取', async () => {
    await open()
    const [sizeInput, seedInput] = ['eval-sample', 'eval-seed'].map((id) => $<HTMLInputElement>(`[data-testid=${id}]`)!)
    sizeInput.value = '5'
    sizeInput.dispatchEvent(new Event('input'))
    seedInput.value = '42'
    seedInput.dispatchEvent(new Event('input'))
    await flushPromises()
    $<HTMLButtonElement>('[data-testid=eval-run]')!.click()
    await flushPromises()
    expect(calls('eval_run')[0]![1]).toEqual({ k: 5, sample: 5, seed: 42 })

    // 清空 = 不传:后端自己挑种子,结果里回传
    sizeInput.value = ''
    sizeInput.dispatchEvent(new Event('input'))
    seedInput.value = ''
    seedInput.dispatchEvent(new Event('input'))
    await flushPromises()
    $<HTMLButtonElement>('[data-testid=eval-run]')!.click()
    await flushPromises()
    expect(calls('eval_run')[1]![1]).toEqual({ k: 5 })
  })

  it('换一批用例:换个种子把同一条命令再跑一次', async () => {
    await open()
    $<HTMLButtonElement>('[data-testid=eval-reroll]')!.click()
    await flushPromises()
    expect(calls('eval_run')).toHaveLength(1)
    const payload = calls('eval_run')[0]![1] as { seed: number }
    expect(typeof payload.seed).toBe('number')
    expect($<HTMLInputElement>('[data-testid=eval-seed]')!.value).toBe(String(payload.seed))
    expect(toasts.at(-1)!.message).toContain('评测完成')
  })

  it('黄金集里有用例对不上库:说明有哪几条、分母已经不是全部,并提醒一句', async () => {
    backend({
      eval_run: run({
        run_id: 'ev_part',
        status: 'partial',
        pool: 9,
        invalid_cases: [{ query: '分镜方案', kind: '集合不存在', detail: 'proj_devkit_docs' }],
      }),
    })
    await open()
    $<HTMLButtonElement>('[data-testid=eval-run]')!.click()
    await flushPromises()
    const note = $('[data-testid=eval-invalid]')!
    expect(note.textContent).toContain('集合不存在')
    expect(note.textContent).toContain('分母')
    expect(toasts.map((item) => item.message).join('|')).toContain('有 1 条用例无效')
    // 结果本身照常显示
    expect($('[data-testid=metric-hit1]')).not.toBeNull()
  })

  it('一条有效用例都没有:不摆指标、不画图,说清这次没跑出数字', async () => {
    backend({
      eval_run: run({
        run_id: 'ev_none',
        status: 'invalid_set',
        hit_at_1: null,
        hit_at_k: null,
        mrr: null,
        cases: [],
        pool: 3,
        invalid_cases: [{ query: '分镜方案', kind: '集合不存在', detail: 'proj_devkit_docs' }],
      }),
    })
    await open()
    $<HTMLButtonElement>('[data-testid=eval-run]')!.click()
    await flushPromises()
    const block = $('[data-testid=eval-invalid-set]')!
    expect(block.getAttribute('role')).toBe('alert')
    expect(block.textContent).toContain('修好')
    expect($('[data-testid=eval-metrics]')).toBeNull()
    expect($('[data-testid=eval-chart]')).toBeNull()
    expect($('[data-testid=eval-history]')).toBeNull()
    expect(toasts.map((item) => item.message).join('|')).toContain('没跑出数字')
  })

  it('抽样跑了一次:说明抽了几条、种子是多少,并提醒别把一两个点当退步', async () => {
    backend({ eval_history: { runs: [run({ seed: 42, sample: 5, pool: 30 })] } })
    await open()
    const note = $('[data-testid=eval-sampling]')!
    expect(note.textContent).toContain('30 条')
    expect(note.textContent).toContain('5 条')
    expect(note.textContent).toContain('42')
  })

  it('运行失败:就地说明原因和怎么办,可以重新运行;成功后提示消失', async () => {
    backend({ eval_run: new CapabilityError('invalid input: 读取黄金集 eval/golden.example.toml 失败: 文件不存在', 'invalid_input', 400) })
    await open()
    $<HTMLButtonElement>('[data-testid=eval-run]')!.click()
    await flushPromises()

    const alert = $('[data-testid=eval-run-error]')!
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toContain('运行评测失败:读取黄金集 eval/golden.example.toml 失败: 文件不存在')
    expect(alert.textContent).toContain('请确认黄金集文件存在')
    expect(alert.textContent).not.toContain('invalid input')
    // 失败不影响页面上原来的结果
    expect($('[data-testid=metric-hit1] .v')!.textContent).toBe('90.0%')
    expect($<HTMLButtonElement>('[data-testid=eval-run]')!.disabled).toBe(false)

    backend()
    $<HTMLButtonElement>('[data-testid=eval-retry]')!.click()
    await flushPromises()
    expect($('[data-testid=eval-run-error]')).toBeNull()
    expect($('[data-testid=metric-hit1] .v')!.textContent).toBe('95.0%')
  })

  it('请求中途断开、但服务器其实跑完了:直接采用那条新记录,不报失败', async () => {
    const fresh = run({ run_id: 'ev_done', hit_at_1: 0.43 })
    let historyCalls = 0
    backend({
      eval_run: new CapabilityError('服务暂时没有响应(HTTP 504)', 'bad_gateway', 504),
      // 第一次是打开页面时读的,之后(断开后重读)才有服务器刚写下的那条
      eval_history: () => ({ runs: ++historyCalls === 1 ? HISTORY : [fresh, ...HISTORY] }),
    })
    await open()
    $<HTMLButtonElement>('[data-testid=eval-run]')!.click()
    await flushPromises()
    expect($('[data-testid=eval-run-error]')).toBeNull()
    expect($('[data-testid=metric-hit1] .v')!.textContent).toBe('43.0%')
    expect(toasts.map((toast) => toast.message).join('|')).toContain('评测已在服务器上跑完')
  })

  it('请求断开且服务器没有新记录:说的是服务问题,不再叫人去查黄金集文件', async () => {
    backend({ eval_run: new CapabilityError('服务暂时没有响应(HTTP 502)', 'bad_gateway', 502) })
    await open()
    $<HTMLButtonElement>('[data-testid=eval-run]')!.click()
    await flushPromises()
    const alert = $('[data-testid=eval-run-error]')!
    expect(alert.textContent).toContain('服务暂时没有响应')
    expect(alert.textContent).toContain('过几秒再点')
    expect(alert.textContent).not.toContain('黄金集')
    // 页面上原来的结果不受影响
    expect($('[data-testid=metric-hit1] .v')!.textContent).toBe('90.0%')
  })

  it('运行被拒绝(没有权限):说明原因,不给重试', async () => {
    backend({ eval_run: new CapabilityError('你的账号没有开通这个功能', 'forbidden', 403) })
    await open()
    $<HTMLButtonElement>('[data-testid=eval-run]')!.click()
    await flushPromises()
    expect($('[data-testid=eval-run-error]')!.textContent).toContain('没有开通这个功能')
    expect($('[data-testid=eval-retry]')).toBeNull()
  })

  it('跑完了但刷新历史失败:这次的结果照样显示,另外提示一句', async () => {
    await open()
    backend({ eval_history: new CapabilityError('internal: 忙', 'internal', 500) })
    $<HTMLButtonElement>('[data-testid=eval-run]')!.click()
    await flushPromises()
    expect($('[data-testid=metric-hit1] .v')!.textContent).toBe('95.0%')
    expect($('[data-testid=admin-error]')).toBeNull()
    expect(toasts.map((toast) => toast.message).join('|')).toContain('没能刷新历次结果')
  })

  it('第一次读历史就失败,仍可直接运行;跑完页面恢复正常', async () => {
    backend({ eval_history: new CapabilityError('internal: 忙', 'internal', 500) })
    await open()
    expect($('[data-testid=admin-error]')).not.toBeNull()
    backend({ eval_history: { runs: [run({ run_id: 'ev_fresh', hit_at_1: 0.95 })] } })
    $<HTMLButtonElement>('[data-testid=eval-run]')!.click()
    await flushPromises()
    expect($('[data-testid=admin-error]')).toBeNull()
    expect($('[data-testid=metric-hit1] .v')!.textContent).toBe('95.0%')
  })

  it('页面卸载时收掉计时器', async () => {
    const pending = deferred<unknown>()
    backend({ eval_run: () => pending.promise })
    await open()
    $<HTMLButtonElement>('[data-testid=eval-run]')!.click()
    await flushPromises()
    expect(vi.getTimerCount()).toBe(1)
    wrapper!.unmount()
    wrapper = null
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('Eval · 逐条结果与图', () => {
  it('逐条结果:名次徽标用文字(第 1 位 / 没找到),不只靠颜色', async () => {
    await open()
    const rows = $$('[data-testid=eval-cases] [data-testid=rt-row]')
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.querySelector('.kb-ev-rank')!.textContent!.trim())).toEqual(['第 1 位', '第 2 位', '没找到'])
    expect(rows[2]!.querySelector('.kb-ev-rank')!.classList.contains('r')).toBe(true)
  })

  it('按文件格式筛选逐条结果', async () => {
    await open()
    const select = wrapper!.findAllComponents({ name: 'KbSelect' }).at(-1)!
    select.vm.$emit('update:modelValue', 'md')
    await flushPromises()
    const rows = $$('[data-testid=eval-cases] [data-testid=rt-row]')
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining('双哈希增量索引'), expect.stringContaining('迁移断点续跑')])
    select.vm.$emit('update:modelValue', 'pdf')
    await flushPromises()
    expect($('[data-testid=eval-cases]')!.textContent).toContain('这个格式下没有查询')
  })

  it('同样的查询出现两次也不会因为重复 key 出错', async () => {
    backend({ eval_history: { runs: [run({ cases: [{ query: '重复', rank: 1, expect: 'a.md' }, { query: '重复', rank: 2, expect: 'b.md' }] })] } })
    await open()
    expect($$('[data-testid=eval-cases] [data-testid=rt-row]')).toHaveLength(2)
    expect(errors).toEqual([])
  })

  it('最近一条记录没有保存逐条结果:说明原因,不画空表', async () => {
    backend({ eval_history: { runs: [OLD] } })
    await open()
    expect($('[data-testid=eval-cases]')).toBeNull()
    expect($('[data-testid=eval-no-cases]')!.textContent).toContain('重新运行一次评测')
  })

  it('图:有两次以上记录先画历次趋势,可以切到按文件格式', async () => {
    await open()
    const chart = $('[data-testid=eval-chart]')!
    expect(chart.textContent).toContain('历次趋势')
    expect(chart.querySelectorAll('.kb-gbars-group')).toHaveLength(2)
    const segment = [...chart.querySelectorAll<HTMLElement>('[role=tab]')].find((item) => item.textContent!.includes('按文件格式'))!
    segment.click()
    await flushPromises()
    expect(chart.textContent).toContain('按文件格式拆分')
    expect([...chart.querySelectorAll('.kb-gbars-label')].map((item) => item.textContent)).toEqual(['md', 'rs'])
  })

  it('只有一次记录且有逐条结果:直接画按文件格式,不出现切换', async () => {
    backend({ eval_history: { runs: [run()] } })
    await open()
    const chart = $('[data-testid=eval-chart]')!
    expect(chart.textContent).toContain('按文件格式拆分')
    expect(chart.querySelector('[role=tablist]')).toBeNull()
  })

  it('只有一次记录又没有逐条结果:说明趋势要两次以上,不画空图', async () => {
    backend({ eval_history: { runs: [OLD] } })
    await open()
    expect($('[data-testid=eval-chart]')!.textContent).toContain('至少要有两次评测记录')
    expect($('[data-testid=eval-chart] .kb-gbars')).toBeNull()
  })
})

describe('Eval · 手机', () => {
  it('历次结果变成卡片,不是表格行;卡片里有中文标签', async () => {
    await open({ phone: true })
    expect($$('[data-testid=eval-history] [data-testid=rt-row]')).toHaveLength(0)
    const cards = $$('[data-testid=eval-history] [data-testid=rt-card]')
    expect(cards).toHaveLength(2)
    expect(cards[0]!.textContent).toContain('平均排名得分')
    expect(cards[0]!.textContent).toContain('慢查询耗时')
    expect(cards[0]!.textContent).toContain('0.927')
    // 逐条结果也是卡片
    expect($$('[data-testid=eval-cases] [data-testid=rt-card]')).toHaveLength(3)
  })

  it('页面上不出现英文指标名当标签', async () => {
    await open({ phone: true })
    const labels = [...$$('.metric .k'), ...$$('[data-testid=eval-history] th'), ...$$('[data-testid=eval-history] dt')].map((item) => item.textContent!.trim())
    for (const label of labels) expect(label).not.toMatch(/hit@|MRR|p95|rerank|top-k|token/i)
  })
})

describe('Eval · 走势与名次分布', () => {
  const DAY = 86_400_000
  const base = Date.UTC(2026, 9, 20, 14, 42)
  // 新的在前:最新一次第 1 位命中率从 0.9 掉到 0.8(回落),耗时 212 比 34 慢很多
  const REGRESSED = [
    run({ run_id: 'ev_3', at: base, hit_at_1: 0.8, hit_at_k: 0.9, p95_ms: 212 }),
    run({ run_id: 'ev_2', at: base - DAY, hit_at_1: 0.9, hit_at_k: 0.95, p95_ms: 208, cases: undefined }),
    run({ run_id: 'ev_1', at: base - 2 * DAY, hit_at_1: 0.85, hit_at_k: 0.9, p95_ms: 34, cases: undefined }),
  ]

  it('有两次以上记录:出现命中率走势,回落的点标红并在副标题里说明', async () => {
    backend({ eval_history: { runs: REGRESSED } })
    await open()
    const card = $('[data-testid=eval-trend]')!
    expect(card).not.toBeNull()
    expect(card.textContent).toContain('1 次比上一次低')
    expect(card.querySelectorAll('svg.kb-line-svg .kb-line-flag').length).toBeGreaterThan(0)
    // 数据是读屏用的逐期文字:三次
    expect(card.querySelectorAll('.kb-sr li')).toHaveLength(3)
    expect(card.querySelector('table')).toBeNull()
    expect(errors).toEqual([])
  })

  it('没有回落时副标题写「没有回落」,不画红圈', async () => {
    backend({ eval_history: { runs: [run({ run_id: 'b', hit_at_1: 0.95 }), run({ run_id: 'a', at: base - DAY, hit_at_1: 0.9, cases: undefined })] } })
    await open()
    const card = $('[data-testid=eval-trend]')!
    expect(card.textContent).toContain('没有回落')
    expect(card.querySelectorAll('svg.kb-line-svg .kb-line-flag')).toHaveLength(0)
  })

  it('只有一次记录:不画走势(原来的图表区已经在说「至少要两次」),也不报错', async () => {
    backend({ eval_history: { runs: [run()] } })
    await open()
    expect($('[data-testid=eval-trend]')).toBeNull()
    expect($('[data-testid=eval-latency]')).toBeNull()
    expect(errors).toEqual([])
  })

  it('慢查询耗时走势:有两个以上耗时记录才画,带单位', async () => {
    backend({ eval_history: { runs: REGRESSED } })
    await open()
    const card = $('[data-testid=eval-latency]')!
    expect(card.textContent).toContain('毫秒')
    backend({ eval_history: { runs: [REGRESSED[0], { ...REGRESSED[1], p95_ms: null }] } })
    wrapper?.unmount()
    document.body.innerHTML = ''
    await open()
    expect($('[data-testid=eval-latency]')).toBeNull()
  })

  it('名次分布:七个桶都在,没找到那一行有数', async () => {
    await open()
    const card = $('[data-testid=eval-ranks]')!
    expect(card).not.toBeNull()
    expect(card.querySelectorAll('.kb-hbars-row')).toHaveLength(7)
    const rows = [...card.querySelectorAll('.kb-hbars-row')].map((row) => row.textContent!.replace(/\s+/g, ' ').trim())
    // fixture 的三条查询:第 1 位 1 条、第 2 位 1 条、没找到 1 条
    expect(rows[0]).toContain('第 1 位')
    expect(rows[0]).toContain('1 条 · 33%')
    expect(rows[6]).toContain('没找到')
    expect(rows[6]).toContain('1 条 · 33%')
    expect(card.textContent).toContain('3 条查询')
  })

  it('记录没有保存逐条结果:不画名次分布', async () => {
    backend({ eval_history: { runs: [run({ cases: undefined }), OLD] } })
    await open()
    expect($('[data-testid=eval-ranks]')).toBeNull()
    expect($('[data-testid=eval-no-cases]')).not.toBeNull()
  })

  it('返回条数不同的几次,说明哪几次没画前 k 条命中率', async () => {
    backend({ eval_history: { runs: [run({ run_id: 'x', k: 5 }), run({ run_id: 'y', k: 10, at: base - DAY, cases: undefined })] } })
    await open()
    expect($('[data-testid=eval-trend]')!.textContent).toContain('1 次的返回条数和最新一次不同')
  })

  it('手机上三张卡各占一行,没有横向溢出的固定宽度', async () => {
    backend({ eval_history: { runs: REGRESSED } })
    await open({ phone: true })
    expect($$('[data-testid=eval-insights] > *')).toHaveLength(3)
    for (const svg of $$('[data-testid=eval-insights] svg.kb-line-svg')) expect(Number(svg.getAttribute('width'))).toBeLessThanOrEqual(480)
  })

  it('页面上不出现英文指标名当标签(新卡片也一样)', async () => {
    backend({ eval_history: { runs: REGRESSED } })
    await open()
    const titles = $$('[data-testid=eval-insights] .ch').map((item) => item.textContent!.trim())
    for (const title of titles) expect(title).not.toMatch(/hit@|MRR|p95|rerank|top-k|token/i)
  })
})
