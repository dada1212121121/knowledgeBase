// 文档页的草稿行为:单人编辑静默放回、服务器变过要问、多人编辑不静默写回正文、关页面 / 切走时立即落盘、账号隔离。
// 编辑器外壳（EditorHost）太重,用桩代替:它只负责按 request 里的原文显示,并记下页面发给它的命令。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick, ref, type Component } from 'vue'
import DocPage from './DocPage.vue'
import { useSessionStore } from '@/stores/session'
import { loadDraft, saveDraft, scopedDraftId } from '@/utils/docText'

// 普通的组件选项对象(不走 defineComponent):eslint 的 vue/one-component-per-file 只允许一个文件里有一个 defineComponent,
// 这个文件的那一个留给下面的宿主
/** 外壳桩收到的命令（多人编辑撤回要直接改房间里的内容，走 `text.replaceAll`） */
const commands: { type: string; args?: unknown }[] = []
const Editor = {
  props: { request: { type: Object, default: () => ({}) } },
  setup(props: { request: { source?: { text?: string } } }, { expose }: { expose: (exposed: Record<string, unknown>) => void }) {
    expose({
      flushText: async () => props.request.source?.text ?? '',
      currentText: () => props.request.source?.text ?? null,
      focus: () => undefined,
      openFind: () => undefined,
      refreshText: async () => undefined,
      replaceHref: async () => 0,
      executeCommand: async (command: { type: string; args?: unknown }) => {
        commands.push({ type: command.type, args: command.args })
        return { ok: true }
      },
    })
    return () => h('div', { class: 'editor-stub' }, props.request.source?.text ?? '')
  },
} as unknown as Component

const USER = 'usr_me'
const ID = 'ins_1'
const key = (id = ID, user = USER) => scopedDraftId(user, id)

function fakeProvider(initial: { pendingLocal?: boolean; status?: string; ready?: boolean; everSynced?: boolean; initMarkdown?: string | null } = {}) {
  let state = { pendingLocal: false, status: 'synced', ready: true, everSynced: true, writable: true, docEpoch: 0, end: null, me: null, initMarkdown: null as string | null, ...initial }
  const listeners = new Set<(value: typeof state) => void>()
  return {
    getState: () => state,
    subscribe(handler: (value: typeof state) => void) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    set(patch: Partial<typeof state>) {
      state = { ...state, ...patch }
      for (const listener of listeners) listener(state)
    },
    awareness: { getStates: () => new Map(), clientID: 1, on: () => undefined, off: () => undefined },
  }
}

/**
 * 用宿主组件挂载,标题 / 正文 / 附加内容由宿主的 ref 驱动并通过 v-model 回写,和 Browser 的真实用法一致。
 * 草稿在 DocPage 初始化时就会放回(emit 发生在 setup 里),所以不能靠挂载之后才拿到的 wrapper 去接收。
 */
function mountPage(props: Record<string, unknown> = {}) {
  const title = ref((props.title as string) ?? '标题')
  const body = ref((props.modelValue as string) ?? '原文')
  const restored: string[] = []
  const rest = { ...props }
  delete rest.title
  delete rest.modelValue
  const page = ref<InstanceType<typeof DocPage> | null>(null)
  const Host = defineComponent({
    setup() {
      return () =>
        h(DocPage, {
          ref: page,
          title: title.value,
          modelValue: body.value,
          editing: true,
          draftId: ID,
          baseTitle: '标题',
          baseBody: '原文',
          ...rest,
          'onUpdate:title': (value: string) => (title.value = value),
          'onUpdate:modelValue': (value: string) => (body.value = value),
          onRestoreExtra: (value: string) => restored.push(value),
        })
    },
  })
  const wrapper = mount(Host, { global: { stubs: { EditorHost: Editor } }, attachTo: document.body })
  /** 模拟用户在编辑器里敲字:正文变了,宿主把新值传回 DocPage */
  const type = async (value: string) => {
    body.value = value
    await nextTick()
  }
  const setTitle = async (value: string) => {
    title.value = value
    await nextTick()
  }
  return { wrapper, title, body, restored, type, setTitle, api: () => page.value as unknown as DocPageApi }
}
type DocPageApi = { persistDraft: () => boolean | null; saved: () => void; revertToSaved: () => void }

beforeEach(() => {
  setActivePinia(createPinia())
  const session = useSessionStore()
  session.user = { id: USER, username: 'me', display_name: '我', email: null, role_id: 'r', space_id: 's', must_change_password: false }
  // 这个文件用外壳桩验证草稿逻辑（草稿只看页面的 v-model，与编辑器内核无关）；
  // 真实外壳下的草稿 / 保存行为在 DocPage.native.spec.ts
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
  commands.length = 0
  document.body.innerHTML = ''
})

describe('DocPage 草稿 · 单人编辑', () => {
  it('草稿基于现在这一版:静默放回标题和正文,顶上只留一条可撤销的说明,不弹「恢复/丢弃」', async () => {
    saveDraft(key(), { title: '改过的标题', body: '改过的正文', base: '原文', baseTitle: '标题' })
    const { wrapper, title, body, restored } = mountPage()
    await flushPromises()
    expect(title.value).toBe('改过的标题')
    expect(body.value).toBe('改过的正文')
    expect(wrapper.find('[data-testid=draft-ask]').exists()).toBe(false)
    expect(wrapper.find('[data-testid=draft-restored]').exists()).toBe(true)
  })

  it('点「放弃这些修改」:标题、正文都退回服务器上的那一版,草稿清掉', async () => {
    saveDraft(key(), { title: '改过的标题', body: '改过的正文', base: '原文', baseTitle: '标题' })
    const { wrapper, title, body, restored } = mountPage()
    await flushPromises()
    await wrapper.find('[data-testid=draft-revert]').trigger('click')
    expect(title.value).toBe('标题')
    expect(body.value).toBe('原文')
    expect(loadDraft(key())).toBeNull()
    expect(wrapper.find('[data-testid=draft-restored]').exists()).toBe(false)
  })

  it('阅读态点「撤回」(revertToSaved):标题 / 正文 / 标签回到服务器上的那一版,草稿清掉', async () => {
    // 顶栏的「撤回」不依赖草稿提示条:提示条被「知道了」关掉之后,也还能一键回到上次保存的样子
    saveDraft(key(), { title: '改过的标题', body: '改过的正文', base: '原文', baseTitle: '标题', extra: '{"tags":["新"]}', baseExtra: '{"tags":[]}' })
    const { wrapper, title, body, restored, api } = mountPage({ extra: '{"tags":["新"]}', baseExtra: '{"tags":[]}' })
    await flushPromises()
    expect(body.value).toBe('改过的正文')
    api().revertToSaved()
    await nextTick()
    expect(title.value).toBe('标题')
    expect(body.value).toBe('原文')
    expect(restored.at(-1)).toBe('{"tags":[]}')
    expect(loadDraft(key())).toBeNull()
    expect(wrapper.find('[data-testid=draft-restored]').exists()).toBe(false)
  })

  it('服务器上的正文在草稿之后变过:不静默覆盖,弹条让人选,什么都不会自动改', async () => {
    saveDraft(key(), { title: '标题', body: '我的版本', base: '更早的原文', baseTitle: '标题' })
    const { wrapper, title, body } = mountPage()
    await flushPromises()
    expect(wrapper.find('[data-testid=draft-ask]').exists()).toBe(true)
    expect(body.value).toBe('原文')
    await wrapper.find('[data-testid=draft-restore]').trigger('click')
    expect(body.value).toBe('我的版本')
  })

  it('点「丢弃」:草稿清掉,内容不动', async () => {
    saveDraft(key(), { title: '标题', body: '我的版本', base: '更早的原文' })
    const { wrapper, title, body } = mountPage()
    await flushPromises()
    await wrapper.find('[data-testid=draft-discard]').trigger('click')
    expect(loadDraft(key())).toBeNull()
    expect(body.value).toBe('原文')
  })

  it('草稿和服务器一样(没有实际改动):清掉,什么都不提示', async () => {
    saveDraft(key(), { title: '标题', body: '原文', base: '原文' })
    const { wrapper, title, body } = mountPage()
    await flushPromises()
    expect(loadDraft(key())).toBeNull()
    expect(wrapper.find('.kb-dp-draft').exists()).toBe(false)
  })

  it('标签这类附加内容跟着放回:通过 restoreExtra 交给父级', async () => {
    saveDraft(key(), { title: '标题', body: '原文', base: '原文', baseTitle: '标题', extra: '{"tags":["新"]}', baseExtra: '{"tags":[]}' })
    const { title, body, restored } = mountPage({ extra: '{"tags":[]}', baseExtra: '{"tags":[]}' })
    await flushPromises()
    expect(restored).toEqual(['{"tags":["新"]}'])
  })

  it('不在编辑态:不读也不放回草稿', async () => {
    saveDraft(key(), { title: '改过的标题', body: '改过的正文', base: '原文', baseTitle: '标题' })
    const { wrapper, title, body } = mountPage({ editing: false })
    await flushPromises()
    expect(body.value).toBe('原文')
    expect(wrapper.find('.kb-dp-draft').exists()).toBe(false)
  })
})

describe('DocPage 草稿 · 落盘', () => {
  it('停手 500 毫秒后存;改回和服务器一样就清掉', async () => {
    const { type } = mountPage()
    await type('新写的')
    expect(loadDraft(key())).toBeNull()
    await vi.advanceTimersByTimeAsync(500)
    expect(loadDraft(key())?.body).toBe('新写的')
    await type('原文')
    await vi.advanceTimersByTimeAsync(500)
    expect(loadDraft(key())).toBeNull()
  })

  it('切到后台 / 关页面时立刻存,不等防抖(手机浏览器切应用就可能直接回收页面)', async () => {
    const { type } = mountPage()
    await type('刚敲的')
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(loadDraft(key())?.body).toBe('刚敲的')
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await type('又敲了')
    window.dispatchEvent(new Event('pagehide'))
    expect(loadDraft(key())?.body).toBe('又敲了')
  })

  it('防抖没到点就切走(组件卸载):先把最后一笔存下来', async () => {
    const { wrapper, type } = mountPage()
    await type('切走前最后敲的')
    wrapper.unmount()
    expect(loadDraft(key())?.body).toBe('切走前最后敲的')
  })

  it('保存成功(saved):草稿清掉,不会在下次打开时又把已保存的内容当草稿', async () => {
    const { type, api } = mountPage()
    await type('写好了')
    await vi.advanceTimersByTimeAsync(500)
    expect(loadDraft(key())).not.toBeNull()
    ;api().saved()
    expect(loadDraft(key())).toBeNull()
    await vi.advanceTimersByTimeAsync(1000)
    expect(loadDraft(key())).toBeNull()
  })

  it('persistDraft:存成功返回 true;存储写不进去返回 false(离开会丢东西,调用方要拦);没有 draftId 返回 null', async () => {
    const { type, api } = mountPage()
    await type('要存的')
        expect(api().persistDraft()).toBe(true)
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError')
    }
    try {
      await type('存不进去的')
      expect(api().persistDraft()).toBe(false)
    } finally {
      Storage.prototype.setItem = original
    }
    expect(mountPage({ draftId: null }).api().persistDraft()).toBeNull()
  })

  it('没有改动时 persistDraft 返回 true(没有东西会丢)', () => {
    const { api } = mountPage()
    expect(api().persistDraft()).toBe(true)
  })

  it('弹条里压着一份没处理的旧草稿:不用新内容覆盖它;用户又在上面改了,返回 false(这些新改动没处可存)', async () => {
    saveDraft(key(), { title: '标题', body: '我的版本', base: '更早的原文', baseTitle: '标题' })
    const { title, body, type, api } = mountPage()
    await flushPromises()
        await type('压在旧草稿上又改了')
    expect(api().persistDraft()).toBe(false)
    expect(loadDraft(key())?.body).toBe('我的版本')
  })

  it('账号隔离:换一个账号看不到上一个人的草稿', async () => {
    saveDraft(scopedDraftId('usr_other', ID), { title: '别人的', body: '别人的正文', base: '原文', baseTitle: '标题' })
    const { wrapper, title, body } = mountPage()
    await flushPromises()
    expect(body.value).toBe('原文')
    expect(wrapper.find('.kb-dp-draft').exists()).toBe(false)
  })
})

describe('DocPage 草稿 · 多人编辑', () => {
  it('还没落地的正文留一份本机镜子(刷新后能接着看、能撤回),权威仍在房间', async () => {
    const provider = fakeProvider()
    const { type } = mountPage({ collab: provider, silentRestore: false })
    await type('和别人一起写的新内容')
    await vi.advanceTimersByTimeAsync(500)
    const stored = loadDraft(key())
    expect(stored?.body).toBe('和别人一起写的新内容')
    expect(stored?.room).toBe(true)
    expect(stored?.unsynced).toBe(false)
  })

  it('正文和服务器一致:不写镜子草稿', async () => {
    const provider = fakeProvider()
    const { type } = mountPage({ collab: provider, silentRestore: false })
    await type('原文')
    await vi.advanceTimersByTimeAsync(500)
    expect(loadDraft(key())).toBeNull()
  })

  it('服务器上的正文在镜子之后变过:镜子作废,清掉', async () => {
    saveDraft(key(), { title: '标题', body: '房间里的草稿', base: '更早的原文', baseTitle: '标题', room: true, unsynced: false })
    mountPage({ collab: fakeProvider(), silentRestore: false })
    await flushPromises()
    expect(loadDraft(key())).toBeNull()
  })

  it('离线期间改的、没发出去的正文要存(pendingLocal);重连同步后留成镜子(还没落地)', async () => {
    const provider = fakeProvider({ pendingLocal: true })
    const { type } = mountPage({ collab: provider, silentRestore: false })
    await type('离线时写的')
    await vi.advanceTimersByTimeAsync(500)
    const stored = loadDraft(key())
    expect(stored?.body).toBe('离线时写的')
    expect(stored?.unsynced).toBe(true)
    provider.set({ pendingLocal: false })
    await vi.advanceTimersByTimeAsync(10)
    const mirror = loadDraft(key())
    expect(mirror?.body).toBe('离线时写的')
    expect(mirror?.unsynced).toBe(false)
    expect(mirror?.room).toBe(true)
  })

  it('下次打开:有没同步的正文,永远不静默写回,给「复制出来」让人选', async () => {
    saveDraft(key(), { title: '标题', body: '离线时写的', base: '原文', baseTitle: '标题', unsynced: true })
    const provider = fakeProvider()
    const { wrapper, title, body } = mountPage({ collab: provider, silentRestore: false })
    await flushPromises()
    expect(body.value).toBe('原文')
    const ask = wrapper.find('[data-testid=draft-ask]')
    expect(ask.exists()).toBe(true)
    expect(ask.attributes('data-kind')).toBe('collab-body')
    expect(wrapper.find('[data-testid=draft-copy]').exists()).toBe(true)
    expect(wrapper.find('[data-testid=draft-restore]').exists()).toBe(false)
  })

  it('复制:写进剪贴板;剪贴板不可用就把内容摊开让人手动复制', async () => {
    saveDraft(key(), { title: '标题', body: '离线时写的', base: '原文', baseTitle: '标题', unsynced: true })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { wrapper, title, body } = mountPage({ collab: fakeProvider(), silentRestore: false })
    await flushPromises()
    await wrapper.find('[data-testid=draft-copy]').trigger('click')
    expect(writeText).toHaveBeenCalledWith('离线时写的')
    expect(wrapper.find('[data-testid=draft-copy]').text()).toBe('已复制')

    writeText.mockRejectedValue(new Error('denied'))
    await wrapper.find('[data-testid=draft-copy]').trigger('click')
    await flushPromises()
    expect(wrapper.find('textarea.kb-dp-draft-text').exists()).toBe(true)
  })

  it('已同步的多人草稿(正文空串)只放回标题,不会把正文清空', async () => {
    saveDraft(key(), { title: '新标题', body: '', base: '原文', baseTitle: '标题', unsynced: false })
    const { title, body } = mountPage({ collab: fakeProvider(), silentRestore: false })
    await flushPromises()
    expect(title.value).toBe('新标题')
    expect(body.value).toBe('原文')
  })

  it('多人编辑留下的已同步草稿,换成单人模式打开同一篇:只放回标题,不能把正文清空(否则点「完成」就存了空正文)', async () => {
    saveDraft(key(), { title: '新标题', body: '', base: '原文', baseTitle: '标题', unsynced: false })
    const { title, body } = mountPage()
    await flushPromises()
    expect(title.value).toBe('新标题')
    expect(body.value).toBe('原文')
  })

  it('多人编辑连接还在建立(collabPending):先不判断,等连上再说,避免读到一半的状态', async () => {
    saveDraft(key(), { title: '标题', body: '离线时写的', base: '原文', baseTitle: '标题', unsynced: true })
    const { wrapper, title, body } = mountPage({ collabPending: true, silentRestore: false })
    await flushPromises()
    expect(wrapper.find('.kb-dp-draft').exists()).toBe(false)
    expect(loadDraft(key())).not.toBeNull()
  })

  it('多人编辑点「撤回」:房间里的正文也换回服务器上那一版(不点保存就不落地)', async () => {
    const provider = fakeProvider()
    const { body, api } = mountPage({ collab: provider, silentRestore: false })
    await vi.advanceTimersByTimeAsync(500)
    api().revertToSaved()
    await nextTick()
    expect(commands).toEqual([{ type: 'text.replaceAll', args: { text: '原文' } }])
    expect(body.value).toBe('原文')
  })

  it('多人编辑的保存(saved)时还有没发出去的离线正文:草稿不能清,那是它唯一的副本', async () => {
    const provider = fakeProvider({ pendingLocal: true })
    const { type, api } = mountPage({ collab: provider, silentRestore: false })
    await type('离线时写的')
    await vi.advanceTimersByTimeAsync(500)
    ;api().saved()
    expect(loadDraft(key())?.body).toBe('离线时写的')
  })

  it('多人编辑连接对象已建好但第一次同步没完成:只有骨架，不挂编辑器（没有空工具栏 / 「正在连接」状态栏）；同步完才挂', async () => {
    const provider = fakeProvider({ status: 'connecting', everSynced: false, ready: false })
    const { wrapper } = mountPage({ collab: provider, silentRestore: false })
    await flushPromises()
    // 骨架组件是异步加载的，这里不看它，只看编辑器有没有挂
    expect(wrapper.find('.editor-stub').exists()).toBe(false)
    provider.set({ status: 'synced', everSynced: true, ready: true })
    await flushPromises()
    expect(wrapper.find('.editor-stub').exists()).toBe(true)
  })

  it('第一次连接就失败（断网 / 被拒）：放行编辑器去显示原因，不能让人对着骨架一直等；之后重连也不再拆掉', async () => {
    const provider = fakeProvider({ status: 'connecting', everSynced: false, ready: false })
    const { wrapper } = mountPage({ collab: provider, silentRestore: false })
    await flushPromises()
    provider.set({ status: 'offline' })
    await flushPromises()
    expect(wrapper.find('.editor-stub').exists()).toBe(true)
    provider.set({ status: 'connecting' })
    await flushPromises()
    expect(wrapper.find('.editor-stub').exists()).toBe(true)
  })

  it('服务端指定我来初始化房间（新笔记第一次打开）：必须挂编辑器，否则房间永远等不到初始化而死等', async () => {
    const provider = fakeProvider({ status: 'syncing', everSynced: false, ready: false })
    const { wrapper } = mountPage({ collab: provider, silentRestore: false })
    await flushPromises()
    expect(wrapper.find('.editor-stub').exists()).toBe(false)
    provider.set({ initMarkdown: '# 标题\n\n正文' })
    await flushPromises()
    expect(wrapper.find('.editor-stub').exists()).toBe(true)
    // 初始化完成后 initMarkdown 清空、房间就绪之前：编辑器不能被拆掉重装
    provider.set({ initMarkdown: null })
    await flushPromises()
    expect(wrapper.find('.editor-stub').exists()).toBe(true)
  })

  it('编辑时改正文开头的一级标题，文档标题跟着改；刚同步进来（前一刻还没有标题）不算改名', async () => {
    const { wrapper, title, body } = mountPage({ title: '旧名字', modelValue: '', baseBody: '# 旧名字\n\n正文' })
    await flushPromises()
    // 房间内容同步进来：标题和正文标题不一样也不能被悄悄改名
    body.value = '# 另一个标题\n\n正文'
    await flushPromises()
    expect(title.value).toBe('旧名字')
    // 用户改了这一行
    body.value = '# 另一个标题（改）\n\n正文'
    await flushPromises()
    expect(title.value).toBe('另一个标题（改）')
    // 删掉标题行：名字不变；正文开头没有一级标题了，页面把名字画成只读大标题（不是输入框），版面上仍看得出这篇叫什么
    body.value = '只剩正文'
    await flushPromises()
    expect(title.value).toBe('另一个标题（改）')
    const shown = wrapper.find('[data-testid="doc-virtual-title"] .kb-dp-title')
    expect(shown.element.tagName).toBe('H1')
    expect(shown.text()).toBe('另一个标题（改）')
    expect(wrapper.find('textarea.kb-dp-title').exists()).toBe(false)
  })
})
