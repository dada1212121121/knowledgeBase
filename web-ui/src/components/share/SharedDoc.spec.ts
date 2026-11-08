// 打开别人的文档:阅读 / 编辑(版本怎么取)/ 冲突 / 文件下载权限 / 四种状态。
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ShareAccess, ShareTarget } from '@/api/share'

// 重型组件换成桩:这里只测数据怎么取、怎么存、按钮什么时候出现
vi.mock('@/components/MarkdownRead.vue', () => ({ __esModule: true, default: { props: ['source'], template: '<div class="md-stub">{{ source }}</div>' } }))
vi.mock('@/components/CodeEditor.vue', () => ({
  __esModule: true,
  default: { props: ['modelValue', 'filename'], emits: ['update:modelValue', 'save'], template: '<textarea class="editor-stub" :data-filename="filename" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />' },
}))
vi.mock('@/components/FileViewer.vue', () => ({
  __esModule: true,
  default: { props: ['format', 'sourceUrl', 'rawUrl', 'content', 'fileName'], template: '<div class="fv-stub" :data-source="sourceUrl" :data-raw="rawUrl">{{ format }}|{{ content }}</div>' },
}))
const ask = vi.hoisted(() => vi.fn(async (_options: { title: string }) => true))
vi.mock('@kb-ui/index', async (original) => ({ ...(await original<Record<string, unknown>>()), useConfirm: () => ({ ask }) }))
vi.mock('./DocComments.vue', () => ({ default: { props: ['collection', 'source'], template: '<div class="comments-stub">{{ collection }}|{{ source }}</div>' } }))

// ---- 多人在线编辑:连接、落地、编辑器都换成可控的桩 ----
const collabFlags = vi.hoisted(() => ({ feature: true, lander: true, editorText: '协作后的正文' }))
const fakeProvider = vi.hoisted(() => ({
  destroyed: 0,
  getState: () => ({ lander: true, docEpoch: 0 }) as { lander: boolean; docEpoch: number },
  subscribe: () => () => undefined,
  destroy() {
    this.destroyed += 1
  },
}))
const openCollab = vi.hoisted(() => vi.fn())
const landAndWait = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/composables/useFeature', () => ({ useFeature: () => ({ get value() { return collabFlags.feature } }) }))
vi.mock('@/collab/session', () => ({ openCollab: (options: unknown) => openCollab(options) }))
vi.mock('@/collab/landing', () => ({ startLanding: () => () => undefined, landAndWait: (...args: unknown[]) => (landAndWait as (...a: unknown[]) => Promise<boolean>)(...args) }))
vi.mock('@/components/CollabBar.vue', () => ({ __esModule: true, default: { props: ['provider'], template: '<div class="collab-bar-stub" />' } }))
vi.mock('@/components/CollabAvatars.vue', () => ({ __esModule: true, default: { props: ['provider'], template: '<div class="collab-avatars-stub" />' } }))
// 统一编辑器外壳（分享页的协作编辑用它，旧的 DocEditor 已删）：桩记下打开请求里的关键字段，并暴露 currentText
vi.mock('@/editor/host/EditorHost.vue', () => ({
  __esModule: true,
  default: {
    props: ['request', 'textServices'],
    setup(_: unknown, { expose }: { expose: (api: object) => void }) {
      expose({ currentText: () => collabFlags.editorText })
      return {}
    },
    template:
      '<div class="doc-editor-stub" :data-collection="request.collection" :data-model="request.source.text" :data-format="request.format" :data-readonly="String(request.readonly)" :data-collab="request.collabRich ? 1 : 0" :data-can-upload="textServices.collection() === null ? 0 : 1" />',
  },
}))

vi.mock('@/components/OfficeEditor.vue', () => ({
  __esModule: true,
  default: {
    props: ['collection', 'path', 'spaceId'],
    emits: ['close', 'saved'],
    template: '<div class="office-editor-stub" :data-space="spaceId" :data-path="path"><button class="office-close-stub" @click="$emit(\'close\')" /></div>',
  },
}))

import SharedDoc from './SharedDoc.vue'

const note: ShareTarget = { kind: 'insight', space_id: 'sp_a', collection: '_global', id: 'ins_1' }
const file: ShareTarget = { kind: 'file', space_id: 'sp_a', collection: '_global', path: 'docs/guide.md' }
const call = vi.fn()
const access = (can: Partial<ShareAccess['can']> = {}): ShareAccess => ({
  call: call as ShareAccess['call'],
  rawUrl: (collection, path) => `/raw?c=${collection}&p=${path}`,
  can: { edit: false, comment: false, download: true, ...can },
})
const noteItem = { id: 'ins_1', collection: '_global', title: '部署清单', text: '# 正文', tags: ['运维'], updated_at: Date.now() - 60_000 }

async function mountDoc(target: ShareTarget, can: Partial<ShareAccess['can']> = {}) {
  const wrapper = mount(SharedDoc, { props: { target, access: access(can) }, attachTo: document.body })
  await flushPromises()
  return wrapper
}
const callsOf = (name: string) => call.mock.calls.filter(([capability]) => capability === name).map(([, args]) => args)
const typeInto = async (wrapper: ReturnType<typeof mount>, selector: string, value: string) => {
  const el = wrapper.find(selector).element as HTMLInputElement
  el.value = value
  await wrapper.find(selector).trigger('input')
}

beforeEach(() => {
  setActivePinia(createPinia())
  call.mockReset()
  ask.mockReset()
  ask.mockResolvedValue(true)
  call.mockImplementation(async (name: string) => {
    if (name === 'get_item') return { item: { ...noteItem } }
    if (name === 'file_preview') return { format: 'md', blocks: [], chunks: [], content: '# 指南', editable: true }
    if (name === 'item_history') return { items: [{ id: 'ins_1_v1', version: 1 }, { id: 'ins_1', version: 4 }] }
    if (name === 'file_versions') return { versions: [{ version: 7 }, { version: 6 }] }
    return {}
  })
  document.body.innerHTML = ''
})

describe('阅读', () => {
  it('笔记:get_item 取内容,显示标题 / 标签 / 正文,评论挂在 insight:<id> 上', async () => {
    const wrapper = await mountDoc(note)
    expect(callsOf('get_item')).toEqual([{ id: 'ins_1' }])
    expect(wrapper.find('[data-testid=shared-doc-title]').text()).toBe('部署清单')
    expect(wrapper.find('.md-stub').text()).toBe('# 正文')
    expect(wrapper.text()).toContain('#运维')
    expect(wrapper.find('.comments-stub').text()).toBe('_global|insight:ins_1')
    expect(wrapper.emitted('loaded')![0]).toEqual(['部署清单'])
  })

  it('文件:file_preview 取内容,评论挂在集合内路径上;能下载才给原件地址和下载链接', async () => {
    const wrapper = await mountDoc(file, { download: true })
    expect(callsOf('file_preview')).toEqual([{ collection: '_global', path: 'docs/guide.md' }])
    expect(wrapper.find('.fv-stub').attributes('data-source')).toBe('/raw?c=_global&p=docs/guide.md')
    expect(wrapper.find('[data-testid=shared-doc-download]').attributes('href')).toBe('/raw?c=_global&p=docs/guide.md')
    expect(wrapper.find('.comments-stub').text()).toBe('_global|docs/guide.md')

    const locked = await mountDoc(file, { download: false })
    expect(locked.find('.fv-stub').attributes('data-source')).toBeUndefined()
    expect(locked.find('[data-testid=shared-doc-download]').exists()).toBe(false)
  })

  it('微信 / QQ 里:能下载的文件在下载按钮旁提示「在浏览器中打开」;笔记、不能下载的文件、公开页(in-app-note=false)不重复提示', async () => {
    const agent = vi.spyOn(window.navigator, 'userAgent', 'get')
    try {
      agent.mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.40')
      const withFile = await mountDoc(file, { download: true })
      expect(withFile.find('[data-testid=inapp-download]').text()).toContain('在浏览器中打开')
      expect((await mountDoc(file, { download: false })).find('[data-testid=inapp-download]').exists()).toBe(false)
      expect((await mountDoc(note, { download: true })).find('[data-testid=inapp-download]').exists()).toBe(false)
      const quiet = mount(SharedDoc, { props: { target: file, access: access({ download: true }), inAppNote: false }, attachTo: document.body })
      await flushPromises()
      expect(quiet.find('[data-testid=inapp-download]').exists()).toBe(false)
      // 普通浏览器:不提示
      agent.mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36')
      expect((await mountDoc(file, { download: true })).find('[data-testid=inapp-download]').exists()).toBe(false)
    } finally {
      agent.mockRestore()
    }
  })

  it('图片这类可内联的格式给内联地址(关了下载也能预览),其它格式不给', async () => {
    call.mockImplementation(async () => ({ format: 'png', blocks: [], chunks: [] }))
    const image = await mountDoc({ kind: 'file', collection: '_global', path: 'a.png' }, { download: false })
    expect(image.find('.fv-stub').attributes('data-raw')).toBe('/raw?c=_global&p=a.png')
    call.mockImplementation(async () => ({ format: 'docx', blocks: [], chunks: [] }))
    const doc = await mountDoc({ kind: 'file', collection: '_global', path: 'a.docx' })
    expect(doc.find('.fv-stub').attributes('data-raw')).toBeUndefined()
  })

  it('加载失败:说清楚并可重试;没有权限(404)也是「没有打开」而不是白屏', async () => {
    call.mockRejectedValueOnce({ status: 404, message: 'not found: 没有找到这个内容' })
    const wrapper = await mountDoc(note)
    expect(wrapper.find('[data-testid=shared-doc-error]').text()).toContain('这篇文档没有打开')
    await wrapper.find('[data-testid=shared-doc-error] button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=shared-doc-title]').text()).toBe('部署清单')
  })
})

describe('谁能看到「编辑」', () => {
  it('只读:没有编辑按钮', async () => {
    expect((await mountDoc(note, { edit: false })).find('[data-testid=shared-doc-edit]').exists()).toBe(false)
  })
  it('可编辑的笔记:有;可编辑的文本文件:有;可编辑权限但格式不支持在线编辑:没有,并说明', async () => {
    expect((await mountDoc(note, { edit: true })).find('[data-testid=shared-doc-edit]').exists()).toBe(true)
    expect((await mountDoc(file, { edit: true })).find('[data-testid=shared-doc-edit]').exists()).toBe(true)
    call.mockImplementation(async () => ({ format: 'pdf', blocks: [], chunks: [], editable: false }))
    const pdf = await mountDoc({ kind: 'file', collection: '_global', path: 'a.pdf' }, { edit: true })
    expect(pdf.find('[data-testid=shared-doc-edit]').exists()).toBe(false)
    expect(pdf.find('[data-testid=shared-doc-edit-hint]').text()).toContain('不能在线编辑')
  })
})

describe('AI 的修改建议', () => {
  /** EditProposals 是异步组件:等它的 chunk 解析、发出请求(负向用例也等同样久,否则「没请求」可能只是还没来得及) */
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      await flushPromises()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  // 第一次动态 import 要现场编译,耗时不定:先预热,后面的等待才只需要覆盖「挂载 → 发请求」这一小段
  beforeAll(async () => {
    await import('@/components/EditProposals.vue')
  })
  it('共享给我(带 X-KB-Space 的登录协作者)能编辑:会去取建议', async () => {
    await mountDoc(file, { edit: true })
    await settle()
    expect(callsOf('doc_proposals')).toHaveLength(1)
  })
  it('经公开链接打开不取建议:链接白名单不含 doc_proposals,请求只会白挨 403(登录用户、游客都一样)', async () => {
    for (const guest of [false, true]) {
      call.mockClear()
      const wrapper = mount(SharedDoc, { props: { target: file, access: { ...access({ edit: true }), viaLink: true, ...(guest ? { guest: true } : {}) } }, attachTo: document.body })
      await flushPromises()
      await settle()
      expect(wrapper.find('[data-testid=shared-doc-edit]').exists()).toBe(true)
      expect(callsOf('doc_proposals')).toHaveLength(0)
    }
  })
})

describe('编辑笔记', () => {
  async function startEditing() {
    const wrapper = await mountDoc(note, { edit: true })
    await wrapper.find('[data-testid=shared-doc-edit]').trigger('click')
    await flushPromises() // 编辑器是异步组件
    return wrapper
  }

  it('进入编辑:标题框 + Markdown 源码编辑器;没改动时保存按钮禁用', async () => {
    const wrapper = await startEditing()
    expect(wrapper.find('[data-testid=shared-doc-editor]').exists()).toBe(true)
    expect(wrapper.find('.editor-stub').attributes('data-filename')).toBe('note.md')
    expect(wrapper.find('[data-testid=shared-doc-save]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.comments-stub').exists()).toBe(false)
  })

  it('保存:版本从版本链取到当前这一条(4),带标题和正文;保存后重读', async () => {
    const wrapper = await startEditing()
    await typeInto(wrapper, '.editor-stub', '# 新正文')
    await typeInto(wrapper, '[data-testid=shared-doc-title-input]', '  新标题 ')
    await wrapper.find('[data-testid=shared-doc-save]').trigger('click')
    await flushPromises()
    expect(callsOf('edit_item')).toEqual([{ id: 'ins_1', version: 4, title: '新标题', body: '# 新正文' }])
    expect(callsOf('get_item')).toHaveLength(2)
    expect(wrapper.find('[data-testid=shared-doc-editor]').exists()).toBe(false)
    expect(wrapper.emitted('changed')).toHaveLength(1)
  })

  it('get_item 以后带了 version 就直接用它,不再去查版本链', async () => {
    call.mockImplementation(async (name: string) => (name === 'get_item' ? { item: { ...noteItem, version: 9 } } : {}))
    const wrapper = await startEditing()
    await typeInto(wrapper, '.editor-stub', '改')
    await wrapper.find('[data-testid=shared-doc-save]').trigger('click')
    await flushPromises()
    expect(callsOf('edit_item')[0]).toMatchObject({ version: 9 })
    expect(callsOf('item_history')).toHaveLength(0)
  })

  it('通过链接拿不到版本链(403):只能退回 1——不假装知道真实版本', async () => {
    call.mockImplementation(async (name: string) => {
      if (name === 'item_history') throw { status: 403, message: 'forbidden: 通过分享链接不能进行这个操作' }
      return name === 'get_item' ? { item: { ...noteItem } } : {}
    })
    const wrapper = await startEditing()
    await typeInto(wrapper, '.editor-stub', '改')
    await wrapper.find('[data-testid=shared-doc-save]').trigger('click')
    await flushPromises()
    expect(callsOf('edit_item')[0]).toMatchObject({ version: 1 })
  })

  it('版本冲突(409):保存失败如实说,不丢用户的修改,给「重新载入」', async () => {
    call.mockImplementation(async (name: string) => {
      if (name === 'edit_item') throw { status: 409, message: 'version conflict: expected 1, got 3' }
      return name === 'get_item' ? { item: { ...noteItem } } : {}
    })
    const wrapper = await startEditing()
    await typeInto(wrapper, '.editor-stub', '我写的很长的内容')
    await wrapper.find('[data-testid=shared-doc-save]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=shared-doc-save-error]').text()).toContain('内容刚被别人改过')
    expect(wrapper.text()).not.toContain('expected 1')
    expect((wrapper.find('.editor-stub').element as HTMLTextAreaElement).value).toBe('我写的很长的内容')
    await wrapper.find('[data-testid=shared-doc-reload]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=shared-doc-editor]').exists()).toBe(false)
  })

  it('其它保存失败(无权限等):就近显示服务端的话', async () => {
    call.mockImplementation(async (name: string) => {
      if (name === 'edit_item') throw { status: 403, message: 'forbidden: 你对这个内容的权限是「可评论」,需要「可编辑」' }
      return name === 'get_item' ? { item: { ...noteItem } } : {}
    })
    const wrapper = await startEditing()
    await typeInto(wrapper, '.editor-stub', '改')
    await wrapper.find('[data-testid=shared-doc-save]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=shared-doc-save-error]').text()).toContain('需要「可编辑」')
    expect(wrapper.find('[data-testid=shared-doc-reload]').exists()).toBe(false)
  })

  it('标题或正文清空:前端先拦住,不发请求', async () => {
    const wrapper = await startEditing()
    await typeInto(wrapper, '[data-testid=shared-doc-title-input]', '   ')
    await wrapper.find('[data-testid=shared-doc-save]').trigger('click')
    expect(wrapper.find('[data-testid=shared-doc-save-error]').text()).toBe('标题不能为空。')
    await typeInto(wrapper, '[data-testid=shared-doc-title-input]', '标题')
    await typeInto(wrapper, '.editor-stub', '  ')
    await wrapper.find('[data-testid=shared-doc-save]').trigger('click')
    expect(wrapper.find('[data-testid=shared-doc-save-error]').text()).toBe('正文不能为空。')
    expect(callsOf('edit_item')).toHaveLength(0)
  })

  it('取消:有改动先确认放弃;没改动直接退出;选「继续编辑」留在编辑里', async () => {
    const wrapper = await startEditing()
    await wrapper.find('[data-testid=shared-doc-cancel]').trigger('click')
    await flushPromises()
    expect(ask).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid=shared-doc-editor]').exists()).toBe(false)

    await wrapper.find('[data-testid=shared-doc-edit]').trigger('click')
    await flushPromises()
    await typeInto(wrapper, '.editor-stub', '改了')
    ask.mockResolvedValueOnce(false)
    await wrapper.find('[data-testid=shared-doc-cancel]').trigger('click')
    await flushPromises()
    expect(ask.mock.calls[0]![0].title).toBe('放弃未保存的修改?')
    expect(wrapper.find('[data-testid=shared-doc-editor]').exists()).toBe(true)
    await wrapper.find('[data-testid=shared-doc-cancel]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=shared-doc-editor]').exists()).toBe(false)
  })

  it('改动状态通知上层(切走前要提醒)', async () => {
    const wrapper = await startEditing()
    await typeInto(wrapper, '.editor-stub', '改')
    expect(wrapper.emitted('dirty')!.at(-1)).toEqual([true])
  })
})

describe('编辑文件', () => {
  it('保存:乐观锁版本取文件历史最新一条;取不到(通过链接)就不带,以最后一次保存为准', async () => {
    const wrapper = await mountDoc(file, { edit: true })
    await wrapper.find('[data-testid=shared-doc-edit]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.editor-stub').attributes('data-filename')).toBe('docs/guide.md')
    await typeInto(wrapper, '.editor-stub', '# 新指南')
    await wrapper.find('[data-testid=shared-doc-save]').trigger('click')
    await flushPromises()
    expect(callsOf('save_file')).toEqual([{ collection: '_global', path: 'docs/guide.md', content: '# 新指南', expected_version: 7 }])

    call.mockImplementation(async (name: string) => {
      if (name === 'file_versions') throw { status: 403, message: 'forbidden: 通过分享链接不能进行这个操作' }
      return name === 'file_preview' ? { format: 'md', blocks: [], chunks: [], content: '# 指南', editable: true } : {}
    })
    call.mockClear()
    const viaLink = await mountDoc(file, { edit: true })
    await viaLink.find('[data-testid=shared-doc-edit]').trigger('click')
    await flushPromises()
    await typeInto(viaLink, '.editor-stub', '# 再改')
    await viaLink.find('[data-testid=shared-doc-save]').trigger('click')
    await flushPromises()
    expect(callsOf('save_file')).toEqual([{ collection: '_global', path: 'docs/guide.md', content: '# 再改' }])
  })
})

describe('多人在线编辑', () => {
  const collabAccess = (extra: Partial<ShareAccess> = {}): ShareAccess => ({ ...access({ edit: true }), collab: { spaceId: 'sp_a' }, ...extra })
  const mountCollab = async (target: ShareTarget, extra: Partial<ShareAccess> = {}) => {
    const wrapper = mount(SharedDoc, { props: { target, access: collabAccess(extra) }, attachTo: document.body })
    await flushPromises()
    return wrapper
  }

  beforeEach(() => {
    collabFlags.feature = true
    collabFlags.editorText = '协作后的正文'
    fakeProvider.destroyed = 0
    fakeProvider.getState = () => ({ lander: true, docEpoch: 0 })
    openCollab.mockReset()
    openCollab.mockReturnValue(fakeProvider)
    landAndWait.mockClear()
  })

  it('点「编辑」:按笔记所在的知识库 / 集合连房间,显示协作编辑器和「完成」,没有「取消」和源码框', async () => {
    const wrapper = await mountCollab(note)
    await wrapper.find('[data-testid=shared-doc-edit]').trigger('click')
    await flushPromises()
    expect(openCollab).toHaveBeenCalledWith({ spaceId: 'sp_a', collection: '_global', doc: { insight: 'ins_1' } })
    expect(wrapper.find('.doc-editor-stub').exists()).toBe(true)
    expect(wrapper.find('.collab-bar-stub').exists()).toBe(true)
    expect(wrapper.find('.collab-avatars-stub').exists()).toBe(true)
    expect(wrapper.find('[data-testid=shared-doc-finish]').exists()).toBe(true)
    expect(wrapper.find('[data-testid=shared-doc-cancel]').exists()).toBe(false)
    expect(wrapper.find('.editor-stub').exists()).toBe(false)
  })

  it('协作编辑器拿到的打开请求里原文是笔记正文,不是空串:否则直接点「完成」会落地空正文', async () => {
    const wrapper = await mountCollab(note)
    await wrapper.find('[data-testid=shared-doc-edit]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.doc-editor-stub').attributes('data-model')).toBe('# 正文')
  })

  it('协作编辑器是可写的 Markdown 会话、挂着房间；分享页是别人的库，粘贴图片 / 附件不能上传', async () => {
    const wrapper = await mountCollab(note)
    await wrapper.find('[data-testid=shared-doc-edit]').trigger('click')
    await flushPromises()
    const stub = wrapper.find('.doc-editor-stub')
    expect(stub.attributes('data-format')).toBe('md')
    expect(stub.attributes('data-readonly')).toBe('false')
    expect(stub.attributes('data-collab')).toBe('1')
    expect(stub.attributes('data-collection')).toBe('_global')
    expect(stub.attributes('data-can-upload')).toBe('0')
  })

  it('只读分享（没有编辑权限）：阅读用 MarkdownRead，没有「编辑」入口，也不连房间、不挂外壳', async () => {
    const viewer = mount(SharedDoc, { props: { target: note, access: { ...access({ edit: false }), collab: { spaceId: 'sp_a' } } }, attachTo: document.body })
    await flushPromises()
    expect(viewer.find('.md-stub').text()).toBe('# 正文')
    expect(viewer.find('[data-testid=shared-doc-edit]').exists()).toBe(false)
    expect(viewer.find('.doc-editor-stub').exists()).toBe(false)
    expect(openCollab).not.toHaveBeenCalled()
  })

  it('连接还没建好的这段时间:只显示「正在连接」,不显示单人编辑器(输入会在连上后被整个换掉)', async () => {
    const wrapper = await mountCollab(note)
    // 点击后、连接建好之前(动态加载协作模块还没完成)的同步状态
    wrapper.find('[data-testid=shared-doc-edit]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.editor-stub').exists()).toBe(false)
    expect(wrapper.find('[data-testid=shared-doc-connecting]').exists()).toBe(true)
    expect(wrapper.find('[data-testid=shared-doc-cancel]').exists()).toBe(false)
    await flushPromises()
    expect(wrapper.find('[data-testid=shared-doc-connecting]').exists()).toBe(false)
    expect(wrapper.find('.doc-editor-stub').exists()).toBe(true)
  })

  it('链接访问者:带上链接令牌', async () => {
    const wrapper = await mountCollab(note, { collab: { spaceId: 'sp_a', linkToken: 'tok123' } })
    await wrapper.find('[data-testid=shared-doc-edit]').trigger('click')
    await flushPromises()
    expect(openCollab).toHaveBeenCalledWith({ spaceId: 'sp_a', collection: '_global', doc: { insight: 'ins_1' }, linkToken: 'tok123' })
  })

  it('没有「多人在线编辑」功能点(登录用户)或入口不支持协作:退回原来的整篇源码编辑,不连房间', async () => {
    collabFlags.feature = false
    const off = await mountCollab(note)
    await off.find('[data-testid=shared-doc-edit]').trigger('click')
    await flushPromises()
    expect(openCollab).not.toHaveBeenCalled()
    expect(off.find('.editor-stub').exists()).toBe(true)

    collabFlags.feature = true
    const plain = mount(SharedDoc, { props: { target: note, access: access({ edit: true }) }, attachTo: document.body })
    await flushPromises()
    await plain.find('[data-testid=shared-doc-edit]').trigger('click')
    await flushPromises()
    expect(openCollab).not.toHaveBeenCalled()
  })

  it('游客没有账号功能表:不看功能点,链接允许编辑就连房间', async () => {
    collabFlags.feature = false
    const wrapper = await mountCollab(note, { guest: true, collab: { spaceId: 'sp_a', linkToken: 't' } })
    await wrapper.find('[data-testid=shared-doc-edit]').trigger('click')
    await flushPromises()
    expect(openCollab).toHaveBeenCalledTimes(1)
  })

  it('「完成」(标题没改):先落地并等确认,不调 edit_item,断开连接,回到阅读', async () => {
    const wrapper = await mountCollab(note)
    await wrapper.find('[data-testid=shared-doc-edit]').trigger('click')
    await flushPromises()
    call.mockClear()
    await wrapper.find('[data-testid=shared-doc-finish]').trigger('click')
    await flushPromises()
    expect(landAndWait).toHaveBeenCalledTimes(1)
    expect(callsOf('edit_item')).toEqual([])
    expect(fakeProvider.destroyed).toBeGreaterThanOrEqual(1)
    expect(wrapper.find('[data-testid=shared-doc-editor]').exists()).toBe(false)
  })

  it('「完成」(改了标题):只提交标题,不带 body(正文由房间落地)', async () => {
    const wrapper = await mountCollab(note)
    await wrapper.find('[data-testid=shared-doc-edit]').trigger('click')
    await flushPromises()
    const input = wrapper.find('[data-testid=shared-doc-title-input] input, input[data-testid=shared-doc-title-input]')
    ;(input.element as HTMLInputElement).value = '新标题'
    await input.trigger('input')
    call.mockClear()
    await wrapper.find('[data-testid=shared-doc-finish]').trigger('click')
    await flushPromises()
    expect(callsOf('edit_item')).toEqual([{ id: 'ins_1', version: 4, title: '新标题' }])
  })

  it('不是落地者时「完成」:读到的可能还是旧正文,先显示自己编辑器里的最终内容', async () => {
    fakeProvider.getState = () => ({ lander: false, docEpoch: 0 })
    const wrapper = await mountCollab(note)
    await wrapper.find('[data-testid=shared-doc-edit]').trigger('click')
    await flushPromises()
    collabFlags.editorText = '我写的最终内容'
    await wrapper.find('[data-testid=shared-doc-finish]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=shared-doc-body]').text()).toContain('我写的最终内容')
  })

  it('是落地者时「完成」:落地完成后显示服务器上的正文,不用本地内容覆盖', async () => {
    const wrapper = await mountCollab(note)
    await wrapper.find('[data-testid=shared-doc-edit]').trigger('click')
    await flushPromises()
    collabFlags.editorText = '本地内容'
    await wrapper.find('[data-testid=shared-doc-finish]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=shared-doc-body]').text()).toContain('# 正文')
    expect(wrapper.find('[data-testid=shared-doc-body]').text()).not.toContain('本地内容')
  })

  it('纯文本 / 代码文件:连文件房间(按路径),用代码编辑器,不走落地(服务端自己取正文)', async () => {
    const textFile: ShareTarget = { kind: 'file', space_id: 'sp_a', collection: '_global', path: 'docs/notes.txt' }
    const wrapper = await mountCollab(textFile)
    await wrapper.find('[data-testid=shared-doc-edit]').trigger('click')
    await flushPromises()
    expect(openCollab).toHaveBeenCalledWith({ spaceId: 'sp_a', collection: '_global', doc: { file: 'docs/notes.txt' } })
    expect(wrapper.find('.doc-editor-stub').exists()).toBe(false)
    expect(wrapper.find('.editor-stub').exists()).toBe(true)
  })

  it('Markdown 文件:房间是富文本,用所见即所得编辑器并由它落地;不能拿代码编辑器绑到富文本房间上', async () => {
    const wrapper = await mountCollab(file)
    await wrapper.find('[data-testid=shared-doc-edit]').trigger('click')
    await flushPromises()
    expect(openCollab).toHaveBeenCalledWith({ spaceId: 'sp_a', collection: '_global', doc: { file: 'docs/guide.md' } })
    expect(wrapper.find('.doc-editor-stub').exists()).toBe(true)
    expect(wrapper.find('.editor-stub').exists()).toBe(false)
    // 「完成」先落地(富文本房间的正文由编辑器序列化成 Markdown 交上去)
    await wrapper.find('[data-testid=shared-doc-finish]').trigger('click')
    await flushPromises()
    expect(landAndWait).toHaveBeenCalledTimes(1)
  })

  it('Word / Excel / PowerPoint:能编辑的登录协作者有「在线编辑」,打开对方知识库里的协同编辑器;关掉后重读', async () => {
    const sheet: ShareTarget = { kind: 'file', space_id: 'sp_a', collection: '_global', path: '报表/月报.xlsx' }
    call.mockImplementation(async (name: string) => (name === 'file_preview' ? { format: 'xlsx', blocks: [], chunks: [], editable: false } : {}))
    const wrapper = await mountCollab(sheet)
    expect(wrapper.find('[data-testid=shared-doc-edit-hint]').exists()).toBe(false)
    await wrapper.find('[data-testid=shared-doc-office-edit]').trigger('click')
    await flushPromises()
    // 编辑器要放在有确定高度的容器里(它按父元素的高度铺满)
    const editor = wrapper.find('[data-testid=shared-doc-office] .office-editor-stub')
    expect(editor.exists()).toBe(true)
    expect(editor.attributes('data-space')).toBe('sp_a')
    expect(editor.attributes('data-path')).toBe('报表/月报.xlsx')
    call.mockClear()
    await wrapper.find('.office-close-stub').trigger('click')
    await flushPromises()
    expect(wrapper.find('.office-editor-stub').exists()).toBe(false)
    expect(callsOf('file_preview')).toHaveLength(1)
  })

  it('Office 文件:只能查看、游客(链接)、没有「多人在线编辑」功能点:没有「在线编辑」', async () => {
    const sheet: ShareTarget = { kind: 'file', space_id: 'sp_a', collection: '_global', path: '月报.docx' }
    call.mockImplementation(async (name: string) => (name === 'file_preview' ? { format: 'docx', blocks: [], chunks: [], editable: false } : {}))
    const viewer = mount(SharedDoc, { props: { target: sheet, access: { ...access({ edit: false }), collab: { spaceId: 'sp_a' } } }, attachTo: document.body })
    await flushPromises()
    expect(viewer.find('[data-testid=shared-doc-office-edit]').exists()).toBe(false)
    viewer.unmount()
    const guest = await mountCollab(sheet, { guest: true, collab: { spaceId: 'sp_a', linkToken: 'tok' } })
    expect(guest.find('[data-testid=shared-doc-office-edit]').exists()).toBe(false)
    guest.unmount()
    collabFlags.feature = false
    const noFeature = await mountCollab(sheet)
    expect(noFeature.find('[data-testid=shared-doc-office-edit]').exists()).toBe(false)
  })

  it('离开页面时断开连接', async () => {
    const wrapper = await mountCollab(note)
    await wrapper.find('[data-testid=shared-doc-edit]').trigger('click')
    await flushPromises()
    wrapper.unmount()
    expect(fakeProvider.destroyed).toBeGreaterThanOrEqual(1)
  })
})


describe('悬浮目录 (TOC)', () => {
  const noteWithHeadings: ShareTarget = { kind: 'insight', space_id: 'sp_a', collection: '_global', id: 'ins_toc' }
  const fileWithHeadings: ShareTarget = { kind: 'file', space_id: 'sp_a', collection: '_global', path: 'SampleERP使用手册.md' }

  const widthOf = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  function setContainerWidth(width: number) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width })
  }

  beforeEach(() => {
    localStorage.clear()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)
    call.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_item' && args.id === 'ins_toc') {
        return {
          item: {
            id: 'ins_toc',
            collection: '_global',
            title: '团队通用规范',
            text: ['# 概述', '正文内容', '## 第一章 协作', '内容', '## 第二章 交付', '内容'].join('\n'),
            tags: [],
            updated_at: Date.now(),
          },
        }
      }
      if (name === 'file_preview' && args.path === 'SampleERP使用手册.md') {
        return {
          format: 'md',
          blocks: [],
          chunks: [],
          content: ['# 使用手册', '前言', '## 1 登录', '说明', '## 2 报表', '说明'].join('\n'),
          editable: false,
        }
      }
      return {}
    })
  })

  afterEach(() => {
    if (widthOf) Object.defineProperty(HTMLElement.prototype, 'clientWidth', widthOf)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
  })

  it('宽屏下笔记标题 >= 2 时默认展开悬浮目录，支持折叠与展开并记住选择', async () => {
    setContainerWidth(1000)
    const wrapper = await mountDoc(noteWithHeadings)
    expect(wrapper.find('[data-testid=doc-toc]').exists()).toBe(true)
    const items = wrapper.findAll('.kb-dp-toc-item')
    expect(items.map((i) => i.text())).toEqual(['第一章 协作', '第二章 交付'])

    // 折叠目录
    await wrapper.find('[data-testid=toc-collapse]').trigger('click')
    expect(wrapper.find('.kb-dp-toc-item').exists()).toBe(false)
    expect(wrapper.find('[data-testid=toc-expand]').exists()).toBe(true)
    expect(localStorage.getItem('kb.doc.toc.collapsed')).toBe('1')

    // 展开目录
    await wrapper.find('[data-testid=toc-expand]').trigger('click')
    expect(wrapper.findAll('.kb-dp-toc-item')).toHaveLength(2)
    expect(localStorage.getItem('kb.doc.toc.collapsed')).toBe('0')
    wrapper.unmount()
  })

  it('宽屏下 Markdown 文件标题 >= 2 时同样展示悬浮目录', async () => {
    setContainerWidth(1000)
    const wrapper = await mountDoc(fileWithHeadings)
    expect(wrapper.find('[data-testid=doc-toc]').exists()).toBe(true)
    const items = wrapper.findAll('.kb-dp-toc-item')
    expect(items.map((i) => i.text())).toEqual(['1 登录', '2 报表'])
    wrapper.unmount()
  })

  it('窄屏下展示标题旁的目录按钮，点击弹出底部抽屉', async () => {
    setContainerWidth(600)
    const wrapper = await mountDoc(noteWithHeadings)
    expect(wrapper.find('[data-testid=doc-toc]').exists()).toBe(false)
    const btn = wrapper.find('[data-testid=toc-btn-mobile]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('大纲')

    await btn.trigger('click')
    expect(document.body.querySelector('.kb-dp-sheet')).not.toBeNull()
    expect(document.body.querySelectorAll('.kb-dp-sheet .kb-dp-toc-item')).toHaveLength(2)
    wrapper.unmount()
  })

  it('Word docx 文件通过 blocks 提取目录，点击目录项可定位并跳转到 docx_heading 元素', async () => {
    setContainerWidth(1000)
    const docxTarget: ShareTarget = { kind: 'file', space_id: 'sp_a', collection: '_global', path: 'SampleERP使用手册.docx' }
    call.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'file_preview' && args.path === 'SampleERP使用手册.docx') {
        return {
          format: 'docx',
          blocks: [
            { kind: 'heading', text: '# 1  第一次使用' },
            { kind: 'heading', text: '## 1.1 登录' },
            { kind: 'heading', text: '# 7 系统管理' },
          ],
          chunks: [],
          content: null,
          editable: false,
        }
      }
      return {}
    })

    const wrapper = await mountDoc(docxTarget)
    expect(wrapper.find('[data-testid=doc-toc]').exists()).toBe(true)
    const tocItems = wrapper.findAll('.kb-dp-toc-item')
    expect(tocItems.map((i) => i.text())).toEqual(['1  第一次使用', '1.1 登录', '7 系统管理'])

    // 模拟 docx-preview 在正文 DOM 中渲染出的内部滚动容器与 docx_heading 段落
    const body = wrapper.find('[data-testid=shared-doc-body]').element
    const scroller = document.createElement('div')
    scroller.className = 'kb-dx-scroll'
    scroller.style.overflowY = 'auto'
    const scrollToSpy = vi.fn()
    scroller.scrollTo = scrollToSpy

    const h1 = document.createElement('p')
    h1.className = 'kbdocx_heading1'
    h1.textContent = '1  第一次使用'
    const scrollIntoViewH1 = vi.fn()
    h1.scrollIntoView = scrollIntoViewH1

    const h2 = document.createElement('p')
    h2.className = 'kbdocx_heading2'
    h2.textContent = '1.1  登录'
    const scrollIntoViewH2 = vi.fn()
    h2.scrollIntoView = scrollIntoViewH2

    const h3 = document.createElement('p')
    h3.className = 'kbdocx_heading1'
    h3.textContent = '7 系统管理'
    const scrollIntoViewH3 = vi.fn()
    h3.scrollIntoView = scrollIntoViewH3

    scroller.append(h1, h2, h3)
    body.appendChild(scroller)

    // 点击第二个目录项（1.1 登录，注意 TOC 文本为 "1.1 登录" 与 DOM "1.1  登录" 间空格数差异，应能规范化模糊匹配）
    await tocItems[1].trigger('click')
    expect(scrollToSpy).toHaveBeenCalled()
    expect(wrapper.find('.kb-dp-toc-item.is-on').text()).toBe('1.1 登录')

    // 点击第三个目录项（7 系统管理）
    await tocItems[2].trigger('click')
    expect(wrapper.find('.kb-dp-toc-item.is-on').text()).toBe('7 系统管理')

    wrapper.unmount()
  })
})
