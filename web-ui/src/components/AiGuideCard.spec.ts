// 使用指南页顶部的「AI 接入指南」卡片:下载 / 复制全文、admin key 的显示与复制、轮换(要确认,旧 key 作废),
// 读取失败可重试,AI 总开关关闭时标题不带 AI 字样。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import KbConfirmHost from '@kb-ui/components/KbConfirmHost.vue'
import { toasts } from '@kb-ui/components/useToast'

const KEY = `kb_ak_${'0123456789abcdef'.repeat(3)}`
const NEW_KEY = `kb_ak_${'fedcba9876543210'.repeat(3)}`
const adminKeyGet = vi.fn()
const adminKeyRotate = vi.fn()
const aiGuideText = vi.fn()
vi.mock('@/api/adminKey', () => ({
  adminKeyGet: () => adminKeyGet(),
  adminKeyRotate: () => adminKeyRotate(),
  aiGuideText: () => aiGuideText(),
  aiGuideUrl: (download: boolean) => `/api/v1/me/ai-guide?base=http%3A%2F%2Flocalhost${download ? '&download=1' : ''}`,
}))

import AiGuideCard from './AiGuideCard.vue'
import { AccountError } from '@/api/client'
import { useSessionStore } from '@/stores/session'

const find = (wrapper: ReturnType<typeof mount>, id: string) => wrapper.find(`[data-testid="${id}"]`)
const clipboard = { writeText: vi.fn() }

beforeEach(() => {
  document.body.innerHTML = ''
  toasts.splice(0, toasts.length)
  setActivePinia(createPinia())
  adminKeyGet.mockReset().mockResolvedValue({ admin_key: KEY, created_at: 1, rotated_at: null })
  adminKeyRotate.mockReset()
  aiGuideText.mockReset()
  clipboard.writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
})

describe('AiGuideCard', () => {
  it('标题、下载链接(带文件名)和说明', async () => {
    const wrapper = mount(AiGuideCard, { attachTo: document.body })
    await flushPromises()
    expect(wrapper.text()).toContain('AI 接入指南')
    const link = find(wrapper, 'ai-guide-download')
    expect(link.attributes('href')).toContain('/api/v1/me/ai-guide')
    expect(link.attributes('href')).toContain('download=1')
    expect(link.attributes('download')).toBe('knowledgebase-ai-guide.md')
    expect(wrapper.text()).toContain('自测脚本')
    wrapper.unmount()
  })

  it('AI 总开关关闭:标题和说明里没有 AI 字样,功能照旧', async () => {
    useSessionStore().aiEnabled = false
    const wrapper = mount(AiGuideCard, { attachTo: document.body })
    await flushPromises()
    expect(wrapper.text()).toContain('接口接入指南')
    expect(wrapper.text()).not.toMatch(/AI/)
    expect(find(wrapper, 'ai-guide-download').exists()).toBe(true)
    wrapper.unmount()
  })

  it('key 默认遮住,只露前缀和最后 4 位;点「显示」才看全部,再点「隐藏」遮回去', async () => {
    const wrapper = mount(AiGuideCard, { attachTo: document.body })
    await flushPromises()
    const value = find(wrapper, 'admin-key-value')
    expect(value.text()).not.toContain(KEY)
    expect(value.text().startsWith('kb_ak_')).toBe(true)
    expect(value.text().endsWith(KEY.slice(-4))).toBe(true)
    await find(wrapper, 'admin-key-toggle').trigger('click')
    expect(value.text()).toBe(KEY)
    expect(find(wrapper, 'admin-key-toggle').attributes('aria-pressed')).toBe('true')
    await find(wrapper, 'admin-key-toggle').trigger('click')
    expect(value.text()).not.toContain(KEY)
    wrapper.unmount()
  })

  it('复制 key 复制的是完整明文(不是遮住的样子)', async () => {
    const wrapper = mount(AiGuideCard, { attachTo: document.body })
    await flushPromises()
    await find(wrapper, 'admin-key-copy').trigger('click')
    await flushPromises()
    expect(clipboard.writeText).toHaveBeenCalledWith(KEY)
    wrapper.unmount()
  })

  it('复制全文:取指南正文放进剪贴板', async () => {
    aiGuideText.mockResolvedValue('# 接入指南\n\nkey 是 ' + KEY)
    const wrapper = mount(AiGuideCard, { attachTo: document.body })
    await flushPromises()
    await find(wrapper, 'ai-guide-copy').trigger('click')
    await flushPromises()
    expect(clipboard.writeText).toHaveBeenCalledWith('# 接入指南\n\nkey 是 ' + KEY)
    wrapper.unmount()
  })

  it('剪贴板不可用(微信内置浏览器):提示手动复制,不抛错', async () => {
    clipboard.writeText.mockRejectedValue(new Error('denied'))
    const wrapper = mount(AiGuideCard, { attachTo: document.body })
    await flushPromises()
    await find(wrapper, 'admin-key-copy').trigger('click')
    await flushPromises()
    expect(toasts.map((toast) => toast.message).join('|')).toContain('请手动选中复制')
    wrapper.unmount()
  })

  it('轮换:先确认并写明后果;确认后换成新 key、展开显示并复制;没确认不调接口', async () => {
    adminKeyRotate.mockResolvedValue({ admin_key: NEW_KEY, created_at: 1, rotated_at: Date.now() })
    const host = mount(KbConfirmHost, { attachTo: document.body })
    const wrapper = mount(AiGuideCard, { attachTo: document.body })
    await flushPromises()
    await find(wrapper, 'admin-key-rotate').trigger('click')
    await flushPromises()
    expect(document.body.textContent).toContain('轮换 admin key?')
    expect(document.body.textContent).toContain('旧 key 立刻失效')
    expect(adminKeyRotate).not.toHaveBeenCalled()
    ;(document.body.querySelector('.kb-confirm-btn.is-danger') as HTMLElement).click()
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await flushPromises()
    expect(adminKeyRotate).toHaveBeenCalledTimes(1)
    expect(find(wrapper, 'admin-key-value').text()).toBe(NEW_KEY)
    expect(clipboard.writeText).toHaveBeenCalledWith(NEW_KEY)
    expect(wrapper.text()).toContain('上次轮换')
    wrapper.unmount()
    host.unmount()
  })

  it('读取失败:显示原因和重试,不显示任何 key;重试成功后恢复', async () => {
    adminKeyGet.mockRejectedValueOnce(new AccountError('服务暂时不可用', 500, 0, 'internal'))
    const wrapper = mount(AiGuideCard, { attachTo: document.body })
    await flushPromises()
    expect(find(wrapper, 'admin-key-failure').text()).toContain('服务暂时不可用')
    expect(find(wrapper, 'admin-key-value').exists()).toBe(false)
    expect(find(wrapper, 'admin-key-rotate').exists()).toBe(false)
    await wrapper.find('.kb-aig-key button').trigger('click')
    await flushPromises()
    expect(find(wrapper, 'admin-key-value').exists()).toBe(true)
    wrapper.unmount()
  })
})
