// 正文末尾的「引用了这篇文档」(反向链接):只在阅读态显示,按来源归并,点击能跳过去。
// doc_links 的入链一行对应一处链接,页面要按「哪篇文档」归并后再列。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DocPage from './DocPage.vue'
import { useSessionStore } from '@/stores/session'

interface Call {
  name: string
  args?: Record<string, unknown>
}

const calls: Call[] = []
// 旧服务没有 doc_links 的场景,单独开关(不改共享 mock 的实现)
let docLinksFails = false
const callCapability = vi.fn(async (name: string, args?: Record<string, unknown>) => {
  calls.push({ name, args })
  if (name === 'doc_links') {
    if (docLinksFails) throw new Error('unknown capability: doc_links')
    return {
      inbound: [
        { source_kind: 'note', source_collection: 'proj', source_id: 'ins_weekly', source_title: '项目周报', line: 12, href: 'kb://note/ins_weekly' },
        { source_kind: 'note', source_collection: 'proj', source_id: 'ins_weekly', source_title: '项目周报', line: 40, href: 'kb://note/ins_weekly' },
        { source_kind: 'file', source_collection: 'proj', source_id: 'docs/规范.md', source_title: '', line: 3, href: '' },
      ],
    }
  }
  if (name === 'check_links') return { items: [] }
  return {}
})

vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...(args as [string, Record<string, unknown>?])),
}))

function mountRead(props: Record<string, unknown> = {}) {
  return mount(DocPage, {
    props: {
      title: '接口规范',
      modelValue: '# 接口规范\n\n正文。',
      editing: false,
      collection: 'proj',
      noteId: 'ins_me',
      ...props,
    },
    attachTo: document.body,
  })
}

/** 等入链查询和 Markdown 渲染落地 */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

beforeEach(() => {
  calls.length = 0
  docLinksFails = false
  callCapability.mockClear()
  setActivePinia(createPinia())
  const session = useSessionStore()
  session.user = { id: 'usr_me', username: 'me', display_name: '我', email: null, role_id: 'r', space_id: 's', must_change_password: false }
})
afterEach(() => {
  document.body.innerHTML = ''
  window.history.replaceState({}, '', '/')
})

describe('DocPage 反向链接', () => {
  it('阅读态在正文末尾列出引用来源:同一篇归并、文件用文件名、带行号', async () => {
    const wrapper = mountRead()
    await settle()
    const block = wrapper.find('[data-testid="doc-backlinks"]')
    expect(block.exists()).toBe(true)
    const rows = block.findAll('li')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('项目周报')
    expect(rows[0].text()).toContain('笔记 · 第 12 行 · 等 2 处')
    expect(rows[1].text()).toContain('规范.md')
    expect(rows[1].text()).toContain('文件 · 第 3 行')

    // 查询本身只要入链,不要拉全量出链
    const query = calls.find((call) => call.name === 'doc_links')
    expect(query?.args).toMatchObject({ note_id: 'ins_me', direction: 'to' })
    wrapper.unmount()
  })

  it('点来源能跳转:笔记发 openLink,文件发 openAttachment(带上它自己的集合)', async () => {
    const wrapper = mountRead()
    await settle()
    const rows = wrapper.findAll('[data-testid="doc-backlinks"] li')
    await rows[0].find('button').trigger('click')
    expect(wrapper.emitted('openLink')?.[0]).toEqual(['ins_weekly'])
    await rows[1].find('button').trigger('click')
    expect(wrapper.emitted('openAttachment')?.[0]).toEqual([{ collection: 'proj', path: 'docs/规范.md' }])
    wrapper.unmount()
  })

  it('页头「引用」按钮的计数与正文末尾一致(按来源篇数,不按链接处数)', async () => {
    const wrapper = mountRead()
    await settle()
    expect(wrapper.find('[data-testid="doc-links-button"]').text()).toBe('引用 2')
    wrapper.unmount()
  })

  it('编辑态不显示(引用清单在页头面板里,不重复摆两套)', async () => {
    const wrapper = mountRead({ editing: true })
    await settle()
    expect(wrapper.find('[data-testid="doc-backlinks"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('没有入链 / 旧服务没有 doc_links 时都不显示,也不影响阅读', async () => {
    docLinksFails = true
    const wrapper = mountRead()
    await settle()
    expect(wrapper.find('[data-testid="doc-backlinks"]').exists()).toBe(false)
    expect(wrapper.find('.kb-md-read-body').text()).toContain('正文。')
    wrapper.unmount()
  })
})
