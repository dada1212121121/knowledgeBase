// 使用指南(docs/guide/USER_GUIDE.md)里的截图。可重复生成:
//   npm run build && node e2e/guide-shots.mjs            # 全部
//   node e2e/guide-shots.mjs token-card token-create      # 只生成几张
// 输出:web-ui/public/guide/img/*.png
//
// 全部数据来自 e2e/fixture.mjs 的假接口,不连真实服务,所以截图里没有任何真实的用户、令牌或文件。
// 浅色主题(印成 PDF 更清楚);每张图在页面里临时叠上红色编号和高亮框,编号对应图注里的 ①②③。
import { chromium } from '@playwright/test'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ALL_FEATURES, NOW, adminMe, ingestStory, installFixture, sourcesDuplicatesStory } from './fixture.mjs'
import { startStaticServer } from './serve.mjs'

const OUT = resolve(import.meta.dirname, '../public/guide/img')
const DESKTOP = { width: 1440, height: 900, dpr: 1, touch: false }
const PHONE = { width: 390, height: 844, dpr: 2, touch: true }

// 普通用户:没有管理组的功能(sys.* / sources.local / search.tune),其余都有
const USER_FEATURES = ALL_FEATURES.filter((id) => !/^(sys\.|sources\.local|search\.tune)/.test(id))
const demoMe = () => {
  const user = { ...adminMe(USER_FEATURES, true), id: 'usr_demo', username: 'demo', display_name: '示例用户', role_id: 'role_user', email: 'demo@example.com' }
  return { local: false, user }
}
// 「我的」页那张图:指南正文的 AI 相关段落在 AI 总开关关闭时会隐藏,这张图要在两种情况下都不出错,
// 所以截图里也不出现「AI 助手」那一行(图注只指向「导入」和「使用指南」)
const demoMeNoAi = () => {
  const me = demoMe()
  return { ...me, user: { ...me.user, ai_enabled: false, features: USER_FEATURES.filter((id) => !id.startsWith('ai.')) } }
}
const tokenRow = (id, name, scope, shared, ageDays, used) => ({
  id, name, scope, scopes: scope, include_shared: shared, created_at: NOW - ageDays * 86_400_000, last_used: used === null ? null : NOW - used * 3_600_000, revoked_at: null,
})
const DEMO_TOKENS = [
  tokenRow('kbt_demo1', '客户端-笔记本', 'mcp', false, 12, 2),
  tokenRow('kbt_demo2', '客户端-台式机', 'mcp', true, 30, 26),
  tokenRow('kbt_demo3', '备份脚本', 'api', false, 5, null),
]
const FAKE_SECRET = 'kb_EXAMPLE_ONLY_do_not_use_0123456789abcdef'

/** 在页面里叠上高亮框和编号。marks: [{ sel, text?, nth?, pad? }];frame: 一个要一起截进来的容器选择器。 */
async function annotate(tab, marks, frame, margin = 16) {
  return tab.evaluate(
    ({ marks, frame, margin }) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const pick = (mark) => {
        const all = [...document.querySelectorAll(mark.sel)].filter(visible)
        const matched = mark.text ? all.filter((el) => (el.textContent ?? '').replace(/\s+/g, '').includes(mark.text.replace(/\s+/g, ''))) : all
        return matched[mark.nth ?? 0] ?? null
      }
      const layer = document.createElement('div')
      layer.setAttribute('data-guide-layer', '')
      layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'
      document.body.append(layer)
      const rects = []
      const missing = []
      marks.forEach((mark, index) => {
        const el = pick(mark)
        if (!el) return void missing.push(mark.sel + (mark.text ? `[${mark.text}]` : ''))
        const r = el.getBoundingClientRect()
        const pad = mark.pad ?? 4
        const box = { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 }
        rects.push(box)
        const frameEl = document.createElement('div')
        frameEl.style.cssText = `position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;border:2px solid #d92d20;border-radius:8px;box-sizing:border-box`
        const badge = document.createElement('div')
        badge.textContent = String(index + 1)
        const bx = Math.max(2, box.x - 11)
        const by = Math.max(2, box.y - 11)
        badge.style.cssText = `position:absolute;left:${bx}px;top:${by}px;width:22px;height:22px;border-radius:50%;background:#d92d20;color:#fff;font:700 13px/22px system-ui,sans-serif;text-align:center`
        layer.append(frameEl, badge)
      })
      if (frame) {
        const el = document.querySelector(frame)
        if (el) {
          const r = el.getBoundingClientRect()
          rects.push({ x: r.left, y: r.top, w: r.width, h: r.height })
        } else missing.push(`frame:${frame}`)
      }
      if (!rects.length) return { missing, clip: null }
      const x0 = Math.max(0, Math.min(...rects.map((r) => r.x)) - margin)
      const y0 = Math.max(0, Math.min(...rects.map((r) => r.y)) - margin)
      const x1 = Math.min(innerWidth, Math.max(...rects.map((r) => r.x + r.w)) + margin)
      const y1 = Math.min(innerHeight, Math.max(...rects.map((r) => r.y + r.h)) + margin)
      return { missing, rects, clip: { x: Math.floor(x0), y: Math.floor(y0), width: Math.ceil(x1 - x0), height: Math.ceil(y1 - y0) } }
    },
    { marks, frame, margin },
  )
}

const failures = []

/** 开一个全新的浏览器上下文,走完 prepare,叠标注,截图。每张图各用各的上下文,状态互不影响。 */
async function shoot(browser, base, shot) {
  const size = shot.size ?? DESKTOP
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size.dpr,
    hasTouch: size.touch,
    isMobile: size.touch,
    reducedMotion: 'reduce',
    colorScheme: 'light',
    timezoneId: 'Asia/Shanghai',
    locale: 'zh-CN',
    serviceWorkers: 'block',
  })
  try {
    await installFixture(context, { __me: demoMe, __tokens: DEMO_TOKENS, ...(shot.fixture ?? {}) })
    await context.addInitScript(() => localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'light' })))
    const tab = await context.newPage()
    await tab.clock.install({ time: NOW })
    // GUIDE_DEBUG=1:打印页面发出的接口请求和页面报错,截图和预期不一样时用来查原因
    if (process.env.GUIDE_DEBUG) {
      tab.on('request', (request) => request.url().includes('/api/') && console.log(`  → ${request.method()} ${new URL(request.url()).pathname}`))
      tab.on('pageerror', (error) => console.log(`  ✗ pageerror ${error.message}`))
    }
    await tab.goto(base + shot.route, { waitUntil: 'networkidle' })
    if (shot.ready) await tab.waitForSelector(shot.ready, { timeout: 15_000 })
    if (shot.prepare) await shot.prepare(tab, context)
    await tab.waitForTimeout(shot.settle ?? 400)
    const { missing, rects, clip } = await annotate(tab, shot.marks ?? [], shot.frame, shot.margin)
    if (process.env.GUIDE_DEBUG) console.log(`  rects ${JSON.stringify(rects)}`)
    if (missing.length) failures.push(`${shot.name}: 找不到 ${missing.join('、')}`)
    if (!clip) return void failures.push(`${shot.name}: 没有可截的区域`)
    await tab.screenshot({ path: join(OUT, `${shot.name}.png`), clip, animations: 'disabled' })
    console.log(`✓ ${shot.name} ${clip.width}x${clip.height}`)
  } finally {
    await context.close()
  }
}

const SHOTS = []

const scrollTo = (selector) => (tab) => tab.locator(selector).first().scrollIntoViewIfNeeded()
const openTokenDialog = async (tab) => {
  await tab.locator('[data-testid=token-card]').scrollIntoViewIfNeeded()
  await tab.locator('[data-testid=token-new]').click()
  await tab.waitForSelector('[data-testid=token-form]')
}

SHOTS.push(
  {
    name: 'phone-mine',
    route: '/mine',
    fixture: { __me: demoMeNoAi },
    size: PHONE,
    ready: '[data-testid=mine]',
    marks: [{ sel: '[data-nav-id=import]' }, { sel: '[data-testid=mine-guide]' }],
    frame: '[data-testid=mine]',
  },
  {
    name: 'token-card',
    route: '/me',
    // 第一次来的样子:还没有令牌(有令牌的列表见 token-list)
    fixture: { __tokens: [] },
    ready: '[data-testid=token-card]',
    prepare: scrollTo('[data-testid=token-card]'),
    marks: [{ sel: '[data-testid=token-new]' }],
    frame: '[data-testid=token-card]',
  },
  {
    name: 'token-create',
    route: '/me',
    ready: '[data-testid=token-card]',
    prepare: async (tab) => {
      await openTokenDialog(tab)
      await tab.locator('[data-testid=token-name]').fill('客户端-笔记本')
    },
    marks: [{ sel: '[data-testid=token-name]' }, { sel: '.kb-tk-scope' }, { sel: '.kb-tk-shared' }, { sel: '[data-testid=token-submit]' }],
    frame: '.kb-dialog',
  },
  {
    name: 'token-secret',
    route: '/me',
    ready: '[data-testid=token-card]',
    prepare: async (tab) => {
      await openTokenDialog(tab)
      await tab.locator('[data-testid=token-name]').fill('客户端-笔记本')
      await tab.locator('[data-testid=token-submit]').click()
      await tab.waitForSelector('[data-testid=token-done]')
      // 夹具返回的是一串规整的假字符;换成一眼就能看出是示例的文字,免得被当成真令牌
      await tab.locator('[data-testid=token-secret]').evaluate((el, text) => (el.textContent = text), FAKE_SECRET)
    },
    marks: [{ sel: '[data-testid=token-secret]' }, { sel: '.kb-tk-copyrow button' }, { sel: '[data-testid=token-close]' }],
    frame: '.kb-dialog',
  },
  {
    name: 'token-list',
    route: '/me',
    ready: '[data-testid=token-card]',
    prepare: scrollTo('[data-testid=token-card]'),
    marks: [{ sel: '[data-testid=token-shared-badge]' }, { sel: '[data-testid=token-revoke]' }],
    frame: '[data-testid=token-card]',
  },
  {
    name: 'mcp-settings',
    route: '/admin/settings?tab=mcp',
    // 「MCP 接入」分区在系统设置里,只有管理员看得到:这一张用管理员账号
    fixture: { __me: undefined },
    ready: '[data-testid=mcp-card]',
    // 片段里的地址取自当前页面(这里是本机临时端口),换成指南里统一用的占位符
    prepare: (tab) => tab.locator('.kb-st-code').evaluate((el) => (el.textContent = (el.textContent ?? '').replace(/http:\/\/127\.0\.0\.1:\d+/, 'https://<你的知识库地址>'))),
    marks: [{ sel: '[data-testid=mcp-card]' }, { sel: '[data-testid=mcp-snippet]' }],
  },
)

/** 往「添加数据」或拖入区的文件选择框里放几个示例文件(内容是几个字节的占位,文件名是示例) */
const sample = (name, type = 'application/octet-stream', kb = 640) => ({ name, mimeType: type, buffer: Buffer.alloc(kb * 1024, 'a') })
const stage = async (tab, files) => {
  await tab.locator('.kb-dialog input[type=file]').first().setInputFiles(files)
  await tab.waitForTimeout(200)
}
const openAdd = async (tab) => {
  await tab.locator('[data-testid=import-add]').click()
  await tab.waitForSelector('.kb-dialog')
}
// 夹具里的 list_ingest 不管问哪个状态都回 10,指标卡会显示成「待解析 40、失败 10」,和下面的表格对不上:
// 这里按请求的状态过滤同一份文件列表,计数才互相一致
const ingestFiles = ingestStory.list_ingest.files
const ingest = {
  __me: demoMe,
  ...ingestStory,
  list_ingest: (args) => {
    const files = args?.state ? ingestFiles.filter((file) => file.state === args.state) : ingestFiles
    return { files, total: files.length, page: 1, page_size: args?.page_size ?? 50 }
  },
}

SHOTS.push(
  {
    name: 'import-page',
    route: '/import',
    fixture: ingest,
    ready: '[data-testid=import-records]',
    marks: [{ sel: '[data-testid=import-drop]' }, { sel: '[data-testid=import-drop] button', text: '选择文件' }, { sel: '[data-testid=import-web]' }, { sel: '[data-testid=import-add]' }],
  },
  {
    name: 'add-upload',
    route: '/import',
    fixture: ingest,
    ready: '[data-testid=import-records]',
    prepare: async (tab) => {
      await openAdd(tab)
      await stage(tab, [sample('季度架构评审.docx'), sample('产品路线图.pdf', 'application/pdf'), sample('会议纪要.md', 'text/markdown')])
    },
    marks: [{ sel: '.kb-add-files' }, { sel: '.kb-add-select' }, { sel: '.kb-add-tags' }, { sel: '.kb-dialog-foot button', text: '开始解析' }],
    frame: '.kb-dialog',
  },
  {
    name: 'add-web',
    route: '/import',
    fixture: ingest,
    ready: '[data-testid=import-records]',
    prepare: async (tab) => {
      await openAdd(tab)
      await tab.locator('.stype', { hasText: '网页' }).click()
      await tab.getByLabel('网址').fill('https://docs.example.com/')
    },
    marks: [{ sel: '.kb-add-fields input[aria-label=网址]' }, { sel: '.kb-add-fields .seg' }, { sel: '.kb-add-fields input[aria-label=域名白名单]' }, { sel: '.kb-dialog-foot button', text: '添加' }],
    frame: '.kb-dialog',
  },
  {
    name: 'duplicates',
    route: '/import',
    fixture: { ...sourcesDuplicatesStory, __me: demoMe },
    ready: '[data-testid=import-records]',
    prepare: async (tab) => {
      await openAdd(tab)
      await stage(tab, [sample('向量检索综述-2025.pdf', 'application/pdf'), sample('季度架构评审.docx'), sample('模型评测.xlsx'), sample('新增-会议纪要.md', 'text/markdown')])
      await tab.locator('.kb-dialog-foot button', { hasText: '开始解析' }).click()
      await tab.waitForSelector('.kb-dup', { timeout: 15_000 })
    },
    marks: [{ sel: '.kb-dup-table' }, { sel: '.kb-dup-all' }, { sel: '.kb-dup-remember' }, { sel: '.kb-dialog-foot button', text: '继续上传' }],
    frame: '.kb-dialog',
  },
  {
    name: 'upload-progress',
    route: '/import',
    fixture: ingest,
    ready: '[data-testid=import-records]',
    prepare: async (tab, context) => {
      // 第一个分片正常完成,之后的分片一直不回应:停在「一个完成、一个正在传」的中间状态,方便截图
      let seen = 0
      await context.route(/\/api\/v1\/uploads\/[^/]+\/parts\/\d+$/, (route) => (++seen === 1 ? route.fallback() : new Promise(() => undefined)))
      await openAdd(tab)
      await stage(tab, [sample('季度架构评审.docx'), sample('产品路线图.pdf', 'application/pdf')])
      await tab.locator('.kb-dialog-foot button', { hasText: '开始解析' }).click()
      await tab.waitForSelector('.upp', { timeout: 15_000 })
      await tab.waitForTimeout(600)
    },
    marks: [{ sel: '.upi' }, { sel: '.upp .kb-upp-actions .btn' }, { sel: '.kb-upp-list' }, { sel: '.kb-upp-foot' }],
  },
  {
    name: 'import-records',
    route: '/import',
    // 够高才能把「失败」那一行(表格靠后)和它的重试按钮都截进来
    size: { ...DESKTOP, height: 1400 },
    fixture: ingest,
    ready: '[data-testid=import-records]',
    marks: [{ sel: '[data-testid=import-metrics]' }, { sel: '[data-testid=records-retry-failed]' }, { sel: '[data-testid=records-overall]' }, { sel: '[data-testid=record-retry]' }],
    frame: '[data-testid=import-records]',
  },
  {
    name: 'data-sources',
    route: '/import?tab=sources',
    size: { ...DESKTOP, height: 1000 },
    fixture: ingest,
    ready: '[data-testid=import-sources]',
    marks: [{ sel: '[data-testid=import-sources] .kb-seg' }, { sel: '[data-testid=import-sync-all]' }, { sel: '[data-testid=source-sync]', nth: 2 }],
    frame: '[data-testid=import-sources]',
  },
  {
    name: 'kb-new-note',
    route: '/kb',
    // 编辑区下面是一大片空白,矮一点;边距为 0,免得把左边的侧栏截进来一条
    size: { ...DESKTOP, height: 560 },
    margin: 0,
    ready: '[data-testid^=list-row-]',
    prepare: async (tab) => {
      await tab.locator('.kb-new-btn').click()
      await tab.waitForSelector('textarea.kb-dp-title')
    },
    marks: [{ sel: 'textarea.kb-dp-title' }, { sel: '.kb-dp-meta' }, { sel: '.kb-save-state, .kb-workspace-bar-right button', text: '保存' }],
    frame: '.kb-workspace-main',
  },
)


const only = process.argv.slice(2)
const unknown = only.filter((name) => !SHOTS.some((shot) => shot.name === name))
if (unknown.length) {
  console.error(`未知截图:${unknown.join(', ')}(可用:${SHOTS.map((shot) => shot.name).join(', ')})`)
  process.exit(2)
}
await mkdir(OUT, { recursive: true })
const { server, base } = await startStaticServer('http://127.0.0.1:1')
const browser = await chromium.launch({ chromiumSandbox: false })
try {
  for (const shot of SHOTS.filter((item) => !only.length || only.includes(item.name))) {
    try {
      await shoot(browser, base, shot)
    } catch (error) {
      failures.push(`${shot.name}: ${error instanceof Error ? error.message.split('\n')[0] : error}`)
    }
  }
} finally {
  await browser.close()
  server.close()
}
let total = 0
for (const file of await readdir(OUT)) total += (await stat(join(OUT, file))).size
console.log(`图片目录共 ${(total / 1024).toFixed(0)} KB`)
if (failures.length) {
  console.error(`✗ ${failures.length} 处问题:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
