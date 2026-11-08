// 上传选「拍照 / 相册 / 文件」(设计规范)的页面场景。由 viewer-shots.mjs 引入。
// 手机触屏(<600):点上传先出底部弹层,三项各唤起一个 input(capture / accept 要对),选完走原来的上传流程;
// 平板 / 电脑(鼠标):保持「选择文件 / 选择文件夹」。
// Playwright 里没有真的相机和相册:用 setInputFiles 往对应的 input 里放文件,验证它们之后进了和拖放同一条上传流程
// (预检 → 创建上传 → 入队)。真机上相机 / 相册的系统选择器只能在 iPhone / 安卓手机上看。
import { ingestStory } from './fixture.mjs'
import { overflowIssues } from './admin-scenarios.mjs'

const rect = (tab, selector) =>
  tab.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
  }, selector)

/** 弹层有进场动画:位置连续两次相同才算稳定 */
async function settled(tab, selector) {
  let last = null
  for (let index = 0; index < 20; index += 1) {
    const now = await rect(tab, selector)
    if (now && last && Math.abs(now.top - last.top) < 0.5) return now
    last = now
    await tab.waitForTimeout(60)
  }
  return last
}

/** 记下页面发出的「创建上传」请求体({ name, rel_path, … }) */
function watchUploads(tab) {
  const created = []
  tab.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/uploads') created.push(request.postDataJSON() ?? {})
  })
  return created
}
const names = (created) => JSON.stringify(created.map((item) => item.name))

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

export const UPLOAD_SCENARIOS = {
  'upload-picker-phone': {
    // 手机:弹层三项 → 各自的 input 属性 → 选完进入上传流程;拍照的通用名被改成带时间的名字;弹层在屏内、行高 ≥44
    route: '/import',
    ready: '[data-testid=import-drop]',
    fixture: ingestStory,
    sizes: ['360x780', '390x844', '430x932'],
    settle: 600,
    assert: async (tab, size) => {
      const issues = []
      const created = watchUploads(tab)
      const drop = tab.locator('[data-testid=import-drop]')
      const buttons = await drop.locator('.kb-drop-actions button').allInnerTexts()
      if (buttons.join() !== '上传文件') issues.push(`手机上拖入区只该有一个「上传文件」按钮,实际 ${JSON.stringify(buttons)}`)
      if ((await drop.innerText()).includes('选择文件夹')) issues.push('手机不支持选文件夹,不该显示')
      if (await tab.locator('[data-testid=sheet]').count()) issues.push('没点之前不该有弹层')

      await tab.locator('[data-testid=drop-pick]').click()
      await tab.waitForSelector('[data-testid=drop-sheet]')
      const sheet = await settled(tab, '[data-testid=sheet]')
      if (!sheet) return [...issues, '点「上传文件」后没有弹层']
      if (sheet.bottom > size.height + 1 || sheet.top < 0) issues.push(`弹层不在屏内:${Math.round(sheet.top)}–${Math.round(sheet.bottom)} / ${size.height}`)
      if (sheet.left < -1 || sheet.right > size.width + 1) issues.push(`弹层横向超出:${Math.round(sheet.left)}–${Math.round(sheet.right)}`)
      if (Math.abs(sheet.bottom - size.height) > 1.5) issues.push(`底部弹层应贴着屏幕底边,下缘 ${Math.round(sheet.bottom)} / ${size.height}`)
      const rows = await tab.evaluate(() =>
        [...document.querySelectorAll('[data-testid=drop-sheet] .kb-drop-opt')].map((el) => {
          const box = el.getBoundingClientRect()
          return { text: el.querySelector('b')?.textContent, w: box.width, h: box.height, top: box.top, bottom: box.bottom }
        }),
      )
      if (rows.map((row) => row.text).join() !== '拍照,从相册选,选择文件') issues.push(`弹层三项应是 拍照 / 从相册选 / 选择文件,实际 ${JSON.stringify(rows.map((row) => row.text))}`)
      for (const row of rows) if (row.h < 44 || row.w < 44) issues.push(`「${row.text}」可点区域不足 44px:${Math.round(row.w)}×${Math.round(row.h)}`)
      for (let index = 1; index < rows.length; index += 1) if (rows[index].top < rows[index - 1].bottom - 0.5) issues.push('弹层的行互相重叠')
      if (rows.length && rows.at(-1).bottom > sheet.bottom + 0.5) issues.push('最后一行超出了弹层')

      // 三个 input 的属性
      const attrs = await tab.evaluate(() =>
        Object.fromEntries(
          ['pick-camera', 'pick-album', 'pick-file'].map((id) => {
            const el = document.querySelector(`[data-testid=${id}]`)
            return [id, el ? { accept: el.getAttribute('accept'), capture: el.getAttribute('capture'), multiple: el.hasAttribute('multiple'), type: el.type } : null]
          }),
        ),
      )
      const camera = attrs['pick-camera']
      const album = attrs['pick-album']
      const file = attrs['pick-file']
      if (!camera || camera.accept !== 'image/*' || camera.capture !== 'environment' || camera.type !== 'file') issues.push(`拍照 input 应是 accept=image/* capture=environment,实际 ${JSON.stringify(camera)}`)
      if (!album || album.accept !== 'image/*,video/*' || !album.multiple || album.capture !== null) issues.push(`相册 input 应是 accept=image/*,video/* + multiple 且没有 capture,实际 ${JSON.stringify(album)}`)
      if (!file || !file.multiple || file.capture !== null || (file.accept ?? '') !== '') issues.push(`文件 input 应不限类型 + multiple,实际 ${JSON.stringify(file)}`)

      // Esc 只关弹层
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('[data-testid=sheet]', { state: 'detached', timeout: 3000 }).catch(() => issues.push('Esc 应关闭弹层'))

      // 选完进入上传流程:拍照(通用名 image.png)→ 改名后创建上传
      await tab.locator('[data-testid=pick-camera]').setInputFiles({ name: 'image.png', mimeType: 'image/png', buffer: PNG })
      await tab.waitForTimeout(900)
      if (!created.some((item) => /^拍照-\d{8}-\d{6}\.png$/.test(item.name ?? ''))) issues.push(`拍照的文件应以「拍照-时间.png」进入上传流程,创建上传的请求:${names(created)}`)

      // 相册:原名保留,走同一条流程
      await tab.locator('[data-testid=pick-album]').setInputFiles({ name: 'IMG_0042.PNG', mimeType: 'image/png', buffer: PNG })
      await tab.waitForTimeout(900)
      if (!created.some((item) => item.name === 'IMG_0042.PNG')) issues.push(`相册选的文件应原名进入上传流程:${names(created)}`)

      // 文件:原名保留
      await tab.locator('[data-testid=pick-file]').setInputFiles({ name: '合同.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
      await tab.waitForTimeout(900)
      if (!created.some((item) => item.name === '合同.txt')) issues.push(`「选择文件」选的文件应原名进入上传流程:${names(created)}`)

      // 相册多选两张:和拖放多个文件一样进入「上传预览」
      await tab.locator('[data-testid=pick-album]').setInputFiles([
        { name: 'a.png', mimeType: 'image/png', buffer: PNG },
        { name: 'b.png', mimeType: 'image/png', buffer: PNG },
      ])
      await tab.waitForSelector('.kb-fp', { timeout: 5000 }).catch(() => issues.push('相册多选后应进入和拖放一样的上传预览'))
      return issues
    },
  },

  'upload-picker-sheet': {
    // 只为截图和版面:弹层打开的样子(上面的场景最后会走到上传预览,截图落在别的状态上)
    route: '/import',
    ready: '[data-testid=import-drop]',
    fixture: ingestStory,
    sizes: ['390x844'],
    prepare: async (tab) => {
      await tab.locator('[data-testid=drop-pick]').click()
      await tab.waitForSelector('[data-testid=drop-sheet]')
    },
    settle: 500,
    assert: async (tab) => ((await settled(tab, '[data-testid=sheet]')) ? [] : ['没有弹层']),
  },

  'upload-picker-desktop': {
    // 平板 / 电脑(宽 ≥600)保持原来的「选择文件 / 选择文件夹」:没有弹层,没有相机 / 相册 input;选完同样进入上传流程
    route: '/import',
    ready: '[data-testid=import-drop]',
    fixture: ingestStory,
    sizes: ['744x1133', '820x1180', '1180x820', '1440x900', '1920x1080'],
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const created = watchUploads(tab)
      const drop = tab.locator('[data-testid=import-drop]')
      const buttons = await drop.locator('.kb-drop-actions button').allInnerTexts()
      if (buttons.join() !== '选择文件,选择文件夹') issues.push(`平板 / 电脑应保持「选择文件」「选择文件夹」,实际 ${JSON.stringify(buttons)}`)
      for (const id of ['drop-pick', 'pick-camera', 'pick-album']) if (await tab.locator(`[data-testid=${id}]`).count()) issues.push(`平板 / 电脑不该有 ${id}`)
      const folder = await tab.evaluate(() => ({ dir: document.querySelector('[data-testid=pick-folder]')?.hasAttribute('webkitdirectory'), accept: document.querySelector('[data-testid=pick-file]')?.getAttribute('accept') }))
      if (!folder.dir) issues.push('「选择文件夹」的 input 应带 webkitdirectory')
      if ((folder.accept ?? '') !== '') issues.push(`「选择文件」不该限类型,实际 accept=${folder.accept}`)
      await tab.locator('[data-testid=pick-file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') })
      await tab.waitForTimeout(900)
      if (await tab.locator('[data-testid=sheet]').count()) issues.push('平板 / 电脑选文件不该出弹层')
      if (!created.some((item) => item.name === 'notes.txt')) issues.push(`选完文件应进入上传流程:${names(created)}`)
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'upload-picker-adddata': {
    // 「添加数据」对话框里的上传:手机上文案对齐导入页(没有「拖入」「文件夹」)、出同一个来源弹层;选完进待传清单,Esc 只关弹层不关对话框
    route: '/import',
    ready: '[data-testid=import-add]',
    fixture: ingestStory,
    sizes: ['390x844', '820x1180', '1440x900'],
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const phone = size.width < 600
      await tab.locator('[data-testid=import-add]').click()
      await tab.waitForSelector('.kb-add-types')
      await tab.waitForTimeout(400)
      const zone = await tab.locator('.kb-add-zone').innerText()
      if (phone) {
        if (zone.includes('拖入') || zone.includes('选择文件夹') || zone.includes('整个文件夹')) issues.push(`手机上「添加数据」的上传区不该提拖入或文件夹:${zone.replace(/\s+/g, ' ').slice(0, 80)}`)
        const upload = await tab.locator('.kb-add-types .stype', { hasText: '上传文件' }).innerText()
        if (upload.includes('文件夹') || upload.includes('拖拽')) issues.push(`手机上「上传文件」的说明不该提文件夹或拖拽:${upload.replace(/\s+/g, ' ')}`)
        await tab.locator('.kb-add-zone [data-testid=drop-pick]').click()
        await tab.waitForSelector('[data-testid=drop-sheet]')
        await settled(tab, '[data-testid=sheet]')
        // Esc:只关来源弹层,对话框和里面的内容还在
        await tab.keyboard.press('Escape')
        await tab.waitForSelector('[data-testid=sheet]', { state: 'detached', timeout: 3000 }).catch(() => issues.push('Esc 应关掉来源弹层'))
        if (!(await tab.locator('.kb-add-types').count())) return [...issues, 'Esc 关来源弹层时不该把「添加数据」对话框也关了']
        // 相册选两张 → 进待传清单(不是直接上传)
        await tab.locator('.kb-add-zone [data-testid=pick-album]').setInputFiles([
          { name: 'a.png', mimeType: 'image/png', buffer: PNG },
          { name: 'b.png', mimeType: 'image/png', buffer: PNG },
        ])
        await tab.waitForSelector('.kb-add-file', { timeout: 4000 }).catch(() => issues.push('选完的文件应进入「添加数据」的待传清单'))
        const staged = await tab.locator('.kb-add-file-name').allInnerTexts()
        if (staged.join() !== 'a.png,b.png') issues.push(`待传清单应是 a.png, b.png,实际 ${JSON.stringify(staged)}`)
        // 点「开始解析」走原来的 requestUpload
        const created = watchUploads(tab)
        await tab.getByRole('button', { name: '开始解析' }).click()
        await tab.waitForTimeout(1200)
        if (!created.length && !(await tab.locator('.kb-fp').count())) issues.push('点「开始解析」后应进入上传流程')
      } else {
        if (!zone.includes('拖入文件或文件夹即可添加')) issues.push('电脑 / 平板上应写「拖入文件或文件夹即可添加」')
        if (!zone.includes('选择文件夹')) issues.push('电脑 / 平板上应有「选择文件夹」')
        await tab.locator('.kb-add-zone [data-testid=pick-file]').setInputFiles({ name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('x') })
        await tab.waitForSelector('.kb-add-file', { timeout: 4000 }).catch(() => issues.push('选完的文件应进入待传清单'))
      }
      return issues
    },
  },
}
