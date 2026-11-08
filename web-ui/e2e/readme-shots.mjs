// 生成 README 用的系统截图。
//
// 为什么单独写一个脚本：README 截图必须可复现，且只能使用公开的确定性 fixture，
// 不能截真实实例（真实实例里可能有用户目录、项目名和会话内容）。
// 依赖已构建的 web-ui/dist；输出到 docs/assets/screenshots/。
//
// 用法：cd web-ui && node e2e/readme-shots.mjs
import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { startStaticServer } from './serve.mjs'
import { installFixture, NOW, projectsStory, sourcesStory } from './fixture.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const REPO = resolve(ROOT, '..')
const OUT = join(REPO, 'docs/assets/screenshots')

const SEARCH_QUERY =
  '/search?q=%23insight%20%40knowledgeBase%20uds%20%E6%96%AD%E5%BC%80%20%E9%99%8D%E7%BA%A7%20rerank'

// 每张图只截一个稳定的页面状态；数字与文案来自 fixture，不读真实数据。
const PAGES = [
  { name: 'home', route: '/home', wait: 900 },
  { name: 'admin-overview', route: '/admin/overview', wait: 900 },
  { name: 'search', route: SEARCH_QUERY, wait: 900 },
  {
    name: 'browser-editor',
    route: '/kb?collection=knowledgeBase%2Finsights&kind=pitfall&dir=kb-cli%2F',
    wait: 900,
    prepare: async (tab) => {
      // 进入编辑态再截；不同内容面的可编辑节点类名不同，这里按统一的 contenteditable 兜底。
      await tab.getByRole('button', { name: '编辑', exact: true }).first.click
      await tab.waitForTimeout(500)
      const editable = tab.locator('[contenteditable="true"]').first
      if (await editable.count) await editable.focus
    },
  },
  { name: 'import-sources', route: '/import?tab=sources', fixture: sourcesStory, wait: 900 },
  { name: 'projects', route: '/admin/projects', fixture: projectsStory, wait: 900 },
  { name: 'preview-xlsx', route: '/kb?collection=knowledgeBase%2Finsights&item=file_xlsx&highlight=ck_s_r2', wait: 1800 },
  { name: 'preview-pptx', route: '/kb?collection=knowledgeBase%2Finsights&item=file_pptx&highlight=ck_sl3', wait: 1800 },
  {
    name: 'home-mobile',
    route: '/home',
    width: 390,
    height: 844,
    dpr: 2,
    wait: 900,
  },
]

await mkdir(OUT, { recursive: true })
const { server, base } = await startStaticServer
const browser = await chromium.launch({ chromiumSandbox: false, timeout: 60_000 })
try {
  for (const page of PAGES) {
    const context = await browser.newContext({
      viewport: { width: page.width ?? 1440, height: page.height ?? 900 },
      deviceScaleFactor: page.dpr ?? 1,
      reducedMotion: 'reduce',
      timezoneId: 'Asia/Shanghai',
      locale: 'zh-CN',
    })
    await installFixture(context, page.fixture ?? {})
    const tab = await context.newPage
    await tab.clock.install({ time: NOW })
    await tab.goto(`${base}${page.route}`, { waitUntil: 'networkidle' })
    if (page.prepare) await page.prepare(tab)
    await tab.addStyleTag({
      content: '*,*:before,*:after{animation:none!important;transition:none!important}',
    })
    await tab.evaluate(() => document.fonts.ready)
    await tab.waitForTimeout(page.wait ?? 800)
    const file = join(OUT, `${page.name}.png`)
    await tab.screenshot({ path: file, animations: 'disabled' })
    console.log(`wrote ${file}`)
    await context.close
  }
} finally {
  await browser.close
  server.close
}
