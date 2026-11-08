// 场景里跑 axe-core 的共用部分(无障碍守卫场景用,巡检脚本 axe.mjs 不依赖它)。
//
// 为什么不直接复用 axe.mjs:它是整站巡检(24 条路由 × 视口 × 主题),退出码给人看;
// 场景要的是「某一类问题在某一页上不再出现」,按规则 id 精确断言,这样去掉某个修复时红的是对应那一类的场景,
// 而不是一整片。注意这里的 `rules` 只是「这条场景守哪一类」,不改变 axe.mjs 的规则范围,也不是 disableRules。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')

/** 与 axe.mjs 同一组标签:WCAG 2.x A / AA 与最佳实践,不跑实验性规则。 */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']
const SERIOUS = new Set(['critical', 'serious'])

/**
 * 在当前页上跑 axe,返回问题描述数组(空 = 通过)。
 * - rules:只跑这些规则 id(守一类问题);不传 = 跑 AXE_TAGS 全部规则里的 critical / serious。
 * - themes:深浅色各跑一遍(对比度在两套主题下结论不同);跑完把主题还原,免得后面的截图换了样子。
 * - scope:CSS 选择器,只检查这一块(例如只查某个对话框);不传 = 整页。
 */
export async function axeIssues(tab, { rules, themes = ['dark', 'light'], scope } = {}) {
  if (!(await tab.evaluate(() => 'axe' in window))) await tab.evaluate(axeSource)
  const original = await tab.evaluate(() => [document.documentElement.getAttribute('data-theme'), document.documentElement.getAttribute('data-tone')])
  const issues = []
  for (const theme of themes) {
    await tab.evaluate((t) => {
      document.documentElement.setAttribute('data-theme', t)
      document.documentElement.setAttribute('data-tone', t)
    }, theme)
    // 主题色有 120ms 的 color/background 过渡：切换后立刻跑 axe 会量到中间态，
    // 把「导出」这类按钮误报成对比度不足。等过渡结束再量，才是用户实际看到的两套主题。
    await new Promise((resolve) => setTimeout(resolve, 220))
    const found = await tab.evaluate(
      async ({ rules, tags, scope }) => {
        const options = rules ? { runOnly: { type: 'rule', values: rules } } : { runOnly: { type: 'tag', values: tags } }
        const run = await window.axe.run(scope ? document.querySelector(scope) : document, { ...options, resultTypes: ['violations'] })
        return run.violations.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }))
      },
      { rules, tags: AXE_TAGS, scope },
    )
    for (const item of found) {
      if (!rules && !SERIOUS.has(item.impact)) continue
      issues.push(`[${theme}] ${item.id}(${item.impact},${item.count} 处):${item.nodes.join(' ; ')}`)
    }
  }
  await tab.evaluate(([theme, tone]) => {
    const root = document.documentElement
    if (theme === null) root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
    if (tone === null) root.removeAttribute('data-tone')
    else root.setAttribute('data-tone', tone)
  }, original)
  return issues
}
