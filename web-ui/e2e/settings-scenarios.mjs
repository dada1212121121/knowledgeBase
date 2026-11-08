// 系统设置页的页面场景:由 viewer-shots.mjs 引入,默认跑 core 五个尺寸 × 两个引擎(KB_ENGINE=webkit)。
// 假后端见 settings-fixture.mjs(带状态:改一个值 → 保存 → 重读看到新值;写操作记进日志,用 settingsLog 读出来断言)。
//
// 覆盖:每个分区在各尺寸下无溢出 / 卡片不塌 / 触屏可点区域 ≥44px;改值 → 保存 → 提示 → 持久;校验失败就近报错;
// 需要重启标记;保存失败重试;读取失败重试 / 没开通 / 加载骨架;AI 总开关关闭时分区隐藏且页面没有「AI」字样;
// 旧链接(tuning / about / tokens / appearance);各分区自己的关键交互(模型密钥、OCR 下载、编码代理确认、备份)。
import { ALL_FEATURES, adminMe } from './fixture.mjs'
import { settingsFixture, settingsLog } from './settings-fixture.mjs'
import { smallTargets } from './share-scenarios.mjs'

const lightTheme = () => localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'light' }))
const meWith = (blocked, ai = true) => ({ local: false, user: adminMe(ALL_FEATURES.filter((id) => !blocked.includes(id)), ai) })
const AI_FEATURES = ALL_FEATURES.filter((id) => id.startsWith('ai.') || id === 'search.deep')

/** 分区 → 点开后用来判断“已经画好”的选择器(一直在 DOM 里等到它出现)。 */
const SECTIONS = [
  ['常规', '[data-field="server.listen"]'],
  ['存储与索引', '[data-group=schedule]'],
  ['搜索与排序', '[data-testid=tune-card]'],
  ['模型', '[data-testid=llm-key-state]'],
  ['组件', '[data-testid=env-card]'],
  ['OCR 与转写', '[data-provider=rapidocr]'],
  ['Skills', '[data-testid=skills-list]'],
  ['MCP 接入', '[data-testid=mcp-snippet]'],
  ['编码代理', '[data-testid=acp-agents]'],
  ['备份', '[data-testid=backup-restore]'],
]
const NAV = SECTIONS.map(([label]) => label)
const readyOf = (label) => SECTIONS.find(([name]) => name === label)[1]

const navLabels = (tab) => tab.locator('.kb-settings-nav .ni').allInnerTexts().then((list) => list.map((item) => item.trim()))
async function goSection(tab, label) {
  await tab.locator('.kb-settings-nav .ni').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).click()
  await tab.waitForSelector(readyOf(label), { timeout: 10_000 })
  await tab.waitForTimeout(150)
}
const field = (tab, path) => tab.locator(`[data-field="${path}"]`)
const fill = (tab, path, value) => field(tab, path).locator('input, textarea').first().fill(value)
const text = (tab, selector) => tab.locator(selector).first().innerText().then((value) => value.replace(/\s+/g, ' ').trim())
const count = (tab, selector) => tab.locator(selector).count()
const waitToast = (tab, pattern) =>
  tab.waitForFunction((source) => [...document.querySelectorAll('.kb-toast-text')].some((el) => new RegExp(source).test(el.textContent)), pattern.source, { timeout: 8000 })

/** 确认框:等进场稳定 → 读标题 / 文案 / 是不是红色 → 点“确认”或“取消” → 等它收起。 */
async function confirmAsk(tab, yes = true) {
  await tab.waitForSelector('.kb-confirm', { timeout: 6000 })
  await tab.waitForTimeout(300)
  const title = await text(tab, '.kb-confirm-title')
  const message = await tab.locator('.kb-confirm-msg').innerText().catch(() => '')
  const danger = await tab.locator('.kb-confirm .kb-confirm-btn').nth(1).evaluate((el) => el.classList.contains('is-danger'))
  await tab.locator('.kb-confirm .kb-confirm-btn').nth(yes ? 1 : 0).click()
  await tab.waitForSelector('.kb-confirm-wrap', { state: 'detached', timeout: 8000 })
  return { title, message, danger }
}
async function pick(tab, path, label) {
  await field(tab, path).locator('button').first().click()
  await tab.locator('.kb-pop-layer[data-open="true"] .kb-pop-item').filter({ hasText: label }).first().click()
}
const save = (tab) => tab.locator('[data-testid=settings-save]').click()

/** 设置内容区的溢出:内容区本身不横向滚动;没有元素伸出内容区右边(祖先里有横向可滚动的容器——表格、代码块——不算)。 */
async function overflowIssues(tab) {
  return tab.evaluate(() => {
    const out = []
    const doc = document.documentElement
    if (doc.scrollWidth - innerWidth > 1) out.push(`页面横向滚动 ${doc.scrollWidth - innerWidth}px`)
    const body = document.querySelector('.kb-settings-body')
    if (!body) return [...out, '找不到设置内容区']
    if (body.scrollWidth - body.clientWidth > 1) out.push(`设置内容区横向滚动 ${body.scrollWidth - body.clientWidth}px`)
    const limit = body.getBoundingClientRect().right + 1
    for (const el of body.querySelectorAll('*')) {
      const box = el.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none' || style.position === 'fixed') continue
      if (box.right > limit) {
        let clipped = false
        for (let a = el.parentElement; a && a !== body; a = a.parentElement) {
          if (/(hidden|clip|auto|scroll)/.test(getComputedStyle(a).overflowX)) clipped = true
        }
        if (!clipped) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} 伸出内容区右边 ${Math.round(box.right - limit)}px`)
      }
    }
    return out.slice(0, 5)
  })
}

/** 卡片没有被压塌(WebKit 下 overflow:hidden 的卡放进可滚动纵向 flex 里会缩成 1px),内容也没被裁掉。 */
async function cardIssues(tab) {
  return tab.evaluate(() => {
    const out = []
    for (const card of document.querySelectorAll('.kb-settings-body .card')) {
      const box = card.getBoundingClientRect()
      const name = (card.querySelector('.ch')?.textContent ?? card.getAttribute('data-testid') ?? '').trim().slice(0, 12)
      if (box.height < 28) out.push(`卡片被压塌:${name} 高 ${Math.round(box.height)}`)
      else if (card.scrollHeight - card.clientHeight > 2 && getComputedStyle(card).overflowY !== 'visible') out.push(`卡片内容被裁:${name}`)
    }
    return out.slice(0, 4)
  })
}

const TARGETS = '.kb-settings-body button, .kb-settings-body [role=switch], .kb-settings-body summary, .kb-settings-body a.btn, .kb-settings-nav .ni'
const isCoarse = (tab) => tab.evaluate(() => matchMedia('(pointer: coarse)').matches)
/** 触屏上所有可点的东西 ≥44px(按输入方式判断,不按屏幕宽度)。 */
async function touchIssues(tab) {
  if (!(await isCoarse(tab))) return []
  return (await smallTargets(tab, TARGETS)).slice(0, 4).map((item) => `触屏可点区域不足 44px:${item}`)
}

/** 保存条在屏幕内,而且滚到最底时它不盖住最后一块内容。 */
async function barIssues(tab) {
  return tab.evaluate(async () => {
    const bar = document.querySelector('[data-testid=settings-save-bar]')
    if (!bar) return ['保存条没出现']
    const body = document.querySelector('.kb-settings-body')
    body.scrollTop = body.scrollHeight
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const out = []
    const box = bar.getBoundingClientRect()
    if (box.left < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1 || box.top < 0) out.push(`保存条不在屏幕内:${Math.round(box.left)},${Math.round(box.top)} → ${Math.round(box.right)},${Math.round(box.bottom)}`)
    const last = [...document.querySelectorAll('.kb-st > *')].filter((el) => el.getBoundingClientRect().height > 0).pop()
    if (last && last.getBoundingClientRect().bottom > box.top + 1) out.push(`保存条盖住了最后一块内容(内容底 ${Math.round(last.getBoundingClientRect().bottom)} > 条顶 ${Math.round(box.top)})`)
    return out
  })
}

const sectionIssues = async (tab, label) => [...(await overflowIssues(tab)), ...(await cardIssues(tab)), ...(await touchIssues(tab))].map((issue) => `${label}:${issue}`)

export const SETTINGS_SCENARIOS = {
  'settings-sections': {
    // 十个分区逐个点开:导航顺序对、地址的 ?tab= 跟着变、每个分区无溢出 / 卡片不塌 / 触屏可点区域够大
    route: '/admin/settings',
    ready: '[data-field="server.listen"]',
    fixture: settingsFixture(),
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const labels = await navLabels(tab)
      if (labels.join('|') !== NAV.join('|')) issues.push(`导航应是「${NAV.join(' / ')}」,实际「${labels.join(' / ')}」`)
      for (const [label] of SECTIONS) {
        await goSection(tab, label)
        issues.push(...(await sectionIssues(tab, label)))
      }
      if (!tab.url().includes('tab=backup')) issues.push(`地址里的页签应跟着分区变,实际 ${tab.url()}`)
      return issues
    },
  },

  'settings-edit-save': {
    // 改一个值 → 保存条出现并数对 → 保存 → 提示条 → 条消失;补丁只含改过的键(不带整段,不盖掉别处写入的 collection_weights);刷新后还在
    route: '/admin/settings?tab=search',
    ready: '[data-field="search.k"]',
    fixture: settingsFixture(),
    settle: 400,
    assert: async (tab) => {
      const issues = []
      if (await count(tab, '[data-testid=settings-save-bar]')) issues.push('没改动时不该有保存条')
      if (await count(tab, '[data-field="search.k"] [data-testid=setting-restart]')) issues.push('立即生效的项不该有「需要重启」')
      const hint = await text(tab, '[data-field="search.k"] .kb-st-hint')
      if (!hint.includes('取值 1–100 条') || !hint.includes('默认 8 条') || !hint.includes('search.k')) issues.push(`帮助文字应写明范围 / 默认值 / 配置键,实际「${hint}」`)
      await fill(tab, 'search.k', '12')
      await tab.waitForSelector('[data-testid=settings-save-bar]')
      const bar = await text(tab, '[data-testid=settings-save-count]')
      if (bar !== '有 1 项修改未保存') issues.push(`保存条应写「有 1 项修改未保存」,实际「${bar}」`)
      issues.push(...(await barIssues(tab)))
      await save(tab)
      await waitToast(tab, /已保存 1 项,立即生效/)
      await tab.waitForSelector('[data-testid=settings-save-bar]', { state: 'detached' })
      const data = await settingsLog(tab)
      const patch = JSON.stringify(data.log.find((entry) => entry.name === 'update_config')?.patch)
      if (patch !== '{"search":{"k":12}}') issues.push(`补丁应只含改过的键 {"search":{"k":12}},实际 ${patch}`)
      if (data.config.search.collection_weights?.proj_sampleapp !== 1.1) issues.push('别处写入的 collection_weights 被盖掉了')
      await tab.reload({ waitUntil: 'networkidle' })
      await tab.waitForSelector('[data-field="search.k"]')
      if ((await field(tab, 'search.k').locator('input').inputValue()) !== '12') issues.push('刷新后值应是 12(已持久)')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'settings-restart': {
    // 需要重启的项带标记;保存后提示点名「要重启服务后才生效」(警告色)
    route: '/admin/settings',
    ready: '[data-field="server.listen"]',
    fixture: settingsFixture(),
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const badge = await text(tab, '[data-field="server.listen"] [data-testid=setting-restart]')
      if (badge !== '需要重启') issues.push(`监听地址应标「需要重启」,实际「${badge}」`)
      // 标记不能把标签挤成两行:标签文字自己只占一行
      const oneLine = await tab.evaluate(() => {
        const label = document.querySelector('[data-field="server.allow_remote"] .kb-st-label')
        const range = document.createRange()
        range.selectNodeContents(label.firstElementChild)
        return range.getClientRects().length === 1
      })
      if (!oneLine) issues.push('「允许远程访问」标签被挤成了多行')
      await fill(tab, 'server.listen', '127.0.0.1:9000')
      await save(tab)
      await waitToast(tab, /「监听地址」要重启服务后才生效/)
      const tone = await tab.locator('.kb-toast').first().evaluate((el) => el.className)
      if (!tone.includes('is-warning')) issues.push(`要重启的提示应是警告色,实际 ${tone}`)
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'settings-validate': {
    // 校验失败就近报错(带标签和范围)、保存置灰、不发请求;改回合法值恢复;监听地址与「允许远程访问」联动
    route: '/admin/settings?tab=backup',
    ready: '[data-field="backup.interval_hours"]',
    fixture: settingsFixture(),
    settle: 500,
    assert: async (tab) => {
      const issues = []
      await fill(tab, 'backup.interval_hours', '0')
      const error = await text(tab, '[data-field="backup.interval_hours"] [data-testid=setting-error]')
      if (!error.includes('「备份间隔」不能小于 1')) issues.push(`应就近报错「备份间隔」不能小于 1,实际「${error}」`)
      if (!(await tab.locator('[data-testid=settings-save]').isDisabled())) issues.push('有校验错误时「保存」应置灰')
      if (!(await text(tab, '[data-testid=settings-save-invalid]')).includes('不能小于 1')) issues.push('保存条应说明哪里不对')
      issues.push(...(await barIssues(tab)))
      await fill(tab, 'backup.mirror_dirs', '/mnt/../etc')
      if (!(await text(tab, '[data-field="backup.mirror_dirs"] [data-testid=setting-error]')).includes('不能用「..」')) issues.push('异地目录含 .. 应报错')
      await fill(tab, 'backup.mirror_dirs', '/mnt/usb/kb-backups\n/mnt/nas/kb-offsite')
      await fill(tab, 'backup.interval_hours', '12')
      if (await count(tab, '[data-testid=setting-error]')) issues.push('改回合法值后报错应消失')
      if (await tab.locator('[data-testid=settings-save]').isDisabled()) issues.push('合法后「保存」应可点')
      if ((await settingsLog(tab)).log.some((entry) => entry.name === 'update_config')) issues.push('校验没过时不该发出保存请求')
      await tab.locator('[data-testid=settings-revert]').click()
      await goSection(tab, '常规')
      await fill(tab, 'server.listen', '0.0.0.0:7878')
      if (!(await text(tab, '[data-field="server.listen"] [data-testid=setting-error]')).includes('允许远程访问')) issues.push('非本机地址应提示需要「允许远程访问」')
      await field(tab, 'server.allow_remote').locator('[role=switch]').click()
      if (await count(tab, '[data-field="server.listen"] [data-testid=setting-error]')) issues.push('打开「允许远程访问」后监听地址的报错应消失')
      if (!(await text(tab, '[data-field="server.allow_remote"] [data-testid=setting-risk]')).includes('对外暴露')) issues.push('打开远程访问应在行内写明风险')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'settings-save-fail': {
    // 保存失败:原因常驻在保存条上(不自动消失),按钮变「重试」,输入还在;重试成功后清掉
    route: '/admin/settings?tab=search',
    ready: '[data-field="search.k"]',
    fixture: settingsFixture({ updateFail: { times: 1, status: 400, message: '配置补丁不合法: search.k 超出范围' } }),
    expectConsole: /400|Failed to load resource/,
    settle: 400,
    assert: async (tab) => {
      const issues = []
      await fill(tab, 'search.k', '12')
      await save(tab)
      await tab.waitForSelector('[data-testid=settings-save-failure]')
      const failure = await text(tab, '[data-testid=settings-save-failure]')
      if (!failure.includes('保存设置失败:配置补丁不合法: search.k 超出范围。请检查填写的值后重试。')) issues.push(`保存失败应说原因 + 怎么办,实际「${failure}」`)
      const label = await text(tab, '[data-testid=settings-save]')
      if (label !== '重试') issues.push(`按钮应变成「重试」,实际「${label}」`)
      if ((await field(tab, 'search.k').locator('input').inputValue()) !== '12') issues.push('失败后输入的值应保留')
      issues.push(...(await barIssues(tab)))
      await tab.waitForTimeout(1500)
      if (!(await count(tab, '[data-testid=settings-save-failure]'))) issues.push('失败原因不该自动消失')
      await save(tab)
      await tab.waitForSelector('[data-testid=settings-save-bar]', { state: 'detached' })
      if ((await settingsLog(tab)).config.search.k !== 12) issues.push('重试成功后配置里应是 12')
      return issues
    },
  },

  'settings-error': {
    // 读取配置失败:整块报错 + 重试,点了恢复(不是一个红徽标)
    route: '/admin/settings',
    ready: '[data-testid=admin-error]',
    fixture: settingsFixture({ configFail: { times: 1, status: 500, message: '配置文件格式不对' } }),
    expectConsole: /500|Failed to load resource/,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const message = await text(tab, '[data-testid=admin-error]')
      if (!message.includes('读取系统设置失败:配置文件格式不对') || !message.includes('重试')) issues.push(`报错应说清原因并给「重试」,实际「${message}」`)
      if (await count(tab, '[data-testid=setting-rows]')) issues.push('报错时不该画表单')
      issues.push(...(await overflowIssues(tab)))
      await tab.locator('[data-testid=admin-error] button').click()
      await tab.waitForSelector('[data-field="server.listen"]')
      if (await count(tab, '[data-testid=admin-error]')) issues.push('重试成功后报错应消失')
      return issues
    },
  },

  'settings-forbidden': {
    // 没有开通系统设置(403):整页只说“你的账号没有开通这个功能”,不画导航,不给重试
    route: '/admin/settings',
    ready: '[data-testid=admin-forbidden]',
    fixture: settingsFixture({ configFail: { status: 403, message: 'forbidden' } }),
    expectConsole: /403|Failed to load resource/,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const message = await text(tab, '[data-testid=admin-forbidden]')
      if (!message.includes('你的账号没有开通这个功能')) issues.push(`应写「你的账号没有开通这个功能」,实际「${message}」`)
      if (await count(tab, '.kb-settings-nav')) issues.push('没权限时不该画分区导航')
      if (await count(tab, '[data-testid=admin-forbidden] button')) issues.push('没权限时不给「重试」(重试也不会变)')
      const doc = await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth)
      if (doc > 1) issues.push(`页面横向滚动 ${doc}px`)
      return issues
    },
  },

  'settings-loading': {
    // 加载中:骨架屏(不是“加载中…”文字),没有表单、没有保存条;读完换成内容
    route: '/admin/settings',
    ready: '[data-field="server.listen"]',
    fixture: settingsFixture({ configDelay: 1500 }),
    settle: 100,
    assert: async (tab) => {
      const issues = []
      // 页面已经读完一次了;重新载入,只等到响应提交就去看(配置要 1.5 秒才回来)
      await tab.reload({ waitUntil: 'commit' })
      await tab.waitForSelector('[data-testid=admin-loading]', { timeout: 8000 })
      if (await count(tab, '[data-testid=setting-rows]')) issues.push('加载中不该有表单')
      if (await count(tab, '[data-testid=settings-save-bar]')) issues.push('加载中不该有保存条')
      if (!(await tab.locator('[data-testid=admin-loading]').isVisible())) issues.push('加载中应显示骨架屏')
      if ((await text(tab, '[data-testid=admin-loading]')).includes('加载中…')) issues.push('不该用“加载中…”文字')
      await tab.waitForSelector('[data-field="server.listen"]', { timeout: 10_000 })
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'settings-ai-off': {
    // AI 总开关关闭:模型和编码代理整个分区不在导航里,其余分区逐个点开,设置区、顶栏、整页任何位置都没有「AI」字样
    route: '/admin/settings',
    ready: '[data-field="server.listen"]',
    fixture: settingsFixture({ me: meWith(AI_FEATURES, false) }),
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const labels = await navLabels(tab)
      const expected = NAV.filter((label) => label !== '模型' && label !== '编码代理')
      if (labels.join('|') !== expected.join('|')) issues.push(`AI 关闭后导航应是「${expected.join(' / ')}」,实际「${labels.join(' / ')}」`)
      for (const label of expected) {
        await goSection(tab, label)
        const body = await tab.evaluate(() => document.querySelector('.kb-settings').innerText + document.querySelector('#kb-slot-bc')?.innerText)
        const hit = body.match(/[\s\S]{0,10}AI[\s\S]{0,10}/)?.[0]
        if (hit) issues.push(`${label}:AI 关闭后设置页不该出现「AI」,出现在「${hit.replace(/\s+/g, ' ')}」`)
        issues.push(...(await sectionIssues(tab, label)))
      }
      const page = await tab.evaluate(() => document.body.innerText)
      const leak = page.match(/[\s\S]{0,10}AI[\s\S]{0,10}/)?.[0]
      if (leak) issues.push(`整页任何位置都不该出现「AI」,出现在「${leak.replace(/\s+/g, ' ')}」`)
      return issues
    },
  },

  'settings-ai-off-link': {
    // AI 关闭时直接打开旧的「模型」链接:回到常规并纠正地址,不暴露这个分区
    route: '/admin/settings?tab=model',
    ready: '[data-field="server.listen"]',
    fixture: settingsFixture({ me: meWith(AI_FEATURES, false) }),
    settle: 500,
    assert: async (tab) => {
      const issues = []
      if (await count(tab, '[data-field="llm.provider"]')) issues.push('AI 关闭后不该看到模型的设置')
      if (!tab.url().includes('tab=general')) issues.push(`地址应纠正成 tab=general,实际 ${tab.url()}`)
      if ((await navLabels(tab)).includes('模型')) issues.push('导航里不该有「模型」')
      return issues
    },
  },

  'settings-no-ops': {
    // 没有「系统运维」功能点:没有备份分区(直接打开链接回到常规);其余照常
    route: '/admin/settings?tab=backup',
    ready: '[data-field="server.listen"]',
    fixture: settingsFixture({ me: meWith(['sys.ops']) }),
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const labels = await navLabels(tab)
      if (labels.includes('备份')) issues.push('没有 sys.ops 不该看到「备份」')
      if (labels.length !== NAV.length - 1) issues.push(`其余分区应都在(${NAV.length - 1} 个),实际 ${labels.length}`)
      if (!tab.url().includes('tab=general')) issues.push(`地址应纠正成 tab=general,实际 ${tab.url()}`)
      await goSection(tab, 'MCP 接入')
      if (await count(tab, '[data-testid=mcp-sessions]')) issues.push('没有 sys.ops 不显示在线客户端数')
      return issues
    },
  },

  'settings-links': {
    // 旧链接继续有效:tuning → 搜索与排序,about → 常规,tokens → 个人设置,appearance → 外观页,认不出的 → 常规
    route: '/admin/settings?tab=tuning',
    ready: '[data-testid=tune-card]',
    fixture: settingsFixture(),
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const base = new URL(tab.url()).origin
      if (!tab.url().includes('tab=search')) issues.push(`tuning 应纠正成 tab=search,实际 ${tab.url()}`)
      for (const [from, check, want] of [
        ['about', '[data-testid=about-card]', 'tab=general'],
        ['bogus', '[data-field="server.listen"]', 'tab=general'],
      ]) {
        await tab.goto(`${base}/admin/settings?tab=${from}`, { waitUntil: 'networkidle' })
        await tab.waitForSelector(check, { timeout: 8000 })
        if (!tab.url().includes(want)) issues.push(`?tab=${from} 应纠正成 ${want},实际 ${tab.url()}`)
      }
      await tab.goto(`${base}/admin/settings?tab=tokens`, { waitUntil: 'networkidle' })
      await tab.waitForFunction(() => location.pathname === '/me', null, { timeout: 8000 })
      await tab.goto(`${base}/admin/settings?tab=appearance`, { waitUntil: 'networkidle' })
      await tab.waitForFunction(() => location.pathname === '/me/appearance', null, { timeout: 8000 })
      return issues
    },
  },

  'settings-model': {
    // 模型:服务商下拉 + 换服务商时地址跟着换 + 保存(以前 llm 永远不落盘)+ 密钥(保存 / 清除要确认)+ 连接测试 + 费用保护风险
    route: '/admin/settings?tab=model',
    ready: '[data-testid=llm-key-state]',
    fixture: settingsFixture(),
    settle: 500,
    assert: async (tab) => {
      const issues = []
      issues.push(...(await sectionIssues(tab, '模型')))
      await pick(tab, 'llm.provider', 'OpenAI')
      const url = await field(tab, 'llm.base_url').locator('input').inputValue()
      if (url !== 'https://api.openai.com/v1') issues.push(`换服务商后接口地址应跟着换,实际「${url}」`)
      if ((await text(tab, '[data-testid=settings-save-count]')) !== '有 2 项修改未保存') issues.push('换服务商应算 2 项改动(服务商 + 地址)')
      if (!(await count(tab, '[data-testid=llm-test-unsaved]'))) issues.push('有没保存的模型改动时,应提醒测试用的是已保存的设置')
      await save(tab)
      await waitToast(tab, /已保存 2 项,立即生效/)
      const saved = (await settingsLog(tab)).log.find((entry) => entry.name === 'update_config')?.patch
      if (JSON.stringify(saved) !== '{"llm":{"provider":"openai","base_url":"https://api.openai.com/v1"}}') issues.push(`模型设置应真的落盘:{"llm":{…}},实际 ${JSON.stringify(saved)}`)
      // 密钥
      if (!(await tab.locator('[data-testid=llm-key-save]').isDisabled())) issues.push('输入框为空时「保存密钥」应置灰')
      await tab.locator('[data-testid=llm-key-input]').fill('sk-test')
      await tab.locator('[data-testid=llm-key-save]').click()
      await waitToast(tab, /密钥已保存/)
      if ((await tab.locator('[data-testid=llm-key-input]').inputValue()) !== '') issues.push('保存后输入框应清空')
      await tab.locator('[data-testid=llm-key-clear]').click()
      const ask = await confirmAsk(tab, true)
      if (ask.title !== '清除已保存的密钥?' || !ask.danger) issues.push(`清除密钥应有红色确认,实际「${ask.title}」danger=${ask.danger}`)
      await tab.waitForFunction(() => document.querySelector('[data-testid=llm-key-state]')?.textContent?.includes('还没有保存密钥'))
      const keyLog = (await settingsLog(tab)).log.filter((entry) => entry.name === 'set_llm_key').map((entry) => entry.cleared)
      if (JSON.stringify(keyLog) !== '[false,true]') issues.push(`密钥应先保存再清除,实际 ${JSON.stringify(keyLog)}`)
      // 连接测试
      await tab.locator('[data-testid=llm-test]').click()
      await tab.waitForSelector('[data-testid=llm-test-result]')
      if (!(await text(tab, '[data-testid=llm-test-result]')).startsWith('连接成功,模型回复:')) issues.push('连接测试成功应带上模型的回复')
      // 费用保护
      await fill(tab, 'llm.max_calls_per_hour', '0')
      if (!(await text(tab, '[data-field="llm.max_calls_per_hour"] [data-testid=setting-risk]')).includes('费用')) issues.push('次数填 0(不限)应写明会产生持续费用')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'settings-model-errors': {
    // 模型的失败:服务商目录读不到(卡片里报错 + 重试,上面字段照样能改)
    route: '/admin/settings?tab=model',
    ready: '[data-testid=llm-catalog-error]',
    fixture: settingsFixture({ catalogFail: { status: 500, message: '目录文件损坏' } }),
    expectConsole: /500|Failed to load resource/,
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const error = await text(tab, '[data-testid=llm-catalog-error]')
      if (!error.includes('读取服务商信息失败:目录文件损坏') || !error.includes('重试')) issues.push(`目录读取失败应说清并给重试,实际「${error}」`)
      if (!(await count(tab, '[data-field="llm.provider"] input'))) issues.push('目录读不到时服务商应退回文本框')
      await fill(tab, 'llm.extract_model', 'deepseek-chat')
      if (!(await count(tab, '[data-testid=settings-save-bar]'))) issues.push('目录读不到时字段照样能改')
      issues.push(...(await overflowIssues(tab)), ...(await cardIssues(tab)))
      return issues
    },
  },

  'settings-model-test-fail': {
    // 连接测试失败:原因 + 怎么办常驻在卡片里,role=alert
    route: '/admin/settings?tab=model',
    ready: '[data-testid=llm-key-state]',
    fixture: settingsFixture({ testFail: { status: 400, message: '当前服务商没有 API key:先保存密钥,或设置对应的环境变量' } }),
    expectConsole: /400|Failed to load resource/,
    settle: 400,
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-testid=llm-test]').click()
      await tab.waitForSelector('[data-testid=llm-test-result]')
      const result = await text(tab, '[data-testid=llm-test-result]')
      if (!result.includes('测试连接失败:当前服务商没有 API key') || !result.includes('请检查密钥、接口地址和模型名后重试')) issues.push(`失败应说原因 + 怎么办,实际「${result}」`)
      if ((await tab.locator('[data-testid=llm-test-result]').getAttribute('role')) !== 'alert') issues.push('失败结果应是 role=alert')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'settings-ocr': {
    // OCR 与转写:开关带需要重启标记;引擎上只有后端真能做的操作;下载 → 进度自动刷新 → 完成后“可用”;设为默认提示要重启
    route: '/admin/settings?tab=ocr',
    ready: '[data-provider=rapidocr]',
    fixture: settingsFixture(),
    settle: 500,
    assert: async (tab) => {
      const issues = []
      issues.push(...(await sectionIssues(tab, 'OCR 与转写')))
      const buttons = async (id) => (await tab.locator(`[data-provider="${id}"] button`).allInnerTexts()).map((item) => item.trim()).join('|')
      const rapid = await buttons('rapidocr')
      const tess = await buttons('tesseract')
      const whisper = await buttons('whisper-cli')
      if (rapid !== '设为默认|卸载') issues.push(`rapidocr 的操作应是「设为默认|卸载」,实际「${rapid}」`)
      if (tess !== '下载|设为默认') issues.push(`tesseract 的操作应是「下载|设为默认」,实际「${tess}」`)
      if (whisper !== '下载') issues.push(`转写引擎只有「下载」(后端不支持一键设默认),实际「${whisper}」`)
      if (await count(tab, '[data-testid=install-card]')) issues.push('没下载过就不显示下载进度卡')
      for (const path of ['extract.ocr_enabled', 'extract.transcribe_enabled', 'extract.max_media_seconds']) {
        if (!(await count(tab, `[data-field="${path}"] [data-testid=setting-restart]`))) issues.push(`${path} 应标「需要重启」`)
      }
      // 下载 tesseract:进度自动刷新,完成后目录里变“可用”
      await tab.locator('[data-provider="tesseract"] [data-testid=provider-install]').click()
      await tab.waitForSelector('[data-testid=install-card]')
      await tab.waitForFunction(() => document.querySelector('[data-testid=install-state]')?.textContent?.includes('已完成'), null, { timeout: 15_000 })
      await tab.waitForFunction(() => document.querySelector('[data-provider="tesseract"]')?.textContent?.includes('可用'), null, { timeout: 8000 })
      if (await tab.locator('[data-provider="tesseract"] [data-testid=provider-default]').isDisabled()) issues.push('下载完成后「设为默认」应可点')
      await tab.locator('[data-provider="tesseract"] [data-testid=provider-default]').click()
      await waitToast(tab, /要重启服务后才生效/)
      // 卸载要确认
      await tab.locator('[data-provider="rapidocr"] [data-testid=provider-uninstall]').click()
      const ask = await confirmAsk(tab, false)
      if (!ask.danger || !ask.message.includes('不动系统里装的运行时')) issues.push(`卸载应有红色确认并说清不动运行时,实际「${ask.message}」`)
      if ((await settingsLog(tab)).log.some((entry) => entry.name === 'provider_uninstall')) issues.push('取消确认后不该卸载')
      // 改开关 → 保存 → 提示要重启
      await field(tab, 'extract.transcribe_enabled').locator('[role=switch]').click()
      await save(tab)
      await waitToast(tab, /「转写音频和视频」要重启服务后才生效/)
      issues.push(...(await overflowIssues(tab)), ...(await cardIssues(tab)))
      return issues
    },
  },

  'settings-components': {
    // 组件:环境检测 + 嵌入(只读参数和引擎列表在同一张卡)+ 重排;只读项没有任何操作按钮
    route: '/admin/settings?tab=components',
    ready: '[data-testid=env-card]',
    fixture: settingsFixture(),
    settle: 500,
    assert: async (tab) => {
      const issues = []
      issues.push(...(await sectionIssues(tab, '组件')))
      if ((await count(tab, '[data-group="embed"]')) !== 1) issues.push('嵌入应只有一张卡(以前是两张同名的)')
      if (await count(tab, '[data-group="embed"] [data-field="embed.model"] input')) issues.push('嵌入参数应只读')
      if (await count(tab, '[data-group="embed"] [data-provider] button, [data-group="rerank"] [data-provider] button')) issues.push('嵌入 / 重排不该有操作按钮(后端不支持)')
      if ((await text(tab, '[data-testid=env-card]')).includes('—')) issues.push('环境检测应读到数据,不该全是「—」')
      return issues
    },
  },

  'settings-components-error': {
    route: '/admin/settings?tab=components',
    ready: '[data-testid=admin-error]',
    fixture: settingsFixture({ providersFail: { status: 500, message: '组件目录读不了' } }),
    expectConsole: /500|Failed to load resource/,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const message = await text(tab, '[data-testid=admin-error]')
      if (!message.includes('读取组件信息失败:组件目录读不了') || !message.includes('重试')) issues.push(`应报错并给重试,实际「${message}」`)
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'settings-acp': {
    // 编码代理:权限 / 沙箱 / 默认后端立即生效且改前确认;代理表手机变卡片、操作按状态给;配置对话框在屏内;添加表单就近校验
    route: '/admin/settings?tab=acp',
    ready: '[data-testid=acp-agents]',
    fixture: settingsFixture(),
    settle: 600,
    assert: async (tab, size) => {
      const issues = []
      issues.push(...(await sectionIssues(tab, '编码代理')))
      const phone = size.width < 600
      const cards = await count(tab, '[data-testid=acp-agents] [data-testid=rt-card]')
      const rows = await count(tab, '[data-testid=acp-agents] [data-testid=rt-row]')
      if (phone && (cards !== 4 || rows !== 0)) issues.push(`手机上应是 4 张代理卡,实际卡 ${cards} 行 ${rows}`)
      if (!phone && (rows !== 4 || cards !== 0)) issues.push(`平板 / 电脑上应是 4 行表格,实际行 ${rows} 卡 ${cards}`)
      const actions = async (name) => (await tab.locator('[data-testid=acp-agents] [data-testid=acp-actions]').filter({ has: tab.locator(`[aria-label="配置 ${name}"]`) }).locator('button').allInnerTexts()).map((item) => item.trim()).join('|')
      if ((await actions('Claude Code')) !== '测试|配置|卸载') issues.push(`Claude Code 的操作应是「测试|配置|卸载」,实际「${await actions('Claude Code')}」`)
      if ((await actions('Codex')) !== '安装|配置') issues.push(`Codex 的操作应是「安装|配置」,实际「${await actions('Codex')}」`)
      // 权限:取消不变;确认后生效
      await pick(tab, 'acp.permission', '全部自动放行')
      let ask = await confirmAsk(tab, false)
      if (ask.title !== '全部自动放行?' || !ask.danger || !ask.message.includes('写文件')) issues.push(`全部放行应是红色确认并说清能做什么,实际「${ask.title}」「${ask.message}」`)
      if (/\b(none|all)\b/.test(ask.message)) issues.push('确认文案里不该出现 none / all')
      if ((await settingsLog(tab)).permission !== 'read') issues.push('取消确认后权限不该变')
      await pick(tab, 'acp.permission', '全部自动放行')
      await confirmAsk(tab, true)
      await tab.waitForFunction(() => document.querySelector('[data-field="acp.permission"] button')?.textContent?.includes('全部自动放行'))
      if ((await settingsLog(tab)).permission !== 'all') issues.push('确认后权限应变成 all')
      // 沙箱
      await field(tab, 'acp.sandbox').locator('[role=switch]').click()
      ask = await confirmAsk(tab, true)
      if (ask.title !== '关闭沙箱?' || !ask.danger) issues.push(`关沙箱应是红色确认,实际「${ask.title}」`)
      await tab.waitForSelector('[data-testid=acp-sandbox-risk]')
      // 默认后端
      await pick(tab, 'acp.default', 'Claude Code')
      await tab.waitForSelector('[data-testid=acp-default-badge]')
      // 配置对话框:在屏内、密钥遮住、取消关闭
      await tab.locator('[aria-label="配置 Claude Code"]').click()
      await tab.waitForSelector('[data-testid=acp-config-dialog]')
      await tab.waitForFunction(() => {
        const top = document.querySelector('.kb-dialog')?.getBoundingClientRect().top
        const last = window.__dlgTop
        window.__dlgTop = top
        return top !== undefined && top === last
      }, null, { polling: 120 })
      const box = await tab.locator('.kb-dialog').boundingBox()
      if (!box || box.x < -1 || box.y < -1 || box.x + box.width > size.width + 1 || box.y + box.height > size.height + 1) issues.push(`配置对话框应完整在屏幕内,实际 ${JSON.stringify(box)}`)
      if ((await count(tab, '[data-testid=acp-config-dialog] input[type=password]')) < 1) issues.push('密钥变量的输入框应遮住')
      if (await isCoarse(tab)) for (const item of await smallTargets(tab, '[data-testid=acp-config-dialog] button')) issues.push(`对话框里触屏可点区域不足 44px:${item}`)
      await tab.locator('[data-testid=acp-config-dialog] button', { hasText: '取消' }).click()
      await tab.waitForSelector('[data-testid=acp-config-dialog]', { state: 'detached' })
      // 添加表单
      await tab.locator('[data-testid=acp-form-submit]').click()
      const addText = await text(tab, '[data-testid=acp-add]')
      if (!addText.includes('请填一个标识') || !addText.includes('请填启动命令')) issues.push('没填就提交应就近报错')
      await tab.locator('[data-testid=acp-form-id]').fill('tool')
      await tab.locator('[data-testid=acp-form-command]').fill('bash')
      if (!(await text(tab, '[data-testid=acp-add]')).includes('不能直接用 sh / bash / env')) issues.push('命令是解释器应报错')
      await tab.locator('[data-testid=acp-form-command]').fill('/opt/tool')
      await tab.locator('[data-testid=acp-form-submit]').click()
      ask = await confirmAsk(tab, true)
      if (!ask.message.includes('沙箱已关闭')) issues.push(`沙箱关着时,添加确认应点明同权,实际「${ask.message}」`)
      await tab.waitForFunction(() => [...document.querySelectorAll('[data-testid=acp-agents] [data-testid=rt-row], [data-testid=acp-agents] [data-testid=rt-card]')].some((el) => el.textContent.includes('tool')))
      issues.push(...(await overflowIssues(tab)), ...(await cardIssues(tab)))
      return issues
    },
  },

  'settings-acp-error': {
    route: '/admin/settings?tab=acp',
    ready: '[data-testid=admin-error]',
    fixture: settingsFixture({ acpFail: { status: 500, message: 'acp.toml 读不了' } }),
    expectConsole: /500|Failed to load resource/,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      if (!(await text(tab, '[data-testid=admin-error]')).includes('读取编码代理失败:acp.toml 读不了')) issues.push('应报错并给重试')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'settings-backup': {
    // 备份:状态卡 / 策略只说一遍 / 立即备份 → 新增一行 / 校验结果留在行里 / 删除与清理要确认 / 改策略保存后“当前生效”跟上 / 异地副本 / 恢复步骤默认折起
    route: '/admin/settings?tab=backup',
    ready: '[data-testid=backup-restore]',
    fixture: settingsFixture(),
    settle: 600,
    assert: async (tab, size) => {
      const issues = []
      issues.push(...(await sectionIssues(tab, '备份')))
      const body = await text(tab, '.kb-settings-body')
      if ((body.match(/每 24 小时备份一次/g) ?? []).length !== 1) issues.push('定时备份的说明应只出现一次')
      // 「同时备份原件」的开关和它的说明是一对(设计稿):手机上「立即备份」后面放不下时一起换行,
      // 不能是开关留在按钮旁边、说明掉到下一行 —— 看上去像一个没名字的开关
      const pair = await tab.evaluate(() => {
        const sw = document.querySelector('[data-testid=backup-include-sources]')
        const hint = sw?.parentElement?.querySelector('.kb-st-key-hint')
        if (!sw || !hint) return null
        const a = sw.getBoundingClientRect()
        const b = hint.getBoundingClientRect()
        return { swMid: Math.round(a.top + a.height / 2), hintTop: Math.round(b.top), hintBottom: Math.round(b.bottom), gap: Math.round(b.left - a.right) }
      })
      if (!pair) issues.push('没找到「同时备份原件」的开关和说明')
      else if (pair.swMid < pair.hintTop - 2 || pair.swMid > pair.hintBottom + 2) issues.push(`开关应和它的说明在同一行(开关中心 ${pair.swMid} 不在说明 ${pair.hintTop}~${pair.hintBottom} 内)`)
      if (await tab.locator('[data-testid=backup-restore] details').evaluate((el) => el.open)) issues.push('恢复步骤应默认折起')
      if ((await count(tab, '[data-testid=backup-mirrors] li')) !== 2) issues.push('应列出 2 个异地目录的现状')
      const phone = size.width < 600
      const kind = phone ? 'rt-card' : 'rt-row'
      const entries = (n) => tab.waitForFunction(([want, name]) => document.querySelectorAll(`[data-testid=backup-entries] [data-testid=${name}]`).length === want, [n, kind])
      if ((await count(tab, `[data-testid=backup-entries] [data-testid=${kind}]`)) !== 3) issues.push('应有 3 份备份')
      // 展开恢复步骤
      await tab.locator('[data-testid=backup-restore] summary').click()
      if ((await count(tab, '[data-testid=backup-restore] li')) !== 6) issues.push('展开后应有 6 个步骤')
      issues.push(...(await overflowIssues(tab)))
      await tab.locator('[data-testid=backup-restore] summary').click()
      // 立即备份
      await tab.locator('[data-testid=backup-create]').click()
      await waitToast(tab, /备份完成:kb-/)
      await entries(4)
      // 校验:结果留在那一行
      await tab.locator('[data-testid=backup-verify]').first().click()
      await tab.waitForSelector('[data-testid=backup-check]')
      if (!(await text(tab, '[data-testid=backup-check]')).startsWith('校验通过')) issues.push('校验通过应留在那一行里')
      // 删除要确认(红色,提异地副本)
      await tab.locator('[data-testid=backup-delete]').last().click()
      let ask = await confirmAsk(tab, true)
      if (!ask.danger || !ask.message.includes('异地副本')) issues.push(`删除应红色确认并提异地副本,实际「${ask.message}」`)
      await entries(3)
      // 改策略 → 提醒未保存 → 保存 → 当前生效跟上
      await fill(tab, 'backup.keep_count', '3')
      if (!(await count(tab, '[data-testid=backup-policy-unsaved]'))) issues.push('策略改了没保存应提醒“清理用的是已保存的策略”')
      issues.push(...(await barIssues(tab)))
      await save(tab)
      await waitToast(tab, /已保存 1 项,立即生效/)
      await tab.waitForFunction(() => document.querySelector('[data-testid=backup-policy-summary]')?.textContent?.includes('留最近 3 份'))
      // 按策略清理
      await tab.locator('[data-testid=backup-prune]').click()
      ask = await confirmAsk(tab, true)
      if (!ask.message.includes('留最近 3 份')) issues.push(`清理确认应写明按什么策略,实际「${ask.message}」`)
      // 异地目录:改成一个 → 保存 → 现状只剩一个
      await fill(tab, 'backup.mirror_dirs', '/mnt/usb/kb-backups')
      await save(tab)
      await tab.waitForFunction(() => document.querySelectorAll('[data-testid=backup-mirrors] li').length === 1)
      issues.push(...(await overflowIssues(tab)), ...(await cardIssues(tab)))
      return issues
    },
  },

  'settings-backup-alert': {
    // 有未解决的失败告警:点明哪一环 / 什么原因;多次失败折在“失败记录”里;备份失败的原因常驻;校验失败红色并提醒别拿它恢复
    route: '/admin/settings?tab=backup',
    ready: '[data-testid=backup-alert]',
    fixture: settingsFixture({ alert: { kind: 'mirror', error: '外接盘没挂上' }, backupFail: { message: '磁盘空间不够' }, verifyFail: { message: 'manifest.json 缺失' } }),
    expectConsole: /500|400|Failed to load resource/,
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const alert = await text(tab, '[data-testid=backup-alert]')
      if (!alert.includes('异地副本失败') || !alert.includes('外接盘没挂上')) issues.push(`告警应点明哪一环和原因,实际「${alert}」`)
      if (await tab.locator('[data-testid=backup-failures]').evaluate((el) => el.open)) issues.push('失败记录应默认折起')
      await tab.locator('[data-testid=backup-create]').click()
      await tab.waitForSelector('[data-testid=backup-error]')
      if ((await text(tab, '[data-testid=backup-error]')) !== '备份失败:磁盘空间不够。请检查磁盘空间后重试。') issues.push('备份失败的原因应常驻在卡片里')
      await tab.locator('[data-testid=backup-verify]').first().click()
      await tab.waitForSelector('[data-testid=backup-check]')
      const check = await text(tab, '[data-testid=backup-check]')
      if (!check.includes('manifest.json 缺失') || !check.includes('不要拿它恢复')) issues.push(`校验失败应说原因并提醒别拿它恢复,实际「${check}」`)
      issues.push(...(await overflowIssues(tab)), ...(await cardIssues(tab)))
      return issues
    },
  },

  'settings-backup-state': {
    // 备份状态读取失败:报错 + 重试(以前被吞掉,页面写“还没有备份”);策略与异地目录的设置照样能改
    route: '/admin/settings?tab=backup',
    ready: '[data-testid=admin-error]',
    fixture: settingsFixture({ statusFail: { status: 500, message: '归档目录读不了' } }),
    expectConsole: /500|Failed to load resource/,
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const message = await text(tab, '[data-testid=admin-error]')
      if (!message.includes('读取备份信息失败:归档目录读不了') || !message.includes('重试')) issues.push(`应报错并给重试,实际「${message}」`)
      if ((await text(tab, '.kb-settings-body')).includes('还没有备份')) issues.push('读取失败不该写成“还没有备份”')
      if (!(await count(tab, '[data-field="backup.interval_hours"]'))) issues.push('读取失败时策略设置应照样在')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'settings-empty': {
    // 空状态都给下一步:没有备份 / 没有代理 / 没有 skill
    route: '/admin/settings?tab=backup',
    ready: '[data-testid=backup-entries]',
    fixture: settingsFixture({ noBackups: true, noAgents: true, skills: { dir: '/home/user/.kb/skills', allow_exec: false, skills: [], warnings: [] }, config: { backup: { mirror_dirs: [] } } }),
    settle: 500,
    assert: async (tab) => {
      const issues = []
      if (!(await text(tab, '[data-testid=backup-entries]')).includes('还没有备份。点上面的「立即备份」做第一份。')) issues.push('没有备份应给下一步')
      if (!(await count(tab, '[data-testid=backup-no-mirror]'))) issues.push('没配异地目录应提醒')
      issues.push(...(await sectionIssues(tab, '备份')))
      await goSection(tab, '编码代理')
      if (!(await text(tab, '[data-testid=acp-agents]')).includes('还没有可用的代理')) issues.push('没有代理应写明')
      await goSection(tab, 'Skills')
      const empty = await text(tab, '[data-testid=skills-list]')
      // 空状态的下一步是醒目的主按钮「新增 Skill」(并说明 Skill 是什么、有示例可一键填入);「重新扫描」按钮仍在页面上(skills-rescan),不再挤在空状态里
      if (!empty.includes('还没有 skill') || !empty.includes('新增 Skill')) issues.push(`没有 skill 应给下一步,实际「${empty}」`)
      if (!(await count(tab, '[data-testid=skills-rescan]'))) issues.push('没有 skill 时「重新扫描」也应在页面上(往目录里放了文件后用)')
      issues.push(...(await sectionIssues(tab, 'Skills')))
      return issues
    },
  },

  'settings-tune': {
    // 搜索与排序:参数 + 按反馈调整权重(空状态 → 预演 → 建议表 → 应用要确认 → 已应用);手机上建议是卡片
    route: '/admin/settings?tab=search',
    ready: '[data-testid=tune-card]',
    fixture: settingsFixture(),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      if (!(await text(tab, '[data-testid=tune-card]')).includes('还没有预演过')) issues.push('没预演过应是空状态')
      await tab.locator('[data-testid=tune-preview]').click()
      await tab.waitForSelector('[data-testid=tune-summary]')
      const phone = size.width < 600
      const n = await count(tab, `[data-testid=tune-card] [data-testid=${phone ? 'rt-card' : 'rt-row'}]`)
      if (n !== 2) issues.push(`应有 2 条建议,实际 ${n}`)
      if (/Collection|dry run/.test(await text(tab, '[data-testid=tune-card]'))) issues.push('界面上不该有英文的 Collection / dry run')
      issues.push(...(await sectionIssues(tab, '搜索与排序')))
      await tab.locator('[data-testid=tune-apply]').click()
      const ask = await confirmAsk(tab, true)
      if (ask.title !== '应用 2 条权重建议?') issues.push(`应用前应确认,实际「${ask.title}」`)
      await tab.waitForSelector('[data-testid=tune-outcome]')
      if (!(await text(tab, '[data-testid=tune-outcome]')).includes('已应用')) issues.push('应用后应写「已应用」')
      if (!(await tab.locator('[data-testid=tune-apply]').isDisabled())) issues.push('应用后「应用建议」应置灰')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'settings-skills-mcp': {
    // Skills:三条清单 + 告警 + 重新扫描;MCP:传输状态、令牌入口指向个人设置、配置片段不撑破页面
    route: '/admin/settings?tab=skills',
    ready: '[data-testid=skills-list]',
    fixture: settingsFixture(),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const phone = size.width < 600
      const n = await count(tab, `[data-testid=skills-list] [data-testid=${phone ? 'rt-card' : 'rt-row'}]`)
      if (n !== 3) issues.push(`应有 3 个 skill,实际 ${n}`)
      const list = await text(tab, '[data-testid=skills-list]')
      if (!list.includes('笔记模板')) issues.push('类型应叫“笔记模板”')
      if (!list.includes('覆盖阶段:审核')) issues.push('提示词应写覆盖哪个阶段')
      issues.push(...(await sectionIssues(tab, 'Skills')))
      await tab.locator('[data-testid=skills-rescan]').click()
      await waitToast(tab, /已重新扫描 Skills/)
      await goSection(tab, 'MCP 接入')
      if ((await tab.locator('[data-testid=mcp-tokens-link]').getAttribute('href')) !== '/me') issues.push('令牌入口应指向个人设置')
      if (/2025-11-25|协商版本/.test(await text(tab, '.kb-settings-body'))) issues.push('不该再列协商版本')
      issues.push(...(await sectionIssues(tab, 'MCP 接入')))
      return issues
    },
  },

  'settings-light': {
    // 浅色主题下几个信息密集的分区也无溢出 / 卡片不塌
    route: '/admin/settings?tab=backup',
    ready: '[data-testid=backup-restore]',
    fixture: settingsFixture(),
    init: lightTheme,
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await sectionIssues(tab, '备份'))]
      await goSection(tab, 'OCR 与转写')
      issues.push(...(await sectionIssues(tab, 'OCR 与转写')))
      await goSection(tab, '编码代理')
      issues.push(...(await sectionIssues(tab, '编码代理')))
      return issues
    },
  },
}
