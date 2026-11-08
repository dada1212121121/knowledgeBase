// 编辑器"上传图片"的来源面板(之三)的页面场景。由 viewer-shots.mjs 引入。
// 手机触屏(<600 + pointer: coarse):点工具栏"上传图片"先出底部面板 拍照 / 从相册选;"上传附件"不出面板;
// 触屏平板(820 宽)和电脑(1440 宽):保持直接选文件。选完走编辑器原来的上传 + 插入流程。
//
// Playwright 里没有真的相机和相册:用 `filechooser` 事件确认"点到了哪个 input"(这是浏览器真的要弹系统选择器的那一刻),
// 再用 chooser.setFiles 放文件进去,和真机"选完"触发的 change 是同一条路。
// 真机相机(capture 是否直接打开后置摄像头、iOS 是否把 capture 忽略成通用选择器)只能在 iPhone / 安卓手机上看。
import { dynamicResponses } from './fixture.mjs'
import { COLLECTION, FAKE_VISUAL_VIEWPORT, SOLO_EDIT_FIXTURE, keyboardHeight, rectOf, setKeyboard, settled, tapCenter } from './editor-helpers.mjs'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

/** 每个页面一份记录:系统选择器被唤起的次数、页面级 Esc 处理被触发的次数 */
const watched = new WeakMap()
const choosersOf = (tab) => watched.get(tab).choosers

/** 开始监听系统选择器(filechooser):每次浏览器要弹选择器就记一笔 */
function watchChoosers(tab) {
  const choosers = []
  tab.on('filechooser', (chooser) => choosers.push(chooser))
  watched.set(tab, { choosers })
}

/** 记下创建上传的请求体(笔记里的图片 / 附件走分片上传:POST /api/v1/uploads) */
function watchUploads(tab) {
  const created = []
  tab.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/uploads') created.push(request.postDataJSON() ?? {})
  })
  return created
}

/** 等系统选择器多出一个(点击之后浏览器才会弹),返回它对应的 input 的 data-testid;超时返回 null */
async function nextChooser(tab, before, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const all = choosersOf(tab)
    if (all.length > before) return { chooser: all[before], id: await all[before].element().evaluate((el) => el.dataset.testid) }
    await tab.waitForTimeout(50)
  }
  return null
}

/** 进入已有笔记的编辑态(上传按钮要有目标集合),并开始记录系统选择器 */
async function openEditor(tab) {
  await tab.getByRole('button', { name: '编辑', exact: true }).first().click()
  await tab.waitForSelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)[contenteditable="true"]', { timeout: 15_000 })
  watchChoosers(tab)
}


// 工具栏上的“上传图片 / 上传附件”：旧编辑器按钮的 aria-label 就是这两个词；
// 新文本面是 “🖼 图片”（工具栏上，放不下进“更多”）和 “📎 附件”（在“插入”下拉里，窄屏整个收进“更多”）
const NATIVE_TOOL = { 上传图片: 'image', 上传附件: 'attachment' }
async function nativeTool(tab, action) {
  const direct = tab.locator(`[data-testid="editor-toolbar-slot"] button[data-action="${action}"]`)
  if (await direct.count()) return direct.first()
  const dropdown = tab.locator('[data-testid="editor-toolbar-slot"] button[data-action="insertMore"]')
  if (await dropdown.count()) {
    await dropdown.click()
    return tab.locator(`[data-testid="editor-dropdown-insertMore"] [data-action="${action}"]`)
  }
  await tab.click('[data-testid="editor-toolbar-more"]')
  return tab.locator(`[data-testid="editor-toolbar-more-menu"] [data-action="${action}"]`)
}
const sheetOf = (tab) => tab.locator('[data-testid=sheet]')
const rowTexts = (tab) => tab.locator('[data-testid=drop-sheet] .kb-drop-opt b').allInnerTexts()
/** 不该出面板的地方:出了就记一笔,并用 Esc 收掉(留着的话遮罩会盖住后面要点的按钮,后面的断言全成了"被盖住"的异常) */
async function expectNoSheet(tab, issues, message) {
  if (!(await sheetOf(tab).count())) return
  issues.push(message)
  await tab.keyboard.press('Escape')
  await tab.waitForSelector('[data-testid=sheet]', { state: 'detached', timeout: 3000 }).catch(() => undefined)
}

/** 正文里插进来的图片(src 指向原件地址) */
const imageCount = (tab) => tab.evaluate(() => [...document.querySelectorAll(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) img')].filter((img) => img.getAttribute('src')?.startsWith('/api/v1/raw?')).length)

/** 等正文里的图片数到达 n(上传 + 插入是异步的) */
const imagesReach = (tab, count) =>
  tab
    .waitForFunction((n) => [...document.querySelectorAll(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) img')].filter((img) => img.getAttribute('src')?.startsWith('/api/v1/raw?')).length >= n, count, { timeout: 8000 })
    .then(() => true)
    .catch(() => false)

/** 统一外壳文本面的拍照 / 相册上传场景（旧编辑器的 `-legacy` 变体已删除） */
function cameraScenarios(P) {
  const SUFFIX = P.suffix
  const EDIT = {
    // 夹具里这篇笔记的集合名是 knowledgeBase/insights，不符合真实的命名规则（_global / proj_* / ext_*）：
    // 上传后写进正文的 kb://集合/路径 解析不了，图片显示成破图（两条路径、基线都一样）。给它一个合法的集合名，
    // 这些场景才能验证“选完图片真的插进正文”这一步
    fixture: {
      ...SOLO_EDIT_FIXTURE,
      get_item: (args) => {
        const reply = dynamicResponses.get_item(args)
        return { ...reply, item: { ...reply.item, collection: 'proj_knowledgebase' } }
      },
    },
    route: `/kb?collection=${COLLECTION}&item=ins_8f21${P.query}`,
    ready: '.kb-workspace-bar-right',
  }
  const tool = (tab, label) => nativeTool(tab, NATIVE_TOOL[label])
  return {
  [`camera-sheet-phone${SUFFIX}`]: {
    // 手机:点"上传图片"出底部面板,两项 拍照 / 从相册选;面板在屏内、贴底、行高 ≥44、盖在工具栏之上;三个 input 的属性要对;还没有弹系统选择器。
    // 截图停在面板打开的状态
    ...EDIT,
    sizes: ['390x844'],
    prepare: async (tab) => {
      await openEditor(tab)
      await tapCenter(tab, await tool(tab, '上传图片'))
      await tab.waitForSelector('[data-testid=drop-sheet]', { timeout: 5000 })
    },
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const sheet = await settled(tab, '[data-testid=sheet]')
      if (!sheet) return ['点"上传图片"后没有出面板']
      if (sheet.bottom > size.height + 1 || sheet.top < 0) issues.push(`面板不在屏内:${Math.round(sheet.top)}–${Math.round(sheet.bottom)} / ${size.height}`)
      if (sheet.left < -1 || sheet.right > size.width + 1) issues.push(`面板横向超出:${Math.round(sheet.left)}–${Math.round(sheet.right)}`)
      if (Math.abs(sheet.bottom - size.height) > 1.5) issues.push(`底部面板应贴着屏幕底边,下缘 ${Math.round(sheet.bottom)} / ${size.height}`)
      if ((await rowTexts(tab)).join() !== '拍照,从相册选') issues.push(`面板应只有 拍照 / 从相册选,实际 ${JSON.stringify(await rowTexts(tab))}`)
      if ((await tab.locator('[data-testid=sheet] .kb-sheet-title').innerText()) !== '上传图片') issues.push('面板标题应是"上传图片"')
      const rows = await tab.evaluate(() =>
        [...document.querySelectorAll('[data-testid=drop-sheet] .kb-drop-opt')].map((el) => {
          const box = el.getBoundingClientRect()
          const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          return { text: el.querySelector('b')?.textContent, w: box.width, h: box.height, top: box.top, bottom: box.bottom, covered: !el.contains(top) }
        }),
      )
      for (const row of rows) {
        if (row.h < 44 || row.w < 44) issues.push(`"${row.text}"可点区域不足 44px:${Math.round(row.w)}×${Math.round(row.h)}`)
        if (row.covered) issues.push(`"${row.text}"被别的东西盖住了(工具栏压在面板上?)`)
      }
      for (let index = 1; index < rows.length; index += 1) if (rows[index].top < rows[index - 1].bottom - 0.5) issues.push('面板的行互相重叠')
      // 工具栏不能压在面板上:面板左上角往下一点的位置,最顶层元素属于面板
      const bar = await rectOf(tab, P.bar)
      if (bar && bar.bottom > sheet.top + 1 && bar.top < sheet.bottom) {
        const coveredBy = await tab.evaluate(([x, y, bar]) => (document.elementFromPoint(x, y)?.closest(bar) ? 'toolbar' : ''), [size.width / 2, Math.max(bar.top, sheet.top) + 4, P.bar])
        if (coveredBy) issues.push('工具栏压在面板上面')
      }
      // 三个 input 的属性
      const attrs = await tab.evaluate(() =>
        Object.fromEntries(
          ['pick-camera', 'pick-image', 'pick-attach'].map((id) => {
            const el = document.querySelector(`.kb-dp [data-testid=${id}]`)
            return [id, el ? { accept: el.getAttribute('accept'), capture: el.getAttribute('capture'), multiple: el.hasAttribute('multiple') } : null]
          }),
        ),
      )
      const camera = attrs['pick-camera']
      const album = attrs['pick-image']
      const attach = attrs['pick-attach']
      if (!camera || camera.accept !== 'image/*' || camera.capture !== 'environment') issues.push(`拍照 input 应是 accept=image/* capture=environment,实际 ${JSON.stringify(camera)}`)
      if (!album || album.accept !== 'image/*' || !album.multiple || album.capture !== null) issues.push(`相册 input 应是 accept=image/* + multiple 且没有 capture,实际 ${JSON.stringify(album)}`)
      if (!attach || !attach.multiple || attach.capture !== null || (attach.accept ?? '') !== '') issues.push(`附件 input 应不限类型 + multiple,实际 ${JSON.stringify(attach)}`)
      if (choosersOf(tab).length) issues.push(`出面板时不该已经弹系统选择器(${choosersOf(tab).length} 次)`)
      return issues
    },
  },

  [`camera-sheet-keyboard${SUFFIX}`]: {
    // 手机、软键盘开着(工具栏贴键盘):点"上传图片"出面板,面板落在键盘上沿之上(不被键盘盖住),行不被工具栏压住、能点到。
    // 面板一打开就拿走焦点,键盘状态随之变成"收起"、工具栏放开(这是 KbSheet 的既有行为);所以这里不断言工具栏是否仍贴着,
    // 只断言用户看到的结果:面板在可视区内、"拍照"能点到并唤起拍照 input
    ...EDIT,
    sizes: ['390x844'],
    init: FAKE_VISUAL_VIEWPORT,
    prepare: async (tab, size) => {
      await openEditor(tab)
      await tab.click(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) > p:last-of-type')
      await setKeyboard(tab, keyboardHeight(size))
    },
    settle: 300,
    assert: async (tab, size) => {
      const issues = []
      const docked = await tab.evaluate((root) => document.querySelector(root)?.classList.contains('is-docked') ?? false, P.dockRoot)
      if (!docked) issues.push('前提不成立:假键盘打开后工具栏应贴键盘')
      await tapCenter(tab, await tool(tab, '上传图片'))
      await tab.waitForSelector('[data-testid=drop-sheet]', { timeout: 3000 }).catch(() => issues.push('键盘开着点"上传图片"没有出面板'))
      const sheet = await settled(tab, '[data-testid=sheet]')
      const visibleBottom = size.height - keyboardHeight(size)
      if (!sheet) issues.push('键盘开着时没有面板')
      else if (sheet.bottom > visibleBottom + 1.5) issues.push(`面板被键盘盖住了:下缘 ${Math.round(sheet.bottom)} > 键盘上沿 ${visibleBottom}`)
      // tapCenter 在被别的元素盖住时会抛错:这里点"拍照"这一行,就等于验证了它能被点到
      const before = choosersOf(tab).length
      await tapCenter(tab, tab.locator('[data-testid=opt-camera]'))
      const picked = await nextChooser(tab, before)
      if (picked?.id !== 'pick-camera') issues.push(`键盘开着点"拍照"应唤起拍照 input,实际 ${picked?.id ?? '没有弹选择器'}`)
      return issues
    },
  },

  [`camera-flow-phone${SUFFIX}`]: {
    // 手机的完整流程:Esc 只关面板 → 拍照(通用名 image.png 被改成"拍照-时间")→ 相册(原名)→ 附件不出面板;每一步选完都收面板,图片真的插进正文
    ...EDIT,
    sizes: ['390x844'],
    prepare: openEditor,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const created = watchUploads(tab)
      const hasEditor = () => tab.locator(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)[contenteditable="true"]').count()

      // 1. Esc 先关面板,不是关编辑。探针挂在 window 冒泡阶段,代表页面上的 Esc 处理(专注模式 / 信息栏 / 侧栏);
      //    第二下 Esc(面板已关)必须能让探针计数——否则探针本身是坏的,"为 0"就不算证据
      await tab.evaluate(() => {
        window.__escSeen = 0
        window.addEventListener('keydown', (event) => event.key === 'Escape' && (window.__escSeen += 1))
      })
      await tapCenter(tab, await tool(tab, '上传图片'))
      await tab.waitForSelector('[data-testid=drop-sheet]', { timeout: 5000 })
      await settled(tab, '[data-testid=sheet]')
      await tab.keyboard.press('Escape')
      const closed = await tab.waitForSelector('[data-testid=sheet]', { state: 'detached', timeout: 3000 }).then(() => true).catch(() => false)
      if (!closed) return [...issues, 'Esc 应关闭面板(没关,后面的步骤无从谈起)']
      const seenWhileOpen = await tab.evaluate(() => window.__escSeen)
      if (seenWhileOpen !== 0) issues.push(`面板开着按 Esc,页面上的 Esc 处理也被触发了(${seenWhileOpen} 次)`)
      if (!(await hasEditor())) issues.push('Esc 关面板时编辑器不该退出编辑')
      await tab.keyboard.press('Escape')
      if ((await tab.evaluate(() => window.__escSeen)) !== 1) issues.push('探针自检失败:面板关了以后的 Esc 应该能到达页面')

      // 2. 拍照
      await tapCenter(tab, await tool(tab, '上传图片'))
      await tab.waitForSelector('[data-testid=drop-sheet]', { timeout: 5000 })
      await settled(tab, '[data-testid=sheet]')
      let before = choosersOf(tab).length
      await tapCenter(tab, tab.locator('[data-testid=opt-camera]'))
      const camera = await nextChooser(tab, before)
      if (camera?.id !== 'pick-camera') issues.push(`点"拍照"应唤起拍照 input,实际 ${camera?.id ?? '没有弹选择器'}`)
      if (await sheetOf(tab).count()) issues.push('点"拍照"后面板应收起')
      if (camera) await camera.chooser.setFiles({ name: 'image.png', mimeType: 'image/png', buffer: PNG })
      if (!(await imagesReach(tab, 1))) issues.push('拍的照片没有插进正文')
      if (!created.some((item) => /^拍照-\d{8}-\d{6}\.png$/.test(item.name ?? ''))) issues.push(`拍照的通用名 image.png 应改成"拍照-时间.png",创建上传的请求:${JSON.stringify(created.map((item) => item.name))}`)

      // 3. 从相册选:原名保留,多选两张
      await tapCenter(tab, await tool(tab, '上传图片'))
      await tab.waitForSelector('[data-testid=drop-sheet]', { timeout: 5000 })
      await settled(tab, '[data-testid=sheet]')
      before = choosersOf(tab).length
      await tapCenter(tab, tab.locator('[data-testid=opt-album]'))
      const album = await nextChooser(tab, before)
      if (album?.id !== 'pick-image') issues.push(`点"从相册选"应唤起相册 input,实际 ${album?.id ?? '没有弹选择器'}`)
      if (await sheetOf(tab).count()) issues.push('点"从相册选"后面板应收起')
      if (album)
        await album.chooser.setFiles([
          { name: 'IMG_0042.PNG', mimeType: 'image/png', buffer: PNG },
          { name: 'IMG_0043.PNG', mimeType: 'image/png', buffer: PNG },
        ])
      if (!(await imagesReach(tab, 3))) issues.push(`相册选的两张应插进正文(共 3 张),实际 ${await imageCount(tab)} 张`)
      if (!created.some((item) => item.name === 'IMG_0042.PNG') || !created.some((item) => item.name === 'IMG_0043.PNG')) issues.push(`相册选的文件应原名上传:${JSON.stringify(created.map((item) => item.name))}`)

      // 4. 附件:不出面板,直接唤起选文件
      before = choosersOf(tab).length
      await tapCenter(tab, await tool(tab, '上传附件'))
      const attach = await nextChooser(tab, before)
      if (attach?.id !== 'pick-attach') issues.push(`"上传附件"应直接唤起选文件 input,实际 ${attach?.id ?? '没有弹选择器'}`)
      await expectNoSheet(tab, issues, '"上传附件"不该出面板')
      if (!(await hasEditor())) issues.push('流程走完编辑器应仍在编辑')
      return issues
    },
  },

  [`camera-direct-wide${SUFFIX}`]: {
    // 触屏平板(820 宽,pointer: coarse)和电脑(1440 宽,鼠标):保持直接选文件——点"上传图片"不出面板、没有相机 input,
    // 选的图片原名上传(包括叫 image.png 的:只有拍照那一路才改名);"上传附件"同样直接选
    ...EDIT,
    sizes: ['820x1180', '1440x900'],
    prepare: openEditor,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const created = watchUploads(tab)
      let before = choosersOf(tab).length
      await tapCenter(tab, await tool(tab, '上传图片'))
      const image = await nextChooser(tab, before)
      if (image?.id !== 'pick-image') issues.push(`点"上传图片"应直接唤起图片 input,实际 ${image?.id ?? '没有弹选择器'}`)
      await expectNoSheet(tab, issues, '平板 / 电脑点"上传图片"不该出面板')
      if (await tab.locator('.kb-dp [data-testid=pick-camera]').count()) issues.push('平板 / 电脑不该有相机 input')
      const accept = await tab.locator('.kb-dp [data-testid=pick-image]').getAttribute('accept')
      if (accept !== 'image/*') issues.push(`图片 input 应是 accept=image/*,实际 ${accept}`)
      if (image) await image.chooser.setFiles({ name: 'image.png', mimeType: 'image/png', buffer: PNG })
      if (!(await imagesReach(tab, 1))) issues.push('选的图片没有插进正文')
      if (!created.some((item) => item.name === 'image.png')) issues.push(`电脑 / 平板选的图片应原名上传(不改成"拍照-…"):${JSON.stringify(created.map((item) => item.name))}`)

      before = choosersOf(tab).length
      await tapCenter(tab, await tool(tab, '上传附件'))
      const attach = await nextChooser(tab, before)
      if (attach?.id !== 'pick-attach') issues.push(`"上传附件"应直接唤起选文件 input,实际 ${attach?.id ?? '没有弹选择器'}`)
      await expectNoSheet(tab, issues, '平板 / 电脑点"上传附件"不该出面板')
      return issues
    },
  },
  }
}

export const CAMERA_SCENARIOS = {
  ...cameraScenarios({ id: 'native', suffix: '', query: '', bar: '.kb-editor-chrome-tools', dockRoot: '.kb-editor-chrome' }),
}
