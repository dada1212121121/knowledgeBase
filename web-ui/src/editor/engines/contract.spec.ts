import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import {
  BETTEROFFICE_ENGINE_VERSION,
  LOCKED_ENGINE_PACKAGES,
  PPTX_WORKER_REPLAY_METHODS,
  PPTX_WORKER_UNSUPPORTED_METHODS,
  VERIFIED_ENGINE_EXPORTS,
  XLSX_EDIT_CHANNEL,
} from './version'
import {
   EditorChrome,
  EditorHost,
  canExecuteCommand,
  formatAnchorKey,
  isLegacyOfficeFormat,
  normalizeFormat,
  resolveSurfaceKind,
  type Anchor,
  type EditorOpenRequest,
  type EditorPermissions,
} from '../index'

const FULL_PERMISSIONS: EditorPermissions = {
  read: true,
  write: true,
  comment: true,
  ai: true,
  export: true,
}

// 用 Vite glob 替掉 node:fs：既避开未安装的 @types/node，
// 也保证“扫全仓 src/editor 是否越权 import”在浏览器式构建下同样生效。
const EDITOR_SOURCES = import.meta.glob(['../**/*.{ts,vue}', '!../engines/**', '!../**/*.spec.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const PACKAGE_JSON_RAW = import.meta.glob(['../../../package.json'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const DOCX_PACKAGE_JSON_RAW = import.meta.glob(
  ['../../../node_modules/@betteroffice/docx/package.json'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>

const VITE_CONFIG_RAW = import.meta.glob(['../../../vite.config.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

describe(' 架构契约与上游 Headless 引擎边界验证', () => {
  it('1. package.json 将 @betteroffice/{docx,xlsx,pptx} 声明为直接依赖且精确锁死 0.5.1', () => {
    const pkgJson = JSON.parse(Object.values(PACKAGE_JSON_RAW)[0]) as {
      dependencies?: Record<string, string>
    }
    const deps = pkgJson.dependencies ?? {}
    for (const [pkgName, expectedVersion] of Object.entries(LOCKED_ENGINE_PACKAGES)) {
      expect(deps[pkgName], `${pkgName} 必须在 dependencies 中显式声明`).toBe(expectedVersion)
      expect(deps[pkgName]).not.toMatch(/^[\^~]/)
    }
    expect(BETTEROFFICE_ENGINE_VERSION).toBe('0.5.1')
  })

  it('2. 除 src/editor/engines/ 外，editor 其余模块严禁直接 import @betteroffice/*', () => {
    const files = Object.keys(EDITOR_SOURCES)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const content = EDITOR_SOURCES[file]
      expect(content, `${file} 不得越过 engines/ 直接引用 @betteroffice/*`).not.toMatch(
        /from\s+['"]@betteroffice\//,
      )
    }
  })

  it('3. @betteroffice/docx 核心与子路径导出签名符合 0.5.1 契约', async () => {
    const docxCore = await import('@betteroffice/docx')
    for (const fnName of VERIFIED_ENGINE_EXPORTS.docx.core) {
      expect(typeof (docxCore as Record<string, unknown>)[fnName], `docx.${fnName}`).toBe('function')
    }

    const docxLayout = await import('@betteroffice/docx/layout')
    for (const fnName of VERIFIED_ENGINE_EXPORTS.docx.layout) {
      expect(typeof (docxLayout as Record<string, unknown>)[fnName], `docx/layout.${fnName}`).toBe(
        'function',
      )
    }

    const docxRender = await import('@betteroffice/docx/layout/render')
    for (const fnName of VERIFIED_ENGINE_EXPORTS.docx.layoutRender) {
      expect(typeof (docxRender as Record<string, unknown>)[fnName], `docx/layout/render.${fnName}`).toBe(
        'function',
      )
    }

    const docxWorker = await import('@betteroffice/docx/worker')
    for (const fnName of VERIFIED_ENGINE_EXPORTS.docx.worker) {
      expect(typeof (docxWorker as Record<string, unknown>)[fnName], `docx/worker.${fnName}`).toBe(
        'function',
      )
    }

    const docxEditor = await import('@betteroffice/docx/editor')
    for (const fnName of VERIFIED_ENGINE_EXPORTS.docx.editor) {
      expect(
        typeof (docxEditor as Record<string, unknown>)[fnName],
        `docx/editor.${fnName}`,
      ).toBe('function')
    }

    const docxYrs = await import('@betteroffice/docx/yrs')
    for (const fnName of VERIFIED_ENGINE_EXPORTS.docx.yrs) {
      expect(typeof (docxYrs as Record<string, unknown>)[fnName], `docx/yrs.${fnName}`).toBe('function')
    }

    const docxCollab = await import('@betteroffice/docx/collaboration')
    for (const fnName of VERIFIED_ENGINE_EXPORTS.docx.collaboration) {
      expect(
        typeof (docxCollab as Record<string, unknown>)[fnName],
        `docx/collaboration.${fnName}`,
      ).toBe('function')
    }
  })

  it('4. @betteroffice/docx/layout 无任何分页入口，验证阶段 3 双模只读架构依据', async () => {
    const docxLayout = await import('@betteroffice/docx/layout')
    // 0.5.1 的 layout 子包只提供字体测量与选择门控原语：
    // 整篇分页 DisplayPage[] 只存在于 docx_edit_wasm 会话，因此默认只读不能走 WASM 分页。
    expect((docxLayout as Record<string, unknown>).layoutDocument).toBeUndefined()
    expect((docxLayout as Record<string, unknown>).layoutParagraph).toBeUndefined()
    expect((docxLayout as Record<string, unknown>).layoutTable).toBeUndefined()
    expect(typeof docxLayout.resolveHeaderFooter).toBe('function')
  })

  it('5. @betteroffice/xlsx 导出签名符合 0.5.1 契约，且协同 Provider 只在 /collaboration 子路径', async () => {
    const xlsxCore = await import('@betteroffice/xlsx')
    for (const fnName of VERIFIED_ENGINE_EXPORTS.xlsx.core) {
      expect(typeof (xlsxCore as Record<string, unknown>)[fnName], `xlsx.${fnName}`).toBe('function')
    }
    // 主入口不得误导出协同 Provider，否则说明上游做了破坏性重排
    expect((xlsxCore as Record<string, unknown>).CollaborationProvider).toBeUndefined()

    const xlsxCollab = await import('@betteroffice/xlsx/collaboration')
    for (const fnName of VERIFIED_ENGINE_EXPORTS.xlsx.collaboration) {
      expect(
        typeof (xlsxCollab as Record<string, unknown>)[fnName],
        `xlsx/collaboration.${fnName}`,
      ).toBe('function')
    }

    // 编辑通道：公开 command 入口存在即可，无需触碰未导出的内部 Connection
    expect(XLSX_EDIT_CHANNEL.sessionFactory).toBe('createWorkbookEditSession')
    expect(XLSX_EDIT_CHANNEL.commandEntry).toBe('command')
  })

  it('6. @betteroffice/pptx 导出签名符合 0.5.1 契约，Worker 编辑会话覆盖图层/形状/对齐', async () => {
    const pptxCore = await import('@betteroffice/pptx')
    for (const fnName of VERIFIED_ENGINE_EXPORTS.pptx.core) {
      expect(typeof (pptxCore as Record<string, unknown>)[fnName], `pptx.${fnName}`).toBe('function')
    }

    // 依赖的能力声明必须与上游 replayMethods 一致：
    // 少一项意味着图层面板/对齐/形状插入会静默失效，因此在此锁死。
    for (const method of [
      'addTextBox',
      'addShape',
      'addPicture',
      'removeShape',
      'moveShape',
      'resizeShape',
      'bringShapeToFront',
      'sendShapeBackward',
      'duplicateSlide',
      'setSlideNotes',
      'setShapeFill',
      'setShapeStroke',
    ]) {
      expect(PPTX_WORKER_REPLAY_METHODS as readonly string[], `replay.${method}`).toContain(method)
    }
    // 表格行列增删是上游明确的 Worker 边界缺口，必须在计划中按限制处理
    expect(PPTX_WORKER_UNSUPPORTED_METHODS).toHaveLength(4)
    // 39 = 上游 replayMethods 43 项 - 4 项表格行列操作；数字漂移必须人工复核再改
    expect(PPTX_WORKER_REPLAY_METHODS).toHaveLength(39)
    for (const method of PPTX_WORKER_UNSUPPORTED_METHODS) {
      expect(PPTX_WORKER_REPLAY_METHODS as readonly string[]).not.toContain(method)
    }
  })

  it('7. normalizeFormat 与 resolveSurfaceKind 正确映射 6 类内容面', () => {
    expect(normalizeFormat('docs/guide/README.MD?v=1#top')).toBe('md')
    expect(resolveSurfaceKind('note.md')).toBe('text')
    expect(resolveSurfaceKind('plain.txt')).toBe('text')
    expect(resolveSurfaceKind('table.csv')).toBe('grid')
    expect(resolveSurfaceKind('sheet.tsv')).toBe('grid')
    expect(resolveSurfaceKind('finance.xlsx')).toBe('grid')
    expect(resolveSurfaceKind('legacy.xls')).toBe('grid')
    expect(resolveSurfaceKind('contract.docx')).toBe('page')
    expect(resolveSurfaceKind('legacy.doc')).toBe('page')
    expect(resolveSurfaceKind('deck.pptx')).toBe('slide')
    expect(resolveSurfaceKind('legacy.ppt')).toBe('slide')
    expect(resolveSurfaceKind('manual.pdf')).toBe('pdf')
    expect(resolveSurfaceKind('src/main.rs')).toBe('code')
    expect(resolveSurfaceKind('config.toml')).toBe('code')
    expect(resolveSurfaceKind('archive.zip')).toBeNull()
    expect(resolveSurfaceKind('')).toBeNull()
  })

  it('8. isLegacyOfficeFormat 准确区分需 LibreOffice /converted 转换的旧格式与原生 OOXML', () => {
    for (const ext of ['doc', 'xls', 'ppt', 'odt', 'ods', 'odp', 'rtf', 'wps', 'et', 'dps']) {
      expect(isLegacyOfficeFormat(`sample.${ext}`), `${ext} 应识别为旧格式`).toBe(true)
    }
    for (const ext of ['docx', 'xlsx', 'pptx', 'md', 'csv', 'pdf', 'rs']) {
      expect(isLegacyOfficeFormat(`sample.${ext}`), `${ext} 不应识别为旧格式`).toBe(false)
    }
  })

  it('9. canExecuteCommand 严格拦截无读权限、只读态写命令、无写权限与无 AI 权限命令', () => {
    // 无读权限：连只读命令也拒绝
    expect(
      canExecuteCommand(
        { id: '1', type: 'view.zoom', source: 'user' },
        true,
        { ...FULL_PERMISSIONS, read: false },
      ).ok,
    ).toBe(false)

    // 只读态：放行 view./nav./search. 与 readonlySafe 命令，拒绝写命令
    expect(
      canExecuteCommand({ id: '2', type: 'search.next', source: 'user' }, true, FULL_PERMISSIONS).ok,
    ).toBe(true)
    expect(
      canExecuteCommand(
        { id: '3', type: 'custom.inspect', source: 'user', readonlySafe: true },
        true,
        FULL_PERMISSIONS,
      ).ok,
    ).toBe(true)
    const readonlyReject = canExecuteCommand(
      { id: '4', type: 'text.insert', source: 'user' },
      true,
      FULL_PERMISSIONS,
    )
    expect(readonlyReject.ok).toBe(false)
    expect(readonlyReject.reason).toContain('只读')

    // 非只读但账号无 write 权限：拒绝写命令
    expect(
      canExecuteCommand(
        { id: '5', type: 'grid.setCell', source: 'user' },
        false,
        { ...FULL_PERMISSIONS, write: false },
      ).ok,
    ).toBe(false)

    // AI 来源命令但无 ai 权限：拒绝
    expect(
      canExecuteCommand(
        { id: '6', type: 'docx.proposeChanges', source: 'ai' },
        false,
        { ...FULL_PERMISSIONS, ai: false },
      ).ok,
    ).toBe(false)

    // 权限齐全且非只读：放行
    expect(
      canExecuteCommand(
        { id: '7', type: 'docx.proposeChanges', source: 'ai' },
        false,
        FULL_PERMISSIONS,
      ).ok,
    ).toBe(true)
  })

  it('10. formatAnchorKey 为全部 6 类 Anchor 生成唯一且稳定的定位键', () => {
    const anchors: Anchor[] = [
      { kind: 'text', block: 'b1', offset: 12, length: 4 },
      { kind: 'cell', sheet: 'Sheet1', cell: 'B2', endCell: 'D5' },
      { kind: 'page', page: 3, text: '合同标的' },
      { kind: 'slide', slide: 2, shape: 'sp_4', offset: 8 },
      { kind: 'code', line: 42, column: 4, length: 10 },
      { kind: 'pdf', page: 5, rect: { x: 10, y: 20, width: 100, height: 18 } },
    ]
    const keys = anchors.map((a) => formatAnchorKey(a))
    expect(keys).toEqual([
      'text:b1:12:4',
      'cell:Sheet1:B2:D5',
      'page:3:合同标的',
      'slide:2:sp_4:8',
      'code:42:4:10',
      'pdf:5:10,20,100,18',
    ])
    expect(new Set(keys).size).toBe(6)
  })

  it('11. EditorHost 与 EditorChrome 在支持格式下正常挂载并遵守只读按钮守卫', async () => {
    const request: EditorOpenRequest = {
      fileId: 'file_1',
      format: 'docx',
      source: { kind: 'bytes', bytes: new Uint8Array([0x50, 0x4b]), name: '架构规范.docx' },
      readonly: true,
      revision: 3,
      permissions: FULL_PERMISSIONS,
    }
    const wrapper = mount(EditorHost, { props: { request } })
    expect(wrapper.attributes('data-surface-kind')).toBe('page')
    expect(wrapper.find('[data-testid="editor-chrome"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="editor-surface-kind"]').text()).toBe('Word')
    expect(wrapper.find('[data-testid="editor-revision"]').text()).toBe('v3')
    // 只读态下不显示撤销/重做/保存按钮
    expect(wrapper.find('[data-testid="editor-save"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="editor-undo"]').exists()).toBe(false)

    // 通过暴露的 executeCommand 执行写命令应被拦截
    const vm = wrapper.vm as unknown as {
      executeCommand: (cmd: { id: string; type: string; source: 'user' }) => Promise<{ ok: boolean }>
    }
    const res = await vm.executeCommand({ id: 'c1', type: 'page.insertText', source: 'user' })
    expect(res.ok).toBe(false)
  })

  it('12. EditorHost 在不支持的格式下渲染错误边界并触发 fallback 事件，绝不白屏', async () => {
    const request: EditorOpenRequest = {
      fileId: 'file_2',
      format: 'bin',
      source: { kind: 'bytes', bytes: new Uint8Array([0x00]), name: 'unknown.bin' },
      readonly: true,
      revision: 1,
      permissions: FULL_PERMISSIONS,
    }
    const wrapper = mount(EditorHost, { props: { request } })
    expect(wrapper.attributes('data-surface-kind')).toBe('unsupported')
    const fallback = wrapper.find('[data-testid="editor-fallback"]')
    expect(fallback.exists()).toBe(true)
    expect(fallback.text()).toContain('.bin')

    await wrapper.find('[data-testid="editor-fallback-btn"]').trigger('click')
    expect(wrapper.emitted('fallback')?.[0]).toEqual(['unsupported_format'])
  })

  it('13. EditorChrome 在可编辑状态下渲染撤销/重做/保存并正确转发事件', async () => {
    const wrapper = mount(EditorChrome, {
      props: {
        title: '周报.md',
        kind: 'text',
        format: 'md',
        readonly: false,
        dirty: true,
        phase: 'ready',
        revision: 2,
        permissions: FULL_PERMISSIONS,
      },
    })
    expect(wrapper.find('[data-testid="editor-status"]').text()).toBe('有未保存的改动')
    const saveBtn = wrapper.find('[data-testid="editor-save"]')
    expect(saveBtn.exists()).toBe(true)
    expect((saveBtn.element as HTMLButtonElement).disabled).toBe(false)

    await saveBtn.trigger('click')
    expect(wrapper.emitted('save')).toHaveLength(1)

    await wrapper.find('[data-testid="editor-undo"]').trigger('click')
    expect(wrapper.emitted('undo')).toHaveLength(1)

    await wrapper.find('[data-testid="editor-redo"]').trigger('click')
    expect(wrapper.emitted('redo')).toHaveLength(1)
  })

  it('14. docx Worker 入口不在 exports map 内，因此 vite 必须提供显式 alias 且 worker 格式为 ESM', () => {
    const docxPkg = JSON.parse(Object.values(DOCX_PACKAGE_JSON_RAW)[0]) as {
      exports: Record<string, unknown>
    }
    // 上游将来若真导出了 Worker 子路径，这条断言先红，再决定是否删掉 alias；不允许默默漂移。
    expect(Object.keys(docxPkg.exports)).not.toContain('./docxWorker')
    expect(Object.keys(docxPkg.exports)).not.toContain('./worker-client')

    const viteConfig = Object.values(VITE_CONFIG_RAW)[0]
    expect(viteConfig).toMatch(/worker:\s*\{\s*format:\s*'es'\s*\}/)
    expect(viteConfig).toContain('@betteroffice/docx/worker-entry')
    expect(viteConfig).toContain('node_modules/@betteroffice/docx/dist/docxWorker.mjs')
  })
})
