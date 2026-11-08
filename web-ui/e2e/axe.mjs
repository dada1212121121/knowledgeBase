// 无障碍巡检(axe-core):每个路由 × 视口 × 深浅色,统计 critical / serious 级别的问题。
//
// 为什么单独一个脚本:sweep.mjs 查版面(横向滚动 / 溢出 / 重叠),clipcheck.mjs 查被裁掉的内容,
// 这里查的是读屏和键盘能不能用:控件没名字、图片没替代文字、表单没标签、ARIA 用错、对比度不够。
// 计划门槛(.11)是「严重问题为 0」,这里的"严重"= axe 的 critical + serious。
//
// 用法:node e2e/axe.mjs [--routes=/home,/kb] [--vp=390x844,1440x900] [--themes=dark,light] [--story=prod|share] [--all]
//   默认只列严重问题;--all 连 moderate / minor 一起列。KB_ENGINE=chromium|webkit 选引擎。
//   axe 的源码从 node_modules 读;AXE_PATH=/某处/axe.min.js 可以指定位置(没装进项目时用)。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { contextOptions, launch, pickEngines } from './devices.mjs'
import { startStaticServer } from './serve.mjs'
import { installFixture, NOW, prodStory } from './fixture.mjs'
import { SHARE_STORY } from './share-scenarios.mjs'

const arg = (name, fallback) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const listAll = process.argv.includes('--all')
const stories = { prod: prodStory, share: SHARE_STORY }
const story = stories[arg('story', '')] ?? {}
const VIEWPORTS = arg('vp', '390x844,1440x900').split(',').map((item) => item.split('x').map(Number))
const THEMES = arg('themes', 'dark,light').split(',')
const ROUTES = arg(
  'routes',
  '/home,/mine,/kb,/search?q=uds,/review,/import,/import?tab=sources,/tasks,/assistant,/friends,/shares,/me,/me/appearance,/admin/overview,/admin/users,/admin/params,/admin/usage,/admin/audit,/admin/eval,/admin/projects,/admin/system,/admin/settings,/no-such-page,/unavailable',
).split(',')

const axePath = process.env.AXE_PATH ?? createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const axeSource = readFileSync(axePath, 'utf8')

const { server, base } = await startStaticServer(process.env.KB_DAEMON_URL)
const SERIOUS = new Set(['critical', 'serious'])
const found = []
for (const engine of pickEngines()) {
  const browser = await launch(engine)
  for (const [width, height] of VIEWPORTS) {
    for (const theme of THEMES) {
      const device = { name: `${width}x${height}`, width, height, touch: width < 1000, mobile: width < 600 }
      const context = await browser.newContext(contextOptions(device, engine, { timezoneId: 'Asia/Shanghai', locale: 'zh-CN', reducedMotion: 'reduce' }))
      await installFixture(context, story)
      await context.clock.install({ time: NOW })
      for (const route of ROUTES) {
        const tab = await context.newPage()
        await tab.goto(`${base}${route}`, { waitUntil: 'networkidle' }).catch(() => {})
        // 主题和 read-light 场景同一种设法:改根元素属性,不碰业务代码
        await tab.evaluate((t) => {
          document.documentElement.setAttribute('data-theme', t)
          document.documentElement.setAttribute('data-tone', t)
        }, theme)
        await tab.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' })
        await tab.waitForTimeout(400)
        await tab.evaluate(axeSource)
        const result = await tab.evaluate(async () => {
          // 只跑 WCAG 2.x A / AA 与 axe 的最佳实践规则,不跑实验性规则
          const run = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }, resultTypes: ['violations'] })
          return run.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')), count: v.nodes.length }))
        })
        for (const v of result) {
          if (!listAll && !SERIOUS.has(v.impact)) continue
          found.push({ engine, size: `${width}x${height}`, theme, route, ...v })
        }
        await tab.close()
      }
      await context.close()
    }
  }
  await browser.close()
}
server.close()

const serious = found.filter((item) => SERIOUS.has(item.impact))
// 同一条规则在同一页上只汇总一行,免得输出被重复的格子淹没
const grouped = new Map()
for (const item of found) {
  const key = `${item.impact}|${item.id}|${item.route}`
  const entry = grouped.get(key) ?? { ...item, where: new Set() }
  entry.where.add(`${item.engine}/${item.size}/${item.theme}`)
  grouped.set(key, entry)
}
for (const item of grouped.values()) {
  console.log(`[${item.impact}] ${item.route}  ${item.id}  ${item.help}  (${item.count} 处;${[...item.where].join(' ')})`)
  for (const target of item.nodes) console.log(`    ${target}`)
}
console.log(`\n严重问题(critical + serious)共 ${serious.length} 格,涉及 ${new Set(serious.map((item) => `${item.id}|${item.route}`)).size} 条(规则 × 页面)`)
process.exit(serious.length === 0 ? 0 : 1)
