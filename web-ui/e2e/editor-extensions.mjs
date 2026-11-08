#!/usr/bin/env node
// 编辑器扩展门禁：在真实构建产物上装入扩展，验证它在编辑器里出现、能用、能被撤掉，
// 并且页面在站点真实 CSP 下（serve.mjs 与守护进程同一份策略）能同源 import 扩展脚本。
//
// 用法：
//   cd web-ui && KB_PRECOMPRESS=0 npx vite build --logLevel error && node e2e/editor-extensions.mjs
//   KB_ENGINE=webkit node e2e/editor-extensions.mjs
//
// 夹具来自 e2e/fixture.mjs 的 `__editorExt`（按后端真实响应形状应答 /api/v1/editor/extensions*），
// 示例扩展用仓库里真实的 examples/editor-word-count/index.js，不需要守护进程。
import { contextOptions, launch, pickEngines } from './devices.mjs'
import { ALL_FEATURES, FILES, adminMe, installFixture, pushLive } from './fixture.mjs'
import { SOLO_EDIT_FIXTURE } from './editor-helpers.mjs'
import { TODO_FILE, TODO_PATH, listed, manifestJson, registerTodoFile, todoFormatExample, wordCountExample } from './editor-ext-helpers.mjs'
import { startStaticServer } from './serve.mjs'
import { axeIssues } from './axe-helpers.mjs'

const COLLECTION = 'knowledgeBase%2Finsights'
const ITEM = 'ins_8f21'
const TOGGLE = '[data-ext-panel-toggle="kb.word-count:kb.word-count.panel"]'
const WC_BUTTON = '[data-action="kb.word-count.button"]'

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/** 打开一篇经验笔记并进入编辑态（统一外壳） */
async function openEditable(tab, base) {
  await tab.goto(`${base}/kb?collection=${COLLECTION}&item=${ITEM}`, { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector('.kb-dp', { timeout: 20_000 })
  const edit = tab.getByRole('button', { name: /^编辑$/ }).first()
  await edit.waitFor({ state: 'visible', timeout: 20_000 })
  await edit.click()
  await tab.waitForSelector('[data-testid="editor-host"] .kb-text-prose', { timeout: 20_000 })
}

const MORE = '[data-testid="editor-toolbar-more"]'
const MORE_MENU = '[data-testid="editor-toolbar-more-menu"]'

/** 点工具栏上的动作；放不下的按钮在「更多」里，先把它打开 */
async function clickToolbarAction(tab, selector) {
  const direct = tab.locator(`[data-testid="editor-toolbar-slot"] ${selector}`)
  if (await direct.count()) {
    await direct.first().click()
    return
  }
  if (!(await tab.locator(MORE_MENU).count())) await tab.click(MORE)
  await tab.click(`${MORE_MENU} ${selector}`)
}

/** 工具栏（含「更多」里）有没有这个动作；查完把「更多」收回去 */
async function hasToolbarAction(tab, selector) {
  // 工具栏随按钮增减重新测量：撤掉扩展按钮后其余按钮放得下，「更多」会在 count 与 click 之间消失。
  // 所以点「更多」用短超时，点不到就从头再判断一次（按钮可能已经回到工具栏上），而不是对着消失的元素等 30 秒。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await tab.locator(`[data-testid="editor-toolbar-slot"] ${selector}`).count()) return true
    const more = tab.locator(MORE)
    if (!(await more.count())) return false
    const wasOpen = (await tab.locator(MORE_MENU).count()) > 0
    if (!wasOpen) {
      const opened = await more.click({ timeout: 2000 }).then(() => true, () => false)
      if (!opened) continue
    }
    const found = (await tab.locator(`${MORE_MENU} ${selector}`).count()) > 0
    // 关菜单时「更多」也可能已经消失（菜单随之卸载），关不上不算错
    if (!wasOpen) await more.click({ timeout: 2000 }).catch(() => {})
    return found
  }
  throw new Error(`工具栏一直在重排，5 次都没能判断 ${selector} 在不在`)
}

/** 一个工具栏动作的可访问名称：在工具栏上是 aria-label，收进「更多」菜单后是菜单项的文字 */
async function toolbarActionLabel(tab, selector) {
  const inSlot = tab.locator(`[data-testid="editor-toolbar-slot"] ${selector}`)
  if (await inSlot.count()) return inSlot.first().getAttribute('aria-label')
  await tab.click(MORE)
  const item = tab.locator(`${MORE_MENU} ${selector}`).first()
  const label = (await item.getAttribute('aria-label')) ?? (await item.innerText()).replace(/\s+/g, ' ').trim()
  await tab.click(MORE)
  return label
}

const cjkCount = (tab) => tab.evaluate(() => document.querySelector('[data-testid="wc-cjk"]')?.textContent ?? '')

/** 页面级的坏信号：CSP 拦截、未捕获异常 */
function watchProblems(tab) {
  const problems = []
  tab.on('pageerror', (error) => problems.push(`页面异常：${error.message}`))
  tab.on('console', (message) => {
    if (message.type() === 'error' && /content security policy|refused to (load|execute)/i.test(message.text())) problems.push(`CSP 拦截：${message.text()}`)
  })
  return problems
}

function extensionRequests(tab) {
  const urls = []
  tab.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/v1/editor/extensions')) urls.push(url.pathname)
  })
  return urls
}

// ---------------------------------------------------------------- 扩展注册的新格式：文件浏览页入口

const TODO_URL = (base) => `${base}/kb?collection=${COLLECTION}&item=file_todo`
const TODO_SURFACE = '[data-testid="todo-surface"]'
const CODE_VIEW = '.kb-ce .cm-content'

/** 待办清单示例 + 登记 .kbtodo 文件 + 记录保存请求的假后端参数（save_file 会把正文写回文件表，模拟「保存后重新打开」） */
function todoOverrides({ enabled = true, forbidden = false, live = false, collab = false } = {}) {
  const example = todoFormatExample()
  registerTodoFile()
  const saves = []
  return {
    ...(live ? { __live: true } : {}),
    // 默认单人编辑夹具（没有多人编辑功能点）；collab=true 时换成拥有全部功能的管理员，用来证明扩展格式不连房间
    ...(collab ? { __me: { local: false, user: adminMe(ALL_FEATURES, true) } } : {}),
    __editorExt: { enabled, forbidden, extensions: [example.listed], files: example.files },
    __todoSaves: saves,
    save_file: (args) => {
      saves.push(args)
      FILES.file_todo.preview.content = args.content
      return { version: 8, embedded: 1, chunks: 1 }
    },
  }
}

/** 打开 .kbtodo 文件页，等到文件内容出来（扩展内容面或回退的代码视图） */
async function openTodo(tab, base, ready) {
  await tab.goto(TODO_URL(base), { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector(ready, { timeout: 20_000 })
}

const todoTexts = (tab) => tab.$$eval('[data-testid="todo-text"]', (inputs) => inputs.map((input) => input.value))

/** 每个场景：overrides 是夹具参数，assert 返回问题列表 */
const SCENARIOS = {
  'appears-and-works': {
    title: '示例扩展出现在编辑器里：工具栏按钮、命令提示、面板，字数随输入变化，无障碍无严重问题',
    overrides() {
      const example = wordCountExample()
      return { __editorExt: { enabled: true, extensions: [example.listed], files: example.files } }
    },
    async assert(tab, base) {
      const problems = watchProblems(tab)
      await openEditable(tab, base)
      const issues = []
      if (!(await waitFor(() => hasToolbarAction(tab, WC_BUTTON)))) return ['工具栏上没有出现「字数统计」按钮']
      const label = await toolbarActionLabel(tab, WC_BUTTON)
      if (label !== 'Σ 字数统计' && label !== '字数统计') issues.push(`按钮的可访问名称不对：${label}`)

      // 点按钮 → 命令运行 → 页面右下提示出一条统计
      await clickToolbarAction(tab, WC_BUTTON)
      if (!(await waitFor(() => tab.evaluate(() => document.body.innerText.includes('全文:汉字'))))) issues.push('点按钮后没有看到统计提示')

      // 面板：操作区有开关，打开后显示实时数字
      if (!(await tab.locator(TOGGLE).count())) return [...issues, '操作区没有面板开关']
      await tab.click(TOGGLE)
      if (!(await waitFor(async () => /^\d+$/.test(await cjkCount(tab))))) return [...issues, '面板没有画出汉字数']
      const before = Number(await cjkCount(tab))
      // 往正文末尾输入 6 个汉字：防抖后面板更新
      await tab.click('[data-testid="editor-host"] .kb-text-prose')
      await tab.keyboard.press('Control+End')
      await tab.keyboard.insertText('字数变化测试')
      if (!(await waitFor(async () => Number(await cjkCount(tab)) === before + 6))) issues.push(`输入 6 个汉字后面板没有从 ${before} 更新到 ${before + 6}，现在是 ${await cjkCount(tab)}`)

      // 无障碍：扩展按钮、面板开关、面板自身。放在打开大纲之前——大纲面板自带的「收起」按钮
      // （既有标记，这张卡没改）单独打开时就有一条 color-contrast，与扩展无关
      issues.push(...(await axeIssues(tab, { scope: '[data-testid="editor-host"]' })).map((item) => `axe ${item}`))

      // 面板和大纲同时打开，互不影响
      await clickToolbarAction(tab, '[data-action="outline"]')
      if (!(await waitFor(() => tab.locator('[data-testid="editor-outline"]').count()))) issues.push('面板打开时大纲打不开')
      if (!(await tab.locator('[data-testid="editor-ext-panel"]').count())) issues.push('打开大纲后面板消失了')
      return issues.concat(problems)
    },
  },

  'removed-live': {
    title: '后端关掉开关并推送 config.changed：按钮、面板开关、已打开的面板立刻消失，编辑器照常可用',
    overrides() {
      const example = wordCountExample()
      return { __live: true, __editorExt: { enabled: true, extensions: [example.listed], files: example.files } }
    },
    async assert(tab, base, { fixtureState }) {
      const problems = watchProblems(tab)
      await openEditable(tab, base)
      if (!(await waitFor(() => hasToolbarAction(tab, WC_BUTTON)))) return ['扩展没有出现']
      await tab.click(TOGGLE)
      if (!(await waitFor(() => tab.locator('[data-testid="editor-ext-panel"]').count()))) return ['面板没有打开']

      // 管理员在 config.toml 里关掉 [editor] extensions；守护进程热重载后推 config.changed
      fixtureState.enabled = false
      pushLive(tab.context(), { type: 'config.changed', data: { generation: 2, hot: ['editor.extensions'], restart_required: [], notes: [] } })
      const issues = []
      if (!(await waitFor(async () => !(await hasToolbarAction(tab, WC_BUTTON))))) issues.push('开关关掉后工具栏按钮还在')
      if (!(await waitFor(async () => (await tab.locator(TOGGLE).count()) === 0))) issues.push('开关关掉后面板开关还在')
      if (await tab.locator('[data-testid="editor-ext-panel"]').count()) issues.push('开关关掉后已打开的面板还在')
      // 内置的查找 / 大纲（同样经注册表注册）不受影响；编辑器照常输入
      if (!(await hasToolbarAction(tab, '[data-action="find"]'))) issues.push('内置的查找按钮被误撤了')
      await tab.click('[data-testid="editor-host"] .kb-text-prose')
      await tab.keyboard.insertText('卸载之后照常输入')
      if (!(await waitFor(() => tab.evaluate(() => document.querySelector('.kb-text-prose')?.textContent?.includes('卸载之后照常输入'))))) issues.push('扩展撤掉后编辑器不能输入了')

      // 再打开：扩展回来（同一个页面里重新装上）
      fixtureState.enabled = true
      pushLive(tab.context(), { type: 'config.changed', data: { generation: 3, hot: ['editor.extensions'], restart_required: [], notes: [] } })
      if (!(await waitFor(() => hasToolbarAction(tab, WC_BUTTON)))) issues.push('重新打开开关后扩展没有回来')
      return issues.concat(problems)
    },
  },

  'off-by-default': {
    title: '开关默认关：没有任何扩展按钮，清单只请求一次，编辑器正常',
    overrides: () => ({ __editorExt: { enabled: false, extensions: [] } }),
    async assert(tab, base) {
      const problems = watchProblems(tab)
      const requests = extensionRequests(tab)
      await openEditable(tab, base)
      await new Promise((resolve) => setTimeout(resolve, 600))
      const issues = []
      const extras = await tab.evaluate(() => [...document.querySelectorAll('[data-action^="kb."], [data-ext-panel-toggle]')].length)
      if (extras) issues.push(`开关关着却出现了 ${extras} 个扩展入口`)
      if (!(await hasToolbarAction(tab, '[data-action="find"]'))) issues.push('内置查找按钮缺失')
      const listCalls = requests.filter((path) => path === '/api/v1/editor/extensions').length
      if (listCalls !== 1) issues.push(`清单应只请求一次，实际 ${listCalls} 次`)
      return issues.concat(problems)
    },
  },

  'non-admin': {
    title: '非管理员（后端 403）：静默无扩展，不报错，编辑器正常',
    overrides: () => ({ __editorExt: { enabled: true, forbidden: true, extensions: [] } }),
    async assert(tab, base) {
      const problems = watchProblems(tab)
      await openEditable(tab, base)
      await new Promise((resolve) => setTimeout(resolve, 600))
      const issues = []
      if (await tab.locator('[data-action^="kb."]').count()) issues.push('403 之后仍出现了扩展按钮')
      if (!(await hasToolbarAction(tab, '[data-action="find"]'))) issues.push('内置查找按钮缺失')
      return issues.concat(problems)
    },
  },

  'failure-isolation': {
    title: '坏扩展不拖累别的：清单有错、脚本语法错误的扩展被跳过，好扩展照常出现',
    overrides() {
      const example = wordCountExample()
      const broken = manifestJson('kb.syntax', { permissions: ['ui'] })
      return {
        __editorExt: {
          enabled: true,
          extensions: [
            { id: 'kb.badmanifest', dir: 'kb.badmanifest', manifest: null, error: 'api_version = 2 需要更新版本的编辑器扩展 API' },
            listed(broken),
            example.listed,
          ],
          files: { ...example.files, 'kb.syntax/index.js': 'export default { activate( {' },
        },
      }
    },
    async assert(tab, base) {
      const problems = watchProblems(tab)
      await openEditable(tab, base)
      const issues = []
      if (!(await waitFor(() => hasToolbarAction(tab, WC_BUTTON)))) issues.push('好扩展没有出现')
      if (!(await hasToolbarAction(tab, '[data-action="find"]'))) issues.push('内置查找按钮缺失')
      return issues.concat(problems)
    },
  },

  'write-confirm-allow': {
    title: 'document.write：第一次写文档弹确认，允许后写入；第二次不再问',
    overrides: () => ({ __editorExt: writerExtension() }),
    async assert(tab, base) {
      const problems = watchProblems(tab)
      await openEditable(tab, base)
      if (!(await waitFor(() => hasToolbarAction(tab, '[data-action="kb.sign.button"]')))) return ['签名按钮没有出现']
      const issues = []
      await clickToolbarAction(tab, '[data-action="kb.sign.button"]')
      const dialog = tab.getByRole('alertdialog')
      if (!(await waitFor(() => dialog.count()))) return ['第一次写文档没有弹出确认框']
      const text = await dialog.innerText()
      if (!text.includes('签名助手') || !text.includes('修改')) issues.push(`确认框没有说明是谁要改什么：${text}`)
      const insertedBefore = await tab.evaluate(() => document.querySelector('.kb-text-prose')?.textContent?.includes('【扩展签名】'))
      if (insertedBefore) issues.push('确认之前文档已经被改了')
      await tab.getByRole('button', { name: '允许修改' }).click()
      if (!(await waitFor(() => tab.evaluate(() => document.querySelector('.kb-text-prose')?.textContent?.includes('【扩展签名】'))))) issues.push('允许之后签名没有写进文档')
      await clickToolbarAction(tab, '[data-action="kb.sign.button"]')
      await new Promise((resolve) => setTimeout(resolve, 400))
      if (await tab.getByRole('alertdialog').count()) issues.push('同一页面会话里第二次写入又弹了确认框')
      const occurrences = await tab.evaluate(() => (document.querySelector('.kb-text-prose')?.textContent?.match(/【扩展签名】/g) ?? []).length)
      if (occurrences !== 2) issues.push(`两次写入后应出现 2 处签名，实际 ${occurrences}`)
      return issues.concat(problems)
    },
  },

  'write-confirm-deny': {
    title: 'document.write：用户不允许 → 文档不动，提示原因',
    overrides: () => ({ __editorExt: writerExtension() }),
    async assert(tab, base) {
      const problems = watchProblems(tab)
      await openEditable(tab, base)
      if (!(await waitFor(() => hasToolbarAction(tab, '[data-action="kb.sign.button"]')))) return ['签名按钮没有出现']
      const issues = []
      await clickToolbarAction(tab, '[data-action="kb.sign.button"]')
      if (!(await waitFor(() => tab.getByRole('alertdialog').count()))) return ['没有弹出确认框']
      await tab.getByRole('button', { name: '不允许' }).click()
      if (!(await waitFor(() => tab.evaluate(() => document.body.innerText.includes('不能修改文档'))))) issues.push('拒绝后没有提示原因')
      if (await tab.evaluate(() => document.querySelector('.kb-text-prose')?.textContent?.includes('【扩展签名】'))) issues.push('用户拒绝了，文档还是被改了')
      return issues.concat(problems)
    },
  },

  'todo-format-open-edit-save': {
    title: '扩展注册的新格式（.kbtodo）：文件页用扩展内容面只读打开 → 编辑改一处 → 保存（写权限确认）→ 回到阅读、重新打开内容正确',
    overrides: () => todoOverrides({ live: false }),
    async assert(tab, base, { given }) {
      const problems = watchProblems(tab)
      const saves = given.__todoSaves
      await openTodo(tab, base, TODO_SURFACE)
      const issues = []
      // 阅读：扩展内容面画出清单，只读（输入框全部禁用），不是代码视图
      if (JSON.stringify(await todoTexts(tab)) !== JSON.stringify(['冻结版本', '写发布说明'])) issues.push(`阅读态清单内容不对：${await todoTexts(tab)}`)
      if (await tab.locator(`${TODO_SURFACE} input:not([disabled])`).count()) issues.push('阅读态的清单不该能改')
      if (await tab.locator(CODE_VIEW).count()) issues.push('扩展认领的格式不该出现代码视图')

      // 编辑：改第二项的文字并勾上
      await tab.getByRole('button', { name: /^编辑$/ }).first().click()
      await tab.waitForSelector(`[data-testid="file-native-editor"] ${TODO_SURFACE} input:not([disabled])`, { timeout: 20_000 })
      await tab.locator('[data-testid="todo-text"]').nth(1).fill('写发布说明和回滚预案')
      await tab.locator('[data-testid="todo-done"]').nth(1).check()
      // 保存：Codec 写回要用户确认（document.write）
      await tab.getByRole('button', { name: '保存', exact: true }).click()
      const dialog = tab.getByRole('alertdialog')
      if (!(await waitFor(() => dialog.count()))) return [...issues, '第一次保存没有弹出写权限确认', ...problems]
      const confirmText = await dialog.innerText()
      if (!confirmText.includes('待办清单格式')) issues.push(`确认框没有说明是哪个扩展：${confirmText}`)
      if (saves.length) issues.push('确认之前就已经保存了')
      await tab.getByRole('button', { name: '允许修改' }).click()
      if (!(await waitFor(() => saves.length === 1))) return [...issues, '允许之后没有调用保存通道', ...problems]
      const saved = saves[0]
      const expected = TODO_FILE.replace('"写发布说明"', '"写发布说明和回滚预案"').replace('"done": false', '"done": true')
      if (saved.content !== expected) issues.push(`保存的正文不对：${JSON.stringify(saved.content)}`)
      if (saved.path !== TODO_PATH) issues.push(`保存的路径不对：${saved.path}`)
      if (saved.expected_version !== 7) issues.push(`保存没有带页面的版本号做冲突检查：${saved.expected_version}`)

      // 保存后回到阅读，内容是新的；重新打开页面内容仍然正确（假后端把保存的正文写回了文件表）
      if (!(await waitFor(async () => (await tab.locator('[data-testid="file-native-editor"]').count()) === 0))) issues.push('保存后没有回到阅读')
      const afterSave = JSON.stringify(await todoTexts(tab))
      if (afterSave !== JSON.stringify(['冻结版本', '写发布说明和回滚预案'])) issues.push(`保存后阅读态内容不对：${afterSave}`)
      await openTodo(tab, base, TODO_SURFACE)
      const reopened = await tab.$$eval('[data-testid="todo-done"]', (boxes) => boxes.map((box) => box.checked))
      if (JSON.stringify(await todoTexts(tab)) !== JSON.stringify(['冻结版本', '写发布说明和回滚预案']) || JSON.stringify(reopened) !== '[true,true]') issues.push(`重新打开后内容不对：${await todoTexts(tab)} ${reopened}`)
      // 阅读态没有任何保存请求以外的写入
      if (saves.length !== 1) issues.push(`保存请求应只有 1 次，实际 ${saves.length}`)
      issues.push(...(await axeIssues(tab, { scope: TODO_SURFACE })).map((item) => `axe ${item}`))
      return issues.concat(problems)
    },
  },

  'todo-format-save-denied': {
    title: '扩展格式：用户不允许扩展写文档 → 保存失败并说明，页面的保存通道一次都不调用，改动留在编辑器里',
    overrides: () => todoOverrides(),
    async assert(tab, base, { given }) {
      const problems = watchProblems(tab)
      await openTodo(tab, base, TODO_SURFACE)
      await tab.getByRole('button', { name: /^编辑$/ }).first().click()
      await tab.waitForSelector(`[data-testid="file-native-editor"] ${TODO_SURFACE} input:not([disabled])`, { timeout: 20_000 })
      await tab.locator('[data-testid="todo-text"]').first().fill('冻结版本 v2')
      await tab.getByRole('button', { name: '保存', exact: true }).click()
      if (!(await waitFor(() => tab.getByRole('alertdialog').count()))) return ['没有弹出写权限确认', ...problems]
      await tab.getByRole('button', { name: '不允许' }).click()
      const issues = []
      if (!(await waitFor(() => tab.evaluate(() => document.body.innerText.includes('不能修改文档'))))) issues.push('拒绝后没有提示原因')
      await new Promise((resolve) => setTimeout(resolve, 300))
      if (given.__todoSaves.length) issues.push(`用户拒绝了，保存通道仍被调用 ${given.__todoSaves.length} 次`)
      if ((await tab.locator('[data-testid="todo-text"]').first().inputValue()) !== '冻结版本 v2') issues.push('拒绝保存后改动不该丢')
      if (FILES.file_todo.preview.content !== TODO_FILE) issues.push('文件内容被改了')
      return issues.concat(problems)
    },
  },

  'todo-format-no-room': {
    title: '扩展格式：账号有多人编辑功能点时也不连协同房间（房间里是原文，扩展内容面编辑的是解码后的清单），编辑器照常可用',
    overrides: () => todoOverrides({ collab: true }),
    async assert(tab, base) {
      const problems = watchProblems(tab)
      // 协同房间走 WebSocket：扩展格式一条都不该开（普通文本文件进编辑会去连）
      const sockets = []
      tab.on('websocket', (socket) => /\/api\/v1\/collab\//.test(socket.url()) && sockets.push(socket.url()))
      await openTodo(tab, base, TODO_SURFACE)
      await tab.getByRole('button', { name: /^编辑$/ }).first().click()
      const issues = []
      // 假后端没有房间：普通文本文件在这里会停在「正在连接」；扩展格式不连房间，应当直接可编辑
      const ready = await tab.waitForSelector(`[data-testid="file-native-editor"] ${TODO_SURFACE} input:not([disabled])`, { timeout: 15_000 }).then(() => true, () => false)
      if (!ready) issues.push('扩展格式在有多人编辑功能点的账号下打不开编辑（疑似在等协同房间）')
      await new Promise((resolve) => setTimeout(resolve, 800))
      if (sockets.length) issues.push(`扩展格式不该连协同房间，却打开了协同房间的 WebSocket：${sockets.join(', ')}`)
      return issues.concat(problems)
    },
  },

  'todo-format-disabled': {
    title: '扩展开关关着：同一个 .kbtodo 文件回到原来的回退（只读代码视图，点编辑进纯文本编辑），不出现扩展内容面',
    overrides: () => todoOverrides({ enabled: false }),
    async assert(tab, base) {
      const problems = watchProblems(tab)
      await openTodo(tab, base, CODE_VIEW)
      const issues = []
      const shown = await tab.locator(CODE_VIEW).first().textContent()
      if (!shown?.includes('冻结版本')) issues.push(`回退的代码视图里没有文件内容：${shown}`)
      if (await tab.locator(TODO_SURFACE).count()) issues.push('开关关着却出现了扩展内容面')
      await tab.getByRole('button', { name: /^编辑$/ }).first().click()
      const plain = await tab.waitForSelector('[data-testid="file-native-editor"] .cm-content', { timeout: 20_000 }).then(() => true, () => false)
      if (!plain) issues.push('开关关着时点编辑应进原来的纯文本编辑')
      if (await tab.locator(TODO_SURFACE).count()) issues.push('开关关着，编辑态却出现了扩展内容面')
      return issues.concat(problems)
    },
  },

  'todo-format-live-toggle': {
    title: '页面打开期间管理员改开关（config.changed）：关掉后同一文件立刻回到回退，再打开又用扩展内容面',
    overrides: () => todoOverrides({ live: true }),
    async assert(tab, base, { fixtureState }) {
      const problems = watchProblems(tab)
      await openTodo(tab, base, TODO_SURFACE)
      const issues = []
      fixtureState.enabled = false
      pushLive(tab.context(), { type: 'config.changed', data: { generation: 2, hot: ['editor.extensions'], restart_required: [], notes: [] } })
      if (!(await waitFor(() => tab.locator(CODE_VIEW).count()))) issues.push('关掉开关后文件没有回到代码视图')
      if (await tab.locator(TODO_SURFACE).count()) issues.push('关掉开关后扩展内容面还在')
      fixtureState.enabled = true
      pushLive(tab.context(), { type: 'config.changed', data: { generation: 3, hot: ['editor.extensions'], restart_required: [], notes: [] } })
      if (!(await waitFor(() => tab.locator(TODO_SURFACE).count()))) issues.push('重新打开开关后扩展内容面没有回来')
      return issues.concat(problems)
    },
  },

  'todo-format-non-admin': {
    title: '非管理员（后端 403）：扩展格式回到回退且不报错；已知没有系统功能点的账号连清单都不请求',
    overrides: () => todoOverrides({ forbidden: true }),
    async assert(tab, base, { browser, engine }) {
      const problems = watchProblems(tab)
      const requests = extensionRequests(tab)
      await openTodo(tab, base, CODE_VIEW)
      const issues = []
      if (await tab.locator(TODO_SURFACE).count()) issues.push('403 之后仍出现了扩展内容面')
      if (!requests.includes('/api/v1/editor/extensions')) issues.push('管理员身份未知 / 是管理员时应去问一次清单（后端用 403 把关）')
      // 第二个账号：功能点里根本没有 sys.settings → 前端不用问
      const context = await browser.newContext(contextOptions({ width: 1440, height: 900, dpr: 1, touch: false, mobile: false }, engine, { locale: 'zh-CN' }))
      const given = todoOverrides()
      await installFixture(context, { ...SOLO_EDIT_FIXTURE, ...given, __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => id !== 'collab.edit' && id !== 'sys.settings'), true) } })
      const plain = await context.newPage()
      const plainProblems = watchProblems(plain)
      const plainRequests = extensionRequests(plain)
      await openTodo(plain, base, CODE_VIEW)
      await new Promise((resolve) => setTimeout(resolve, 500))
      if (plainRequests.length) issues.push(`没有系统功能点的账号不该请求扩展清单：${plainRequests.join(', ')}`)
      if (await plain.locator(TODO_SURFACE).count()) issues.push('普通账号出现了扩展内容面')
      await context.close()
      return issues.concat(problems, plainProblems)
    },
  },
}

/** 一个会改文档的扩展：工具栏「签名」按钮在光标处插入一段文字。 */
function writerExtension() {
  const manifest = manifestJson('kb.sign', {
    name: '签名助手',
    permissions: ['document.write', 'ui'],
    contributes: { commands: [{ id: 'kb.sign.insert', title: '插入签名' }], toolbar: [{ id: 'kb.sign.button' }] },
  })
  const script = `export default {
  activate(ctx) {
    ctx.registerCommand('kb.sign.insert', (_args, api) => api.document.insertText('【扩展签名】'))
    ctx.registerToolbarItem({ id: 'kb.sign.button', label: '签名', icon: '✍', command: 'kb.sign.insert', write: true })
  },
}
`
  return { enabled: true, extensions: [listed(manifest)], files: { 'kb.sign/index.js': script } }
}

async function main() {
  const { server, base } = await startStaticServer()
  const engines = pickEngines()
  let failed = 0
  try {
    for (const engine of engines) {
      const browser = await launch(engine)
      for (const [id, scenario] of Object.entries(SCENARIOS)) {
        const context = await browser.newContext(contextOptions({ width: 1440, height: 900, dpr: 1, touch: false, mobile: false }, engine, { locale: 'zh-CN' }))
        const given = scenario.overrides()
        // 场景拿同一个对象的引用，运行中改它 = 管理员改了 config.toml
        const fixtureState = given.__editorExt
        await installFixture(context, {
          ...SOLO_EDIT_FIXTURE,
          ...given,
          edit_item: (payload) => ({ id: payload?.id ?? ITEM, version: 5, collection: 'proj_knowledgebase', job_id: null }),
        })
        const tab = await context.newPage()
        const issues = await scenario.assert(tab, base, { fixtureState, given, browser, engine }).catch((error) => [error.message])
        if (issues.length) {
          failed += 1
          console.log(`✗ [${engine}] ${id} ${scenario.title}\n  ${issues.join('\n  ')}`)
        } else {
          console.log(`✓ [${engine}] ${id}`)
        }
        await context.close()
      }
      await browser.close()
    }
  } finally {
    server.close()
  }
  if (failed) {
    console.log(`\n${failed} 项未通过`)
    process.exit(1)
  }
  console.log('\n✓ 编辑器扩展门禁全部通过')
}

await main()
