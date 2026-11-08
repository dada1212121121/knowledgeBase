// 页面层动效验收(卡 M):在真实时间下采样,证明卡片依次升起确实在播、播完不留动画、选「减少动效」时时长为 0。
//   npm run build && node e2e/motion-pages-check.mjs
// (旧的 motion-check.mjs 里按旧导航写的选择器已经失效,这个脚本只管页面层动效。)
import { chromium } from '@playwright/test'
import { startStaticServer } from './serve.mjs'
import { installFixture } from './fixture.mjs'

const { server, base } = await startStaticServer()
const browser = await chromium.launch({ chromiumSandbox: false })
const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? '✓' : '✗'} ${name}  ${detail}`)
}

/** 最外层卡片上 kb-card-in 动画的情况 */
const cardAnims = (tab) =>
  tab.evaluate(() => {
    const cards = [...document.querySelectorAll('#kb-main .card')].filter((el) => !el.parentElement?.closest('.card'))
    const list = cards.flatMap((el) => el.getAnimations().filter((a) => a.animationName === 'kb-card-in'))
    const timing = list.map((a) => a.effect.getComputedTiming())
    return {
      motion: document.documentElement.dataset.motion,
      cards: cards.length,
      playing: list.length,
      delays: [...new Set(timing.map((t) => Math.round(t.delay)))].sort((x, y) => x - y),
      durations: [...new Set(timing.map((t) => Math.round(t.duration)))],
    }
  })

async function open(appearance) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai', locale: 'zh-CN' })
  await installFixture(ctx)
  const tab = await ctx.newPage()
  if (appearance) await tab.addInitScript((value) => localStorage.setItem('kb.appearance', value), JSON.stringify(appearance))
  await tab.goto(`${base}/tasks`, { waitUntil: 'commit' })
  await tab.waitForSelector('#kb-main .card', { timeout: 15000 })
  return { ctx, tab }
}

// 1) 默认档:同时在播多张,延迟各不相同;播完后不留动画
{
  const { ctx, tab } = await open()
  const early = await cardAnims(tab)
  await tab.waitForTimeout(2500)
  const late = await cardAnims(tab)
  check('卡片依次升起:同时在播多张、延迟各不相同', early.playing >= 2 && early.delays.length >= 2 && early.durations.every((d) => d > 0), `在播 ${early.playing}/${early.cards} 张,延迟 ${early.delays.join('/')}ms,时长 ${early.durations.join('/')}ms`)
  check('卡片播完后元素上不留动画', late.playing === 0, `2.5 秒后仍在播 ${late.playing} 张`)
  await ctx.close()
}

// 2) 外观选「减少动效」:同样的卡片动画时长与延迟都是 0
{
  const { ctx, tab } = await open({ motion: 'reduce' })
  const calm = await cardAnims(tab)
  check('减少动效:卡片都在,但没有任何卡片动画在播(时长与延迟都是 0)', calm.motion === 'reduce' && calm.cards >= 2 && calm.playing === 0, `data-motion=${calm.motion} 卡片 ${calm.cards} 张,在播 ${calm.playing} 张`)
  await ctx.close()
}

// 3) 活泼档:错开得更开(延迟的最大值比默认档大)
{
  const base1 = await open()
  const normal = await cardAnims(base1.tab)
  await base1.ctx.close()
  const lively = await open({ motion: 'lively' })
  const livelyAnims = await cardAnims(lively.tab)
  await lively.ctx.close()
  const max = (list) => Math.max(0, ...list.delays)
  check('活泼档比默认档错开得更开', max(livelyAnims) > max(normal), `默认最大延迟 ${max(normal)}ms,活泼 ${max(livelyAnims)}ms`)
}

await browser.close()
server.close()
const failed = results.filter((ok) => !ok).length
console.log(failed ? `\n✗ ${failed} 项失败` : `\n✓ 全部 ${results.length} 项页面层动效验收通过`)
process.exitCode = failed ? 1 : 0
