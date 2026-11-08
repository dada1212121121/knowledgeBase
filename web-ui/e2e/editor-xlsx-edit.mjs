#!/usr/bin/env node
/**
 * XLSX 原生编辑 e2e
 *
 * 覆盖：打开即编辑、就地输入 / 公式栏、样式按钮、撤销重做、保存请求形状、
 * 409 版本冲突、拿不到编辑权时只读、带着旧的 `?editor=legacy` 链接进来也照样是原生编辑器（参数被忽略）。
 *
 * 用法：
 *   npm run build && node e2e/editor-xlsx-edit.mjs
 *
 * 服务端替身在 `e2e/fixture.mjs`（files/lock、files/replace、office/session），
 * 不需要守护进程，也不会碰到真实文件。
 */
import { contextOptions, launch } from './devices.mjs'
import { installFixture } from './fixture.mjs'
import { SOLO_EDIT_FIXTURE } from './editor-helpers.mjs'
import { startStaticServer } from './serve.mjs'

const COLLECTION = 'knowledgeBase%2Finsights'
const PAGE = `/kb?collection=${COLLECTION}&item=file_xlsx`

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await wait(50)
  }
  return false
}

async function openOffice(tab, base) {
  await tab.goto(`${base}${PAGE}`, { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector('[data-testid="office-edit-open"]', { timeout: 20_000 })
  await tab.click('[data-testid="office-edit-open"]')
  await tab.waitForSelector('[data-testid="office-native-host"] .kb-xg .kb-xg-canvas', { timeout: 30_000 })
  await waitFor(async () => !(await tab.locator('.kb-xg-loading').count()), 20_000)
  await tab.waitForFunction(() => (document.querySelector('.kb-xg-cellname')?.textContent ?? '').trim() === 'A1', null, {
    timeout: 10_000,
  })
}

/** 输入一个值：可打印字符直接进就地编辑，回车提交 */
async function typeIntoCell(tab, value) {
  await tab.locator('.kb-xg').focus()
  await tab.keyboard.type(value)
  await tab.waitForSelector('[data-testid="xlsx-cell-editor"]', { timeout: 3000 })
  await tab.keyboard.press('Enter')
  await wait(150)
  // 回车按 Excel 习惯下移一格；回到原来那格，公式栏才是刚写入的值
  await tab.keyboard.press('ArrowUp')
  await wait(100)
}

const formulaValue = (tab) => tab.locator('.kb-xg-formula-input').inputValue()

async function main() {
  const { server, base } = await startStaticServer()
  const browser = await launch('chromium')
  const issues = []

  async function withPage(extra, fn) {
    const context = await browser.newContext(
      contextOptions({ width: 1440, height: 900, dpr: 1, touch: false, mobile: false }, 'chromium', { locale: 'zh-CN' }),
    )
    // 服务端替身状态要由场景持有：installFixture 内部会浅拷贝 overrides，只有对象引用能共享
    const state = {}
    await installFixture(context, { ...SOLO_EDIT_FIXTURE, ...extra, __officeEdit: state })
    const tab = await context.newPage()
    tab.on('pageerror', (error) => issues.push(`页面异常：${error.message}`))
    try {
      await fn(tab, state)
    } finally {
      await context.close()
    }
  }

  try {
    await withPage({}, async (tab, office) => {
      await openOffice(tab, base)

      // 1. 初始是「可编辑」：工具栏在、保存按钮在、cellname 正确
      if (!(await tab.locator('[data-testid="xlsx-bold"]').count())) issues.push('可编辑态没有样式工具栏')
      if (!(await tab.locator('[data-testid="editor-save"]').count())) issues.push('可编辑态没有保存按钮')

      // 2. 键入即编辑，回车提交；公式栏回显同一个值
      const original = await formulaValue(tab)
      await typeIntoCell(tab, '42')
      if ((await formulaValue(tab)) !== '42') issues.push(`输入 42 后公式栏是「${await formulaValue(tab)}」`)
      if (await tab.locator('[data-testid="xlsx-cell-editor"]').count()) issues.push('提交后编辑框没有关闭')
      if (!(await tab.locator('[data-testid="editor-save"]').isEnabled())) issues.push('有改动但保存按钮仍禁用')
      if (!(await tab.locator('[data-testid="office-dirty"]').count())) issues.push('有改动但外层没有显示未保存提示')

      // 3. 撤销 / 重做（引擎历史，走 CommandBus；CommandBus 只管权限与串行，不抢引擎的历史）
      await tab.click('[data-testid="editor-undo"]')
      await wait(200)
      if ((await formulaValue(tab)) !== original) issues.push(`撤销后应回到原值「${original}」，实际「${await formulaValue(tab)}」`)
      await tab.click('[data-testid="editor-redo"]')
      await wait(200)
      if ((await formulaValue(tab)) !== '42') issues.push(`重做后公式栏应回到 42，实际「${await formulaValue(tab)}」`)

      // 4. 公式：以 = 开头写入，引擎负责计算；这里只验证输入没有被当文本吞掉
      await typeIntoCell(tab, '=1+1')
      if ((await formulaValue(tab)) !== '=1+1') issues.push(`公式栏应原样保留 =1+1，实际「${await formulaValue(tab)}」`)

      // 5. 样式：加粗后按钮进入选中态（格式回读走引擎 captureFormat）
      await tab.click('[data-testid="xlsx-bold"]')
      const boldOn = await waitFor(
        () => tab.locator('[data-testid="xlsx-bold"]').evaluate((el) => el.classList.contains('is-on')),
        5000,
      )
      if (!boldOn) {
        const notice = await tab.locator('.kb-xg-notice').textContent().catch(() => '')
        const cell = await tab.locator('.kb-xg-cellname').textContent().catch(() => '')
        issues.push(`点加粗后工具栏没有回显选中态（cell=${cell}, notice=${notice}）`)
      }

      // 6. 保存：请求带原哈希与编辑权 session，字节是 ZIP
      await tab.click('[data-testid="editor-save"]')
      const saved = await waitFor(() => office.replaces.length > 0, 15_000)
      if (!saved) {
        issues.push('点保存后没有发出 replace 请求')
      } else {
        const request = office.replaces[0]
        if (!request.zip) issues.push('保存的字节不是 ZIP（缺少 PK 头）')
        if (request.bytes < 1000) issues.push(`保存的字节只有 ${request.bytes} B，疑似空包`)
        if (request.expected !== 'sha-fixture-original') issues.push(`保存没有带原始哈希：${request.expected}`)
        if (!request.session) issues.push('保存没有带编辑权 session')
        const status = await tab.locator('[data-testid="editor-status"]').textContent()
        const revision = await tab.locator('[data-testid="editor-revision"]').textContent().catch(() => '')
        if (!/已就绪/.test(status ?? '')) issues.push(`保存后状态是「${status}」`)
        if (!/v9/.test(revision ?? '')) issues.push(`保存后没有显示服务端版本 9，实际「${revision}」`)
      }
    })

    await withPage({}, async (tab, office) => {
      // 7. 409：服务端说文件已被别人改过 → 界面进入「版本冲突」，不能静默当成功
      office.conflict = true
      await openOffice(tab, base)
      await typeIntoCell(tab, '7')
      await tab.click('[data-testid="editor-save"]')
      const conflicted = await waitFor(
        async () => /冲突/.test((await tab.locator('[data-testid="editor-status"]').textContent()) ?? ''),
        10_000,
      )
      if (!conflicted) issues.push('409 后状态条没有显示版本冲突')
    })

    await withPage({}, async (tab, office) => {
      // 8. 编辑权在别人手里：打开只读，没有样式工具栏，也没有保存按钮
      office.held = false
      await openOffice(tab, base)
      if (await tab.locator('[data-testid="xlsx-bold"]').count()) issues.push('只读态不应出现样式工具栏')
      if (await tab.locator('[data-testid="editor-save"]').count()) issues.push('只读态不应出现保存按钮')
    })

    await withPage({}, async (tab) => {
      // 9. 100 步撤销 / 重做：验收要求连续 100 次编辑后能完整回到原值，再完整重放
      await openOffice(tab, base)
      const original = await formulaValue(tab)
      for (let i = 1; i <= 100; i += 1) {
        await tab.locator('.kb-xg').focus()
        await tab.keyboard.type(String(i))
        await tab.waitForSelector('[data-testid="xlsx-cell-editor"]', { timeout: 3000 })
        await tab.keyboard.press('Enter')
        await wait(120)
        await tab.keyboard.press('ArrowUp')
        await wait(30)
      }
      if ((await formulaValue(tab)) !== '100') issues.push(`100 次编辑后应停在 100，实际「${await formulaValue(tab)}」`)
      for (let i = 0; i < 100; i += 1) {
        await tab.click('[data-testid="editor-undo"]')
        await wait(20)
      }
      await wait(300)
      if ((await formulaValue(tab)) !== original) issues.push(`100 步撤销后应回到「${original}」，实际「${await formulaValue(tab)}」`)
      for (let i = 0; i < 100; i += 1) {
        await tab.click('[data-testid="editor-redo"]')
        await wait(20)
      }
      await wait(300)
      if ((await formulaValue(tab)) !== '100') issues.push(`100 步重做后应回到 100，实际「${await formulaValue(tab)}」`)
    })

    await withPage({}, async (tab) => {
      // 10. 旧链接 / 书签里的 ?editor=legacy 被忽略：照样是原生编辑器（它不再是回退开关）
      await tab.goto(`${base}${PAGE}&editor=legacy`, { waitUntil: 'domcontentloaded' })
      await tab.waitForSelector('[data-testid="office-edit-open"]', { timeout: 20_000 })
      await tab.click('[data-testid="office-edit-open"]')
      await tab.waitForSelector('[data-testid="office-native-host"]', { timeout: 30_000 }).catch(() => issues.push('带 ?editor=legacy 打开应该仍是原生编辑器'))
      if (await tab.locator('.kb-sg-tab').count()) issues.push('?editor=legacy 不应再出现旧表格视图')
    })
  } finally {
    await browser.close()
    await server.close()
  }

  if (issues.length) {
    console.log(`\n${issues.length} 项未通过\n  ${issues.join('\n  ')}`)
    process.exitCode = 1
  } else {
    console.log('✓ xlsx 原生编辑 e2e 全部通过')
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
