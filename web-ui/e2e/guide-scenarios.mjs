// 使用指南的页面场景。由 viewer-shots.mjs 引入,默认跑 core 五个尺寸 × 两个引擎。
//   - 页面:目录与正文对得上、每张截图都加载出来、下载链接真的能下(HEAD 返回 200 且类型对)、
//     页内锚点滚动并聚焦、不横向溢出、触屏可点区域、无障碍(深浅色各查一遍);
//   - 入口:「我的」页和头像菜单都能进来;
//   - AI 总开关关闭:整页没有「AI」字样。
// 下载文件在 public/guide/ 下,所以要先 npm run build,静态服务才托管得到。
import { AI_OFF_ME } from './flow-scenarios.mjs'
import { overflowIssues } from './admin-scenarios.mjs'
import { axeIssues } from './axe-helpers.mjs'
import { smallTargets } from './share-scenarios.mjs'

/** 窄屏上目录折在 <details> 里:先展开,里面的链接才有大小 */
async function openToc(tab) {
  const fold = tab.locator('[data-testid=guide-toc] details')
  if ((await fold.count()) && !(await fold.evaluate((el) => el.open))) await fold.locator('summary').click()
}

/** 截图是 loading=lazy:改成 eager 逼它们全部加载,再逐张看有没有真的出图 */
async function imageIssues(tab) {
  await tab.evaluate(() => document.querySelectorAll('[data-testid=guide-article] img').forEach((img) => (img.loading = 'eager')))
  await tab
    .waitForFunction(() => [...document.querySelectorAll('[data-testid=guide-article] img')].every((img) => img.complete), null, { timeout: 15_000 })
    .catch(() => undefined)
  const shots = await tab.evaluate(() => [...document.querySelectorAll('[data-testid=guide-article] img')].map((img) => ({ src: img.getAttribute('src'), ok: img.complete && img.naturalWidth > 0 })))
  const issues = shots.filter((shot) => !shot.ok).map((shot) => `截图没加载出来:${shot.src}`)
  if (shots.length < 14) issues.push(`指南里应有 14 张截图,页面上只有 ${shots.length} 张`)
  return issues
}

/** 两个下载链接:真的能取到,类型对,不是被回退成首页 */
async function downloadIssues(tab) {
  const found = await tab.evaluate(async () => {
    const out = []
    for (const id of ['guide-pdf', 'guide-html']) {
      const link = document.querySelector(`[data-testid=${id}]`)
      const href = link?.getAttribute('href') ?? ''
      const response = href ? await fetch(href, { method: 'HEAD' }) : null
      out.push({ id, href, download: link?.getAttribute('download') ?? '', status: response?.status ?? 0, type: response?.headers.get('content-type') ?? '' })
    }
    return out
  })
  const issues = []
  const expected = { 'guide-pdf': /application\/pdf/, 'guide-html': /text\/html/ }
  for (const item of found) {
    if (item.status !== 200) issues.push(`${item.id} 的链接 ${item.href} 返回 ${item.status}`)
    else if (!expected[item.id].test(item.type)) issues.push(`${item.id} 的类型应是 ${expected[item.id]},实际 ${item.type}`)
    if (!item.download.endsWith(item.id === 'guide-pdf' ? '.pdf' : '.html')) issues.push(`${item.id} 缺少保存用的文件名(download 属性):${item.download}`)
  }
  return issues
}

export const GUIDE_SCENARIOS = {
  'guide-page': {
    route: '/guide',
    ready: '[data-testid=guide-article]',
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      // 目录与正文对得上
      const toc = await tab.evaluate(() => {
        const ids = new Set([...document.querySelectorAll('[data-testid=guide-article] [id]')].map((el) => el.id))
        const links = [...document.querySelectorAll('[data-testid=guide-toc] a')].map((a) => a.getAttribute('href').slice(1))
        return { count: links.length, missing: links.filter((id) => !ids.has(id)), headings: document.querySelectorAll('[data-testid=guide-article] h2, [data-testid=guide-article] h3').length }
      })
      if (toc.count < 20) issues.push(`目录项太少:${toc.count}`)
      if (toc.count !== toc.headings) issues.push(`目录 ${toc.count} 项,正文二三级标题 ${toc.headings} 个,应一致`)
      if (toc.missing.length) issues.push(`目录里这些锚点在正文里找不到:${toc.missing.join(', ')}`)

      issues.push(...(await imageIssues(tab)))
      issues.push(...(await downloadIssues(tab)))

      // 宽屏目录常驻;窄屏折在 <details> 里,默认收起
      const hasFold = (await tab.locator('[data-testid=guide-toc] details').count()) > 0
      if (size.width >= 900 && hasFold) issues.push('宽屏上目录应常驻,不该是可折叠的')
      if (size.width < 900 && !hasFold) issues.push('窄屏上目录应折成 <details>')
      await openToc(tab)

      // 点目录项:滚到那一节并把焦点移过去
      await tab.locator('[data-testid=guide-toc] a[href="#tokens"]').click()
      await tab.waitForTimeout(200)
      const active = await tab.evaluate(() => document.activeElement?.id ?? '')
      if (active !== 'tokens') issues.push(`点目录里的「创建访问令牌」后焦点应在 #tokens,实际在 #${active}`)
      const top = await tab.evaluate(() => document.getElementById('tokens')?.getBoundingClientRect().top ?? -1)
      if (top < 0 || top > size.height * 0.6) issues.push(`点目录后标题应出现在屏幕上半部,实际 top=${Math.round(top)}`)

      issues.push(...(await overflowIssues(tab)))
      const coarse = await tab.evaluate(() => matchMedia('(pointer: coarse)').matches)
      if (coarse) {
        const small = await smallTargets(tab, '[data-testid=guide-pdf], [data-testid=guide-html], [data-testid=guide-toc] a, [data-testid=guide-toc] summary')
        issues.push(...small.map((item) => `触屏可点区域不足 44px:${item}`))
      }
      issues.push(...(await axeIssues(tab)))
      return issues
    },
  },

  'guide-entry-mine': {
    // 「我的」页(手机上进入其余入口的地方)里有「使用指南」,点了进指南
    route: '/mine',
    ready: '[data-testid=mine]',
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const row = tab.locator('[data-testid=mine-guide]')
      if (!(await row.isVisible())) return ['「我的」页上看不到「使用指南」']
      if (!(await row.innerText()).includes('使用指南')) issues.push('入口文字应是「使用指南」')
      await row.click()
      await tab.waitForURL('**/guide', { timeout: 8000 }).catch(() => issues.push(`点「使用指南」后应进 /guide,实际 ${new URL(tab.url()).pathname}`))
      if (new URL(tab.url()).pathname === '/guide' && !(await tab.locator('[data-testid=guide-article]').count())) await tab.waitForSelector('[data-testid=guide-article]', { timeout: 8000 }).catch(() => issues.push('进了 /guide 但没有正文'))
      return issues
    },
  },

  'guide-entry-menu': {
    // 头像菜单里有「使用指南」,键盘能走到,点了进指南
    route: '/home',
    ready: '[data-testid=account-trigger]',
    settle: 600,
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-testid=account-trigger]').first().click()
      const item = tab.locator('[data-testid=menu-guide]')
      await item.waitFor({ timeout: 5000 }).catch(() => issues.push('头像菜单里没有「使用指南」'))
      if (!(await item.count())) return issues
      if ((await item.getAttribute('role')) !== 'menuitem') issues.push('菜单项应有 role=menuitem')
      await item.click()
      await tab.waitForURL('**/guide', { timeout: 8000 }).catch(() => issues.push(`点「使用指南」后应进 /guide,实际 ${new URL(tab.url()).pathname}`))
      return issues
    },
  },

  'guide-ai-card': {
    // 使用指南顶部的「AI 接入指南」:在操作说明上方;下载链接真的能取到带本人 key 的文档;key 默认遮住;
    // 轮换要确认,确认后换成新 key、旧 key 不再出现;手机不溢出、触屏可点区域够大、无障碍无严重问题
    route: '/guide',
    ready: '[data-testid=ai-guide]',
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const card = await tab.locator('[data-testid=ai-guide]').boundingBox()
      const article = await tab.locator('[data-testid=guide-article]').boundingBox()
      if (!card || !article || card.y + card.height > article.y + 1) issues.push('接入指南卡片应在操作说明正文的上方')
      // 下载链接:带页面自己的 origin,返回的是 Markdown 附件,里面是本人的 key
      const link = await tab.evaluate(async () => {
        const a = document.querySelector('[data-testid=ai-guide-download]')
        const href = a?.getAttribute('href') ?? ''
        const response = href ? await fetch(href) : null
        return { href, download: a?.getAttribute('download') ?? '', status: response?.status ?? 0, type: response?.headers.get('content-type') ?? '', disposition: response?.headers.get('content-disposition') ?? '', body: response ? await response.text() : '' }
      })
      if (link.status !== 200) issues.push(`下载链接返回 ${link.status}`)
      if (!link.href.includes('base=') || !link.href.includes('download=1')) issues.push(`下载链接应带 base 和 download=1:${link.href}`)
      if (!/markdown/.test(link.type) || !/attachment/.test(link.disposition)) issues.push(`应是 Markdown 附件:${link.type} / ${link.disposition}`)
      if (link.download !== 'knowledgebase-ai-guide.md') issues.push(`保存文件名不对:${link.download}`)
      // key 默认遮住,显示后才看到全部
      const value = tab.locator('[data-testid=admin-key-value]')
      const masked = await value.innerText()
      if (!masked.startsWith('kb_ak_') || !masked.includes('•')) issues.push(`key 默认应遮住:${masked}`)
      if (!link.body.includes('kb_ak_')) issues.push('文档里应带 key')
      await tab.locator('[data-testid=admin-key-toggle]').click()
      const full = (await value.innerText()).trim()
      if (!link.body.includes(full)) issues.push('显示出来的 key 应和文档里的是同一把')
      // 轮换:先确认
      await tab.locator('[data-testid=admin-key-rotate]').click()
      const dialogText = await tab.locator('.kb-confirm').innerText().catch(() => '')
      if (!dialogText.includes('旧 key 立刻失效')) return [...issues, '轮换前应有确认,并写明旧 key 立刻失效(没有出现确认框)']
      const before = await tab.evaluate(() => fetch('/api/v1/__fixture/admin-key').then((r) => r.json()).then((b) => b.data.rotations))
      if (before !== 0) issues.push('没点确认就不该轮换')
      await tab.locator('.kb-confirm-btn.is-danger').click()
      await tab.waitForFunction((old) => document.querySelector('[data-testid=admin-key-value]')?.textContent?.trim() !== old, full, { timeout: 5000 }).catch(() => issues.push('确认后 key 应换成新的'))
      const fresh = (await value.innerText()).trim()
      if (fresh === full || !fresh.startsWith('kb_ak_')) issues.push(`轮换后应显示新 key:${fresh}`)
      const again = await tab.evaluate(() => fetch('/api/v1/me/ai-guide').then((r) => r.text()))
      if (again.includes(full) || !again.includes(fresh)) issues.push('轮换后下载的文档里应是新 key、不再有旧 key')
      issues.push(...(await overflowIssues(tab)))
      const coarse = await tab.evaluate(() => matchMedia('(pointer: coarse)').matches)
      if (coarse) {
        const small = await smallTargets(tab, '[data-testid=ai-guide-download], [data-testid=ai-guide-copy], [data-testid=admin-key-toggle], [data-testid=admin-key-copy], [data-testid=admin-key-rotate]')
        issues.push(...small.map((item) => `触屏可点区域不足 44px:${item}`))
      }
      issues.push(...(await axeIssues(tab)))
      return issues
    },
  },

  'guide-ai-card-failure': {
    // 读 key 失败:说原因、给重试,页面上没有任何 key,下载链接仍在
    route: '/guide',
    fixture: { __adminKeyFail: true },
    expectConsole: /status of 500/,
    ready: '[data-testid=admin-key-failure]',
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const text = await tab.locator('[data-testid=ai-guide]').innerText()
      if (!text.includes('账号服务暂时不可用')) issues.push('应说出失败原因')
      if (text.includes('kb_ak_')) issues.push('失败时不该出现任何 key')
      if (await tab.locator('[data-testid=admin-key-rotate]').count()) issues.push('读不到 key 时不该给「轮换」')
      if (!(await tab.locator('[data-testid=ai-guide-download]').count())) issues.push('下载链接不依赖读取 key,应一直在')
      return issues
    },
  },

  'guide-ai-off': {
    // AI 总开关关闭:整页(含标题、说明、目录、正文)没有「AI」字样,术语表的硬规定
    route: '/guide',
    fixture: { __me: AI_OFF_ME },
    ready: '[data-testid=guide-article]',
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const text = await tab.locator('[data-testid=guide]').innerText()
      const hit = text.match(/.{0,12}AI.{0,12}/)
      if (hit) issues.push(`AI 关闭后页面上不该出现「AI」字样:…${hit[0].replace(/\s+/g, ' ')}…`)
      if (text.includes('内置助手')) issues.push('AI 关闭后「内置助手」一节应整段隐藏')
      if (!text.includes('创建访问令牌')) issues.push('AI 关闭后其它内容应照常显示(没有整页变空)')
      if (!(await tab.locator('[data-testid=ai-guide]').innerText()).includes('接口接入指南')) issues.push('AI 关闭后接入指南卡片应还在,标题改叫「接口接入指南」')
      return issues
    },
  },
}
