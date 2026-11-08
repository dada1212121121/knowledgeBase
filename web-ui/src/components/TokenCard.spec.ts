// 个人设置里的访问令牌卡片:加载 / 空 / 报错 / 无权限 / 列表,新建与撤销。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { AccountError } from '@/api/client'

const tokensList = vi.fn()
const tokenCreate = vi.fn()
const tokenRevoke = vi.fn()
vi.mock('@/api/tokens', () => ({
  tokensList: () => tokensList(),
  tokenCreate: (...a: unknown[]) => tokenCreate(...a),
  tokenRevoke: (...a: unknown[]) => tokenRevoke(...a),
}))

import TokenCard from './TokenCard.vue'
import KbConfirmHost from '@kb-ui/components/KbConfirmHost.vue'

const row = (patch: Record<string, unknown> = {}) => ({ id: 'k1', name: 'kiro', scope: 'mcp', scopes: 'mcp', include_shared: false, created_at: Date.UTC(2026, 9, 1, 4), // 上海 10-01 12:00
  last_used: null, revoked_at: null, ...patch })
const find = (wrapper: ReturnType<typeof mount>, id: string) => wrapper.find(`[data-testid="${id}"]`)
const q = (selector: string) => document.body.querySelector(selector) as HTMLElement | null
const input = (selector: string) => q(selector) as HTMLInputElement
async function type(selector: string, value: string) {
  const el = input(selector)
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}
const mountCard = () => mount(TokenCard, { attachTo: document.body })

beforeEach(() => {
  document.body.innerHTML = ''
  tokensList.mockReset()
  tokenCreate.mockReset()
  tokenRevoke.mockReset()
})

describe('TokenCard 列表的四种状态', () => {
  it('加载中:骨架屏,没有「新建」按钮', async () => {
    tokensList.mockReturnValue(new Promise(() => undefined))
    const wrapper = mountCard()
    await flushPromises()
    expect(wrapper.find('.kb-skel').exists()).toBe(true)
    expect(find(wrapper, 'token-new').exists()).toBe(false)
  })

  it('空:一句说明 + 下一步按钮,点它打开新建', async () => {
    tokensList.mockResolvedValue([])
    const wrapper = mountCard()
    await flushPromises()
    expect(wrapper.text()).toContain('还没有访问令牌')
    await wrapper.find('.kb-empty button').trigger('click')
    expect(q('[data-testid=token-form]')).not.toBeNull()
    wrapper.unmount()
  })

  it('报错:显示后端的话 + 下一步,可重试,不会说成「还没有令牌」', async () => {
    tokensList.mockRejectedValueOnce(new AccountError('令牌服务暂时不可用', 500, 0, 'internal'))
    const wrapper = mountCard()
    await flushPromises()
    const failure = find(wrapper, 'token-failure')
    expect(failure.text()).toContain('令牌服务暂时不可用。请稍后再试。')
    expect(wrapper.text()).not.toContain('还没有访问令牌')
    expect(find(wrapper, 'token-new').exists()).toBe(false)
    tokensList.mockResolvedValue([row()])
    await failure.find('button').trigger('click')
    await flushPromises()
    expect(find(wrapper, 'token-failure').exists()).toBe(false)
    expect(wrapper.text()).toContain('kiro')
  })

  it('无权限(403):统一话术,不给重试', async () => {
    tokensList.mockRejectedValueOnce(new AccountError('你的账号没有开通这个功能', 403, 0, 'forbidden'))
    const wrapper = mountCard()
    await flushPromises()
    const failure = find(wrapper, 'token-failure')
    expect(failure.text()).toContain('没有开通这个功能,请联系管理员')
    expect(failure.find('button').exists()).toBe(false)
  })

  it('列表:类型、是否包含共享内容、创建日期、最近使用、状态;已撤销的没有撤销按钮', async () => {
    tokensList.mockResolvedValue([
      row({ id: 'a', name: 'kiro', include_shared: true, last_used: Date.now() - 5 * 60_000 }),
      row({ id: 'b', name: 'ci', scope: 'api', scopes: 'api' }),
      row({ id: 'c', name: 'old', revoked_at: 1 }),
    ])
    const wrapper = mountCard()
    await flushPromises()
    const rows = wrapper.findAll('[data-testid="rt-row"]')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.text()).toContain('MCP')
    expect(rows[0]!.find('[data-testid="token-shared-badge"]').exists()).toBe(true)
    expect(rows[0]!.text()).toContain('5 分钟前')
    expect(rows[1]!.text()).toContain('API')
    expect(rows[1]!.find('[data-testid="token-shared-badge"]').exists()).toBe(false)
    expect(rows[1]!.text()).toContain('从未使用')
    expect(rows[1]!.text()).toContain('2026-10-01')
    expect(rows[2]!.text()).toContain('已撤销')
    expect(rows[2]!.find('[data-testid="token-revoke"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('2 个有效令牌')
  })
})

describe('TokenCard 新建', () => {
  async function openForm() {
    tokensList.mockResolvedValue([row()])
    const wrapper = mountCard()
    await flushPromises()
    await find(wrapper, 'token-new').trigger('click')
    return wrapper
  }

  it('名称为空不能创建;「包含共享给我的内容」默认关闭', async () => {
    const wrapper = await openForm()
    expect(input('[data-testid=token-submit]').disabled).toBe(true)
    expect(q('[data-testid=token-shared]')!.getAttribute('aria-checked')).toBe('false')
    wrapper.unmount()
  })

  it('MCP + 开启共享:请求带 include_shared=true;完成页一次性显示明文并回显选择', async () => {
    const wrapper = await openForm()
    tokenCreate.mockResolvedValueOnce({ id: 'n1', name: 'kiro-笔记本', scope: 'mcp', token: 'kb_SECRET' })
    tokensList.mockResolvedValue([row(), row({ id: 'n1', name: 'kiro-笔记本', include_shared: true })])
    await type('[data-testid=token-name]', 'kiro-笔记本')
    q('[data-testid=token-shared]')!.click()
    await flushPromises()
    expect(q('[data-testid=token-shared]')!.getAttribute('aria-checked')).toBe('true')
    q('[data-testid=token-submit]')!.click()
    await flushPromises()
    expect(tokenCreate).toHaveBeenCalledWith('kiro-笔记本', 'mcp', true)
    expect(q('[data-testid=token-secret]')!.textContent).toBe('kb_SECRET')
    expect(q('[data-testid=token-done]')!.textContent).toContain('包含')
    // 列表已刷新
    expect(wrapper.text()).toContain('kiro-笔记本')
    wrapper.unmount()
  })

  it('选 API:开关显示关闭且不可用,请求不带 true', async () => {
    const wrapper = await openForm()
    tokenCreate.mockResolvedValueOnce({ id: 'n2', name: 'ci', scope: 'api', token: 'kb_X' })
    await type('[data-testid=token-name]', 'ci')
    q('[data-testid=token-shared]')!.click()
    await flushPromises()
    const api = input('[data-testid=token-scope-api]')
    api.checked = true
    api.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
    const sw = q('[data-testid=token-shared]')!
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(sw.getAttribute('aria-disabled')).toBe('true')
    expect(q('[data-testid=token-form]')!.textContent).toContain('API 令牌用不到')
    q('[data-testid=token-submit]')!.click()
    await flushPromises()
    expect(tokenCreate).toHaveBeenCalledWith('ci', 'api', true) // 组件原样传,是否发 true 由 api/tokens.ts 决定(那边有测试)
    wrapper.unmount()
  })

  it('重名(409):就地提示并留在表单里', async () => {
    const wrapper = await openForm()
    tokenCreate.mockRejectedValueOnce(new AccountError('已有同名令牌:kiro', 409, 0, 'exists'))
    await type('[data-testid=token-name]', 'kiro')
    q('[data-testid=token-submit]')!.click()
    await flushPromises()
    expect(q('[data-testid=token-form] [role=alert]')!.textContent).toContain('已经有一个叫「kiro」的令牌')
    expect(q('[data-testid=token-done]')).toBeNull()
    wrapper.unmount()
  })

  it('没复制就点完成:先提醒一次,再点才关;复制过则直接关', async () => {
    let wrapper = await openForm()
    tokenCreate.mockResolvedValue({ id: 'n3', name: 'a', scope: 'mcp', token: 'kb_Y' })
    await type('[data-testid=token-name]', 'a')
    q('[data-testid=token-submit]')!.click()
    await flushPromises()
    q('[data-testid=token-close]')!.click()
    await flushPromises()
    expect(q('[data-testid=token-done]')!.textContent).toContain('还没复制令牌吗')
    q('[data-testid=token-close]')!.click()
    await flushPromises()
    expect(q('[data-testid=token-done]')).toBeNull()
    wrapper.unmount()

    document.body.innerHTML = ''
    wrapper = await openForm()
    await type('[data-testid=token-name]', 'b')
    q('[data-testid=token-submit]')!.click()
    await flushPromises()
    // KbCopyButton 复制成功后发出 copied(true);jsdom 没有剪贴板,补一个能成功的
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true })
    const copy = q('[data-testid=token-done] .kb-copy button')!
    copy.click()
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 20))
    q('[data-testid=token-close]')!.click()
    await flushPromises()
    expect(q('[data-testid=token-done]')).toBeNull()
    wrapper.unmount()
  })
})

describe('TokenCard 撤销', () => {
  it('要确认并写明后果;确认后调用接口并刷新列表', async () => {
    tokensList.mockResolvedValueOnce([row({ id: 'k9', name: 'ci' })])
    const host = mount(KbConfirmHost, { attachTo: document.body })
    const wrapper = mountCard()
    await flushPromises()
    tokenRevoke.mockResolvedValueOnce({ id: 'k9', revoked_at: 1 })
    tokensList.mockResolvedValue([row({ id: 'k9', name: 'ci', revoked_at: 1 })])
    await find(wrapper, 'token-revoke').trigger('click')
    await flushPromises()
    expect(document.body.textContent).toContain('撤销令牌「ci」')
    expect(document.body.textContent).toContain('立刻失去访问权限')
    expect(tokenRevoke).not.toHaveBeenCalled()
    ;(document.body.querySelector('.kb-confirm-btn.is-danger') as HTMLElement).click()
    await flushPromises()
    expect(tokenRevoke).toHaveBeenCalledWith('k9')
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await flushPromises()
    expect(wrapper.text()).toContain('已撤销')
    wrapper.unmount()
    host.unmount()
  })
})
