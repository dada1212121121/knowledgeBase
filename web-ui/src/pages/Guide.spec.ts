// 使用指南页:目录与正文对得上、下载链接、AI 总开关、页内锚点滚动并聚焦、外链新窗口、宽窄两种目录结构。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const route = { path: '/guide', hash: '', query: {}, meta: {} }
vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push: vi.fn() }),
  RouterLink: { name: 'RouterLink', props: ['to'], template: '<a :href="to"><slot /></a>' },
}))
vi.mock('@/api/client', () => ({ callCapability: vi.fn(async () => ({})), health: vi.fn(async () => ({})) }))
// 顶部的「接入指南」卡片自己有测试(AiGuideCard.spec.ts);这里只让它读到一把 key,不去碰真实接口
vi.mock('@/api/adminKey', () => ({
  adminKeyGet: vi.fn(async () => ({ admin_key: 'kb_ak_' + 'a'.repeat(48), created_at: 1, rotated_at: null })),
  adminKeyRotate: vi.fn(),
  aiGuideUrl: () => '/api/v1/me/ai-guide?download=1',
  aiGuideText: vi.fn(async () => ''),
}))
// 页面框架只负责把标题 / 操作传送进顶栏,与这里要测的无关
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /></div>' } }))

import Guide from './Guide.vue'
import { useSessionStore } from '@/stores/session'

function stubMedia(wide: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width: 900px') ? wide : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  setActivePinia(createPinia())
  route.hash = ''
  stubMedia(true)
  // jsdom 没有 scrollIntoView
  Element.prototype.scrollIntoView = vi.fn()
})

const mountGuide = () => mount(Guide, { attachTo: document.body })

describe('Guide', () => {
  it('目录和正文对得上:每个目录项的锚点都落在正文的标题上,条数一致', () => {
    const wrapper = mountGuide()
    const links = wrapper.findAll('[data-testid=guide-toc] a')
    const ids = new Set(wrapper.findAll('[data-testid=guide-article] [id]').map((el) => el.attributes('id')))
    expect(links.length).toBeGreaterThan(10)
    for (const link of links) expect(ids.has(link.attributes('href')!.slice(1)), link.text()).toBe(true)
    wrapper.unmount()
  })

  it('两个下载按钮指向 ASCII 文件名,保存时的名字是中文', () => {
    const wrapper = mountGuide()
    const pdf = wrapper.find('[data-testid=guide-pdf]')
    const html = wrapper.find('[data-testid=guide-html]')
    expect(pdf.attributes('href')).toBe('/guide/knowledgeBase-user-guide.pdf')
    expect(pdf.attributes('download')).toBe('knowledgeBase-用户操作指南.pdf')
    expect(html.attributes('href')).toBe('/guide/knowledgeBase-user-guide.html')
    expect(html.attributes('download')).toBe('knowledgeBase-用户操作指南.html')
    wrapper.unmount()
  })

  it('AI 总开关开着有「内置助手」一节,关着整段不显示,页面上也没有「AI」字样', () => {
    const on = mountGuide()
    expect(on.find('[data-testid=guide-article]').text()).toContain('内置助手')
    on.unmount()

    useSessionStore().aiEnabled = false
    const off = mountGuide()
    expect(off.find('[data-testid=guide-article]').text()).not.toContain('内置助手')
    expect(off.text()).not.toMatch(/AI/)
    off.unmount()
  })

  it('点目录项:滚到对应标题并把焦点移过去(读屏软件和键盘用户的位置跟着走)', async () => {
    const wrapper = mountGuide()
    const link = wrapper.find('[data-testid=guide-toc] a[href="#tokens"]')
    expect(link.exists()).toBe(true)
    await link.trigger('click')
    const heading = document.getElementById('tokens')!
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    expect(document.activeElement).toBe(heading)
    wrapper.unmount()
  })

  it('正文里的 #锚点 链接同样是页内滚动,不当成路由跳转', async () => {
    const wrapper = mountGuide()
    const inner = wrapper.find('[data-testid=guide-article] a[href="#tokens"]')
    expect(inner.exists()).toBe(true)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    inner.element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement?.id).toBe('tokens')
    wrapper.unmount()
  })

  it('带着 #锚点 进来时直接跳到那一节;找不到的锚点什么也不做', async () => {
    route.hash = '#mcp-tools'
    const wrapper = mountGuide()
    await flushPromises()
    expect(document.activeElement?.id).toBe('mcp-tools')
    wrapper.unmount()

    route.hash = '#不存在的节'
    ;(document.activeElement as HTMLElement | null)?.blur()
    const missing = mountGuide()
    await flushPromises()
    expect(document.activeElement?.id ?? '').not.toBe('不存在的节')
    missing.unmount()
  })

  it('外链在新窗口打开(清洗时 target 被去掉了,点击时补上),并且不带 opener', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const wrapper = mountGuide()
    // 指南正文里目前没有外链,往文章里放一个,走和真实外链一样的点击路径
    const link = document.createElement('a')
    link.setAttribute('href', 'https://example.com/')
    wrapper.find('[data-testid=guide-article]').element.append(link)
    const plain = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    link.dispatchEvent(plain)
    expect(plain.defaultPrevented).toBe(true)
    expect(open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer')

    // Ctrl / ⌘ 点击保持浏览器默认(用户自己要开新标签),不拦截
    open.mockClear()
    const withCtrl = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true })
    link.dispatchEvent(withCtrl)
    expect(withCtrl.defaultPrevented).toBe(false)
    expect(open).not.toHaveBeenCalled()
    open.mockRestore()
    wrapper.unmount()
  })

  it('页面上的滚动容器经过清洗后仍然可聚焦(DOMPurify 不能把 tabindex / role / aria-label 去掉)', () => {
    const wrapper = mountGuide()
    const tables = wrapper.findAll('[data-testid=guide-article] .kb-guide-table')
    const blocks = wrapper.findAll('[data-testid=guide-article] pre')
    expect(tables.length).toBeGreaterThan(3)
    expect(blocks.length).toBeGreaterThan(3)
    for (const table of tables) {
      expect(table.attributes('tabindex')).toBe('0')
      expect(table.attributes('role')).toBe('region')
      expect(table.attributes('aria-label')).toBeTruthy()
    }
    for (const block of blocks) expect(block.attributes('tabindex')).toBe('0')
    wrapper.unmount()
  })

  it('宽屏目录常驻(没有可折叠的 summary,键盘也折不掉);窄屏折成 details', () => {
    stubMedia(true)
    const wide = mountGuide()
    expect(wide.find('[data-testid=guide-toc] details').exists()).toBe(false)
    expect(wide.find('[data-testid=guide-toc] summary').exists()).toBe(false)
    wide.unmount()

    stubMedia(false)
    const narrow = mountGuide()
    expect(narrow.find('[data-testid=guide-toc] details').exists()).toBe(true)
    expect(narrow.find('[data-testid=guide-toc] summary').text()).toBe('目录')
    narrow.unmount()
  })
})
