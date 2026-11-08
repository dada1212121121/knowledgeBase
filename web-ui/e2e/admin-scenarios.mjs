// 管理端的页面场景:存储与用量、AI 额度排行、分享治理、系统参数补齐、用户管理补充、系统概览指标、我的用量。
// 经 viewer-shots.mjs 引入;默认跑 core 五个尺寸(手机 390×844、平板 820×1180 / 1180×820、电脑 1440×900、宽屏 1920×1080),
// KB_ENGINE=webkit 换引擎。每个页面都有 正常 / 空 / 报错(可重试)/ 无权限 四种状态的场景。
import { ALL_FEATURES, adminMe } from './fixture.mjs'
import { llmUsageFixture, myUsageFixture, storageOverviewFixture } from './fixture-admin.mjs'

/** 页面里没有被挤出视口、也没有被截断的块(只看元素自身的盒子超出,忽略被祖先 overflow 裁掉的)。 */
export async function overflowIssues(tab) {
  return tab.evaluate(() => {
    const out = []
    const doc = document.documentElement
    if (doc.scrollWidth - innerWidth > 1) out.push(`页面横向滚动 ${doc.scrollWidth - innerWidth}px`)
    for (const el of document.querySelectorAll('.content *')) {
      const box = el.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      if (box.right > innerWidth + 1) {
        let clipped = false
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
          if (/(hidden|clip|auto|scroll)/.test(getComputedStyle(a).overflowX) && a.getBoundingClientRect().right <= innerWidth + 1) clipped = true
        }
        if (!clipped) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} 右边超出视口 ${Math.round(box.right - innerWidth)}px`)
      }
    }
    return out.slice(0, 5)
  })
}

/** 一个普通管理员之外的账号:有 sys.* 之外的全部功能,没有 sys.ops(看不到存储与用量、分享治理)。 */
export const meWithout = (...blocked) => ({ local: false, user: adminMe(ALL_FEATURES.filter((id) => !blocked.includes(id)), true) })

const lightTheme = () => localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'light' }))

const firstOwner = (tab) => tab.locator('[data-testid=rt-row] .kb-su-owner b, [data-testid=storage-card] .kb-su-owner b').first().innerText()
const visibleRows = (tab) => tab.locator('[data-testid=rt-row], [data-testid=rt-card]').count()

export const ADMIN_SCENARIOS = {
  'usage-storage': {
    // 存储与用量 · 存储:磁盘与全站统计、每个人的分项与使用率条、告警徽标、排序 / 筛选 / 只看告警
    route: '/admin/usage',
    ready: '[data-testid=storage-panel] .kb-su-stats',
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await tab.evaluate(() => document.body.innerText)
      for (const word of ['存储与用量', '磁盘剩余', '全站占用', '其中向量索引', '需要关注', '张三', '林一', '王五', 'Alice', '已删除的账号', '已超额', '接近上限', '不限']) {
        if (!text.includes(word)) issues.push(`缺少「${word}」`)
      }
      if (!text.includes('只列出占用最多的 7 个知识库,全站共 128 个')) issues.push('榜单被截断时应说明只列了多少个')
      if (text.includes('暂无数据')) issues.push('不该出现「暂无数据」')
      if ((await visibleRows(tab)) !== 7) issues.push(`应有 7 个用户,实际 ${await visibleRows(tab)}`)
      // 默认按总占用从大到小:王五 400 GB 在最前
      if ((await firstOwner(tab)) !== '王五') issues.push(`默认应按总占用倒序,第一行是「王五」,实际「${await firstOwner(tab)}」`)
      // 超额的人使用率条:读屏文案里有百分比和「已超出上限」,不只靠颜色
      const label = await tab.locator('[role=progressbar][aria-label^="张三"]').first().getAttribute('aria-label')
      if (!label || !label.includes('112%') || !label.includes('已超出上限')) issues.push(`张三的使用率条文案不对:${label}`)
      if (!(await tab.locator('[role=img][aria-label^="王五"]').count())) issues.push('不限额的人应是说明性图片而不是进度条')
      // 排序:按使用率,超额的张三排最前;切正序后王五(不限)在最前
      await tab.locator('.kb-su-bar .kb-select > button').click()
      await tab.getByRole('option', { name: '使用率' }).click()
      if ((await firstOwner(tab)) !== '张三') issues.push(`按使用率倒序,第一行应是「张三」,实际「${await firstOwner(tab)}」`)
      await tab.getByRole('button', { name: /当前是倒序/ }).click()
      if ((await firstOwner(tab)) !== '王五') issues.push(`使用率正序时不限额的「王五」应在最前,实际「${await firstOwner(tab)}」`)
      // 只看告警:张三(超额)和林一(96%)
      await tab.getByRole('switch', { name: '只看接近上限或超额的人' }).click()
      const alerts = await visibleRows(tab)
      if (alerts !== 2) issues.push(`只看告警应剩 2 人,实际 ${alerts}`)
      await tab.getByRole('switch', { name: '只看接近上限或超额的人' }).click()
      // 搜索:按昵称 / 用户名;没有结果时给「清除筛选」
      await tab.getByRole('textbox', { name: '按用户名或昵称查找' }).fill('alice')
      if ((await visibleRows(tab)) !== 1) issues.push('搜索 alice 应只剩 1 人')
      await tab.getByRole('textbox', { name: '按用户名或昵称查找' }).fill('zzz-没有这个人')
      await tab.waitForSelector('text=没有符合条件的用户')
      await tab.getByRole('button', { name: '清除筛选' }).click()
      if ((await visibleRows(tab)) !== 7) issues.push('清除筛选后应回到 7 人')
      return issues
    },
  },
  'usage-storage-light': {
    // 浅色主题下同一页再看一遍(状态色徽标、使用率条、告警条的对比度由 npm run lint 的对比度检查守着,这里看布局)
    route: '/admin/usage',
    ready: '[data-testid=storage-panel] .kb-su-stats',
    sizes: ['390x844', '1440x900'],
    init: lightTheme,
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const theme = await tab.evaluate(() => document.documentElement.getAttribute('data-theme'))
      if (theme !== 'light') issues.push(`应是浅色主题,实际 ${theme}`)
      return issues
    },
  },
  'usage-storage-disk-paused': {
    // 磁盘剩余低于保留空间:顶部红色告警,说明哪些操作不受影响
    route: '/admin/usage',
    ready: '[data-testid=disk-alert]',
    sizes: ['390x844', '1440x900'],
    fixture: { storage_overview: () => ({ ...storageOverviewFixture, disk: { free_gb: 12, reserve_gb: 30, paused: true, warn: true } }) },
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await tab.locator('[data-testid=disk-alert]').innerText()
      for (const word of ['全站已经暂停上传', '剩余 12 GB', '保留空间 30 GB', '不受影响']) if (!text.includes(word)) issues.push(`磁盘告警里缺「${word}」`)
      return issues
    },
  },
  'usage-storage-empty': {
    route: '/admin/usage',
    ready: '[data-testid=storage-panel] .kb-empty',
    fixture: {
      storage_overview: () => ({
        disk: { free_gb: 200, reserve_gb: 30, paused: false, warn: false },
        totals: { measured_spaces: 0, total_spaces: 0, total_bytes: 0, vectors_bytes: 0, oldest_measured_at: null },
        top: [],
      }),
    },
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await tab.evaluate(() => document.body.innerText)
      for (const word of ['还没有统计到任何知识库的占用', '第一轮统计']) if (!text.includes(word)) issues.push(`空状态缺「${word}」`)
      if (!(await tab.getByRole('button', { name: '刷新' }).count())) issues.push('空状态应给「刷新」作为下一步')
      return issues
    },
  },
  'usage-storage-error': {
    // 报错:出了什么事 + 怎么办;点「重试」后恢复(夹具只让第一次失败)
    route: '/admin/usage',
    ready: '[data-testid=admin-error]',
    fixture: { __capabilityError: { storage_overview: { status: 503, message: '存储统计没有启用', times: 1 } } },
    // 浏览器会把这次被夹具打回的请求记进控制台;只放行这一个状态码
    expectConsole: /Failed to load resource.*\b503\b/,
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await tab.locator('[data-testid=admin-error]').innerText()
      for (const word of ['读取存储用量失败', '存储统计没有启用', '请稍后重试']) if (!text.includes(word)) issues.push(`报错里缺「${word}」`)
      if (/HTTP \d+|Failed to fetch/.test(text)) issues.push('报错里不该露英文异常 / 状态码')
      await tab.getByRole('button', { name: '重试' }).click()
      await tab.waitForSelector('[data-testid=storage-panel] .kb-su-stats')
      if (await tab.locator('[data-testid=admin-error]').count()) issues.push('重试成功后报错应消失')
      return issues
    },
  },
  'usage-storage-forbidden': {
    // 无权限:账号没有 sys.ops —— 直接输地址进来,说明原因,不给重试,也不去调接口
    route: '/admin/usage',
    ready: '[data-testid=admin-forbidden]',
    fixture: { __me: meWithout('sys.ops') },
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await tab.locator('[data-testid=admin-forbidden]').innerText()
      if (!text.includes('你的账号没有开通这个功能')) issues.push('应说明账号没有开通这个功能')
      if (!text.includes('请联系管理员')) issues.push('应告诉用户怎么办')
      if (await tab.getByRole('button', { name: '重试' }).count()) issues.push('无权限不该给「重试」')
      if (await tab.locator('[data-testid=storage-panel]').count()) issues.push('没有功能点时不该渲染数据面板')
      return issues
    },
  },
  'usage-storage-forbidden-server': {
    // 前端以为有权限(功能表里有 sys.ops),但服务端 403:同样显示无权限,不当成可重试的报错
    route: '/admin/usage',
    ready: '[data-testid=admin-forbidden]',
    fixture: { __capabilityError: { storage_overview: { status: 403, code: 'forbidden', message: '你的账号没有开通这个功能' } } },
    expectConsole: /Failed to load resource.*\b403\b/,
    sizes: ['390x844', '1440x900'],
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      if (await tab.getByRole('button', { name: '重试' }).count()) issues.push('403 不该给「重试」')
      return issues
    },
  },

  // ------------------------------------------------------------ AI 用量排行
  'usage-llm': {
    // 存储与用量 · AI 额度:每个人当天用的额度、超额标红、不限额、已删除的账号、按日期翻
    route: '/admin/usage?tab=ai',
    ready: '[data-testid=llm-panel] .kb-su-stats',
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await tab.evaluate(() => document.body.innerText)
      for (const word of ['AI 额度', '张三', '林一', '王五', 'Alice', '已删除的账号', '已超额', '接近上限', 'UTC', '需要关注']) if (!text.includes(word)) issues.push(`缺少「${word}」`)
      if (text.includes('暂无数据')) issues.push('不该出现「暂无数据」')
      const label = await tab.locator('[role=progressbar][aria-label^="张三"]').first().getAttribute('aria-label')
      if (!label || !label.includes('已超出上限')) issues.push(`张三的额度条文案不对:${label}`)
      if (!(await tab.locator('[role=img][aria-label^="王五"]').count())) issues.push('不限额的人应是说明性图片而不是进度条')
      // 前一天没有数据:空状态说明原因并能回到今天
      await tab.locator('[data-testid=llm-prev]').click()
      await tab.waitForSelector('[data-testid=llm-empty]')
      if (!(await tab.locator('[data-testid=llm-empty]').innerText()).includes('这一天没有人用过内置模型')) issues.push('空状态文案不对')
      await tab.getByRole('button', { name: '回到今天' }).click()
      await tab.waitForSelector('[data-testid=llm-panel] .kb-su-stats')
      return issues
    },
  },
  'usage-llm-light': {
    route: '/admin/usage?tab=ai',
    ready: '[data-testid=llm-panel] .kb-su-stats',
    sizes: ['390x844', '1440x900'],
    init: lightTheme,
    settle: 500,
    assert: async (tab) => [...(await overflowIssues(tab))],
  },
  'usage-llm-empty': {
    route: '/admin/usage?tab=ai',
    ready: '[data-testid=llm-empty]',
    fixture: { llm_usage_overview: () => ({ day: '2026-10-20', total_tokens: 0, ranking: [] }) },
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await tab.locator('[data-testid=llm-empty]').innerText()
      for (const word of ['这一天没有人用过内置模型', '回到今天']) if (!text.includes(word)) issues.push(`空状态缺「${word}」`)
      return issues
    },
  },
  'usage-llm-error': {
    route: '/admin/usage?tab=ai',
    ready: '[data-testid=admin-error]',
    fixture: { __capabilityError: { llm_usage_overview: { status: 503, message: '用量统计没有启用', times: 1 } } },
    expectConsole: /Failed to load resource.*\b503\b/,
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await tab.locator('[data-testid=admin-error]').innerText()
      for (const word of ['读取额度用量失败', '用量统计没有启用']) if (!text.includes(word)) issues.push(`报错里缺「${word}」`)
      await tab.getByRole('button', { name: '重试' }).click()
      await tab.waitForSelector('[data-testid=llm-panel] .kb-su-stats')
      return issues
    },
  },
  'usage-llm-forbidden-server': {
    route: '/admin/usage?tab=ai',
    ready: '[data-testid=admin-forbidden]',
    fixture: { __capabilityError: { llm_usage_overview: { status: 403, code: 'forbidden', message: '你的账号没有开通这个功能' } } },
    expectConsole: /Failed to load resource.*\b403\b/,
    sizes: ['390x844', '1440x900'],
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      if (await tab.locator('[data-testid=admin-forbidden]').getByRole('button', { name: '重试' }).count()) issues.push('403 不该给「重试」')
      return issues
    },
  },

  // ------------------------------------------------------------ 分享治理
  'usage-shares': {
    // 存储与用量 · 分享链接:全站链接、风险标记、按所有者筛选、强制撤销要二次确认
    route: '/admin/usage?tab=shares',
    ready: '[data-testid=share-admin-panel] .kb-su-stats',
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await tab.evaluate(() => document.body.innerText)
      for (const word of ['分享链接', '全站链接', '有风险', 'Alice', '张三', '林一', '已删除的账号', '无密码', '有密码', '已过期', '已撤销']) if (!text.includes(word)) issues.push(`缺少「${word}」`)
      // 已撤销的没有「强制撤销」按钮
      const buttons = await tab.getByRole('button', { name: '强制撤销' }).count()
      const rows = await tab.locator('[data-testid=rt-row], [data-testid=share-admin-card]').count()
      if (buttons >= rows) issues.push(`已撤销的链接不该再有「强制撤销」(按钮 ${buttons} / 行 ${rows})`)
      // 筛选
      await tab.locator('[data-testid=share-admin-panel] input.kb-input').fill('张三')
      const filtered = await tab.locator('[data-testid=rt-row], [data-testid=share-admin-card]').count()
      if (filtered !== 1) issues.push(`按「张三」筛选应剩 1 条,实际 ${filtered}`)
      await tab.locator('[data-testid=share-admin-panel] input.kb-input').fill('')
      // 强制撤销:先问,取消就什么都不发生
      await tab.getByRole('button', { name: '强制撤销' }).first().click()
      await tab.waitForSelector('[role=dialog], [role=alertdialog]')
      const dialog = await tab.locator('[role=dialog], [role=alertdialog]').first().innerText()
      for (const word of ['强制撤销这条分享链接?', '审计']) if (!dialog.includes(word)) issues.push(`确认框里缺「${word}」`)
      await tab.getByRole('button', { name: '先不撤销' }).click()
      return issues
    },
  },
  'usage-shares-empty': {
    route: '/admin/usage?tab=shares',
    ready: '[data-testid=share-admin-empty]',
    fixture: { share_admin_list: () => ({ links: [], total: 0, page: 1, page_size: 50 }) },
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      if (!(await tab.locator('[data-testid=share-admin-empty]').innerText()).includes('还没有人创建过分享链接')) issues.push('空状态文案不对')
      return issues
    },
  },
  'usage-shares-error': {
    route: '/admin/usage?tab=shares',
    ready: '[data-testid=admin-error]',
    fixture: { __capabilityError: { share_admin_list: { status: 503, message: '分享服务没有启动', times: 1 } } },
    expectConsole: /Failed to load resource.*\b503\b/,
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await tab.locator('[data-testid=admin-error]').innerText()
      for (const word of ['读取分享链接失败', '分享服务没有启动']) if (!text.includes(word)) issues.push(`报错里缺「${word}」`)
      await tab.getByRole('button', { name: '重试' }).click()
      await tab.waitForSelector('[data-testid=share-admin-panel] .kb-su-stats')
      return issues
    },
  },
  'usage-shares-forbidden': {
    // 没有 sys.ops:整个页面(三个页签)都不给看
    route: '/admin/usage?tab=shares',
    ready: '[data-testid=admin-forbidden]',
    fixture: { __me: meWithout('sys.ops') },
    sizes: ['390x844', '1440x900'],
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      if (await tab.locator('[data-testid=share-admin-panel]').count()) issues.push('没有功能点时不该渲染分享治理')
      if (await tab.getByRole('tab').count()) issues.push('没有功能点时不该出现页签')
      return issues
    },
  },

  // ------------------------------------------------------------ 我的用量
  'me-usage': {
    route: '/me',
    ready: '[data-testid=my-usage] .kb-mu',
    fixture: { usage_mine: () => myUsageFixture },
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await tab.locator('[data-testid=my-usage]').innerText()
      // 额度日按站点时区算(b9f15e4f 之前是 UTC):页脚写「<日期>(<时区名>)的用量,每天 0 点重置」。夹具站点时区是 Asia/Shanghai,显示成「北京时间」
      for (const word of ['我的用量', '存储', '今日 AI', '已用 6.8 万 / 共 20 万', '2026-10-20(北京时间)的用量,每天 0 点重置', '向量索引']) if (!text.includes(word)) issues.push(`缺少「${word}」`)
      if (await tab.locator('[data-testid=my-usage-storage-over]').count()) issues.push('没超额时不该出现超额提示')
      return issues
    },
  },
  'me-usage-over': {
    route: '/me',
    ready: '[data-testid=my-usage-storage-over]',
    fixture: {
      usage_mine: () => ({ storage: { ...myUsageFixture.storage, total_bytes: myUsageFixture.storage.limit_bytes * 1.2 }, ai: { ...myUsageFixture.ai, tokens_today: 250_000 } }),
    },
    sizes: ['390x844', '1440x900'],
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await tab.locator('[data-testid=my-usage]').innerText()
      for (const word of ['已超额', '不能再上传', '明天']) if (!text.includes(word)) issues.push(`超额时缺「${word}」`)
      return issues
    },
  },
  'me-usage-error': {
    route: '/me',
    ready: '[data-testid=my-usage-error]',
    fixture: { __capabilityError: { usage_mine: { status: 503, message: '统计暂时不可用', times: 1 } } },
    expectConsole: /Failed to load resource.*\b503\b/,
    sizes: ['390x844', '1440x900'],
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      await tab.locator('[data-testid=my-usage-error]').getByRole('button', { name: '重试' }).click()
      await tab.waitForSelector('[data-testid=my-usage] .kb-mu')
      return issues
    },
  },

  // ------------------------------------------------------------ 系统参数
  'params-extra': {
    // 系统参数新增项:批量索引并发、内网抓取(风险 + 需要重启)、管理员两步验证;没改时没有保存条
    route: '/admin/params',
    ready: '.kb-sp-layout',
    settle: 500,
    assert: async (tab, size) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await tab.evaluate(() => document.body.innerText)
      for (const word of ['索引与网络', '批量索引的全站并发', '允许网页来源访问内网和本机地址', '需要重启', '管理员必须开启两步验证', '配额分三层']) if (!text.includes(word)) issues.push(`缺少「${word}」`)
      if (await tab.locator('.kb-sp-save').count()) issues.push('没改任何东西时不该出现保存条(新增字段在默认配置里都有值)')
      if (text.includes('风险很高')) issues.push('内网抓取没打开时不该显示风险提示')
      // 打开内网抓取:出现风险提示和保存条
      await tab.locator('.kb-sp-row', { hasText: '允许网页来源访问内网和本机地址' }).locator('[role=switch]').click()
      await tab.waitForSelector('.kb-sp-save')
      const after = await tab.evaluate(() => document.body.innerText)
      if (!after.includes('风险很高')) issues.push('打开内网抓取后应显示风险提示')
      // 手机上保存条只留按钮(.kb-sp-count 在 ≤599px 隐藏),所以文字只在宽屏检查
      if (size.width >= 600 && !after.includes('有 1 项修改未保存')) issues.push('应提示有 1 项修改未保存')
      return issues
    },
  },
  'params-error': {
    route: '/admin/params',
    ready: '[data-testid=admin-error]',
    fixture: { __capabilityError: { get_config: { status: 503, message: '配置暂时读不出来', times: 1 } } },
    expectConsole: /Failed to load resource.*\b503\b/,
    sizes: ['390x844', '1440x900'],
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      await tab.getByRole('button', { name: '重试' }).click()
      await tab.waitForSelector('.kb-sp-layout')
      return issues
    },
  },

  // ------------------------------------------------------------ 配额覆盖
  'users-quota': {
    // 用户与权限:角色详情里有「配额覆盖」,用户详情里有「单独调整配额」;留空沿用,填了才覆盖
    route: '/admin/users',
    ready: '.kb-ut-split',
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      // 内置管理员角色拥有全部功能,没有配额覆盖;切到普通角色
      await tab.locator('.kb-ut-role').nth(1).click()
      await tab.waitForSelector('[data-testid=role-quota] [data-testid=quota-editor]')
      const role = await tab.locator('[data-testid=role-quota]').innerText()
      for (const word of ['配额覆盖', '存储配额', '每天 AI 额度', '留空 = 沿用全站默认', '0 = 不限']) if (!role.includes(word)) issues.push(`角色配额缺「${word}」`)
      const input = tab.locator('[data-testid=role-quota] input[data-key=storage_gb]')
      if ((await input.getAttribute('placeholder')) !== '沿用全站默认(默认 100)') issues.push(`占位提示不对:${await input.getAttribute('placeholder')}`)
      if (await tab.locator('[data-testid=role-quota] [data-testid=quota-save]').isEnabled()) issues.push('没改动时「保存配额」应不可点')
      await input.fill('1.5')
      await tab.locator('[data-testid=role-quota] [data-testid=quota-save]').click()
      if (!(await tab.locator('[data-testid=role-quota] [data-testid=quota-problem]').innerText()).includes('存储配额')) issues.push('小数应提示「存储配额」要填整数')
      return issues
    },
  },
}
