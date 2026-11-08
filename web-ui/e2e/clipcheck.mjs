// 裁切巡检:找「内容被裁掉且滚不到」的容器。
//
// sweep.mjs 管的是横向滚动 / 文字溢出面板 / 文字重叠;这里补的是另一类缺陷:
// 某个 overflow:hidden / clip 的容器里 scrollHeight 比 clientHeight 大 —— 下半截看不见也滚不到。
// 平板横屏(1180×820)最容易踩:内容按桌面排版,但高度只有 820。
//
// 用法:node e2e/clipcheck.mjs [--vp=1180x820,... | --devices=core|phone|tablet|desktop|all] [--routes=/dashboard,...] [--story=share|ingest] [--min=8]
// 引擎: KB_ENGINE=chromium|webkit|firefox|all(默认 chromium);设备矩阵见 e2e/devices.mjs
import { contextOptions, launch, pickDevices, pickEngines } from './devices.mjs'
import { startStaticServer } from './serve.mjs'
import { ingestStory, installFixture, NOW } from './fixture.mjs'
import { SHARE_STORY } from './share-scenarios.mjs'

const arg = (name, fallback) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
// --story=share:用有内容的分享数据巡检分享相关页面(默认通用 fixture 下它们只是空状态)
// --story=ingest:导入记录 / 批次详情 / 文件时间线有数据的版本
const story = { share: SHARE_STORY, ingest: ingestStory }[arg('story', '')] ?? {}
const DEVICES = arg('devices', '')
  ? pickDevices({ sizes: '', group: arg('devices', '') })
  : pickDevices({ sizes: arg('vp', '1024x768,1180x820,1280x800,1366x768,1440x900,1920x1080,820x1180,390x844') })
const ENGINE_NAMES = pickEngines()
const ROUTES = arg(
  'routes',
  '/login,/home,/mine,/admin/overview,/admin/overview?palette=1,/kb,/import,/import/queue,/search?q=uds,/review,/assistant,/tasks,/admin/audit,/admin/eval,/admin/projects,/admin/system,/admin/users,/admin/params,/friends,/friends?tab=requests,/friends?tab=blocked,/friends?tab=privacy,/me,/me/appearance,/dev/kit,/admin/settings?tab=general,/settings?tab=appearance,/admin/settings?tab=components,/admin/settings?tab=llm,/admin/settings?tab=mcp,/admin/settings?tab=tokens,/admin/settings?tab=model' +
    // 文件预览:默认就盯住,尤其是「一页很多行」的幻灯片与占位锚点的音频
    ',/kb?collection=knowledgeBase%2Finsights&item=file_pdf,/kb?collection=knowledgeBase%2Finsights&item=file_xlsx' +
    ',/kb?collection=knowledgeBase%2Finsights&item=file_pptx,/kb?collection=knowledgeBase%2Finsights&item=file_pptx_raw' +
    ',/kb?collection=knowledgeBase%2Finsights&item=file_png,/kb?collection=knowledgeBase%2Finsights&item=file_m4a' +
    ',/kb?collection=knowledgeBase%2Finsights&item=file_m4a_raw,/kb?collection=knowledgeBase%2Finsights&item=file_broken' +
    // 分享与协作:我的分享三个页签、公开分享页(通用 fixture 下是 404 状态页;有内容的版本用 --story=share)
    ',/shares,/shares?tab=links,/shares?tab=requests,/s/tokView',
).split(',')
// 少于这么多像素的裁切是抗锯齿/圆角,忽略
const MIN = Number(arg('min', '8'))
// 个别路由除了「不裁切」还要断言文案真的渲染出来了(:
// 把 read_error 的渲染行删掉时,布局检查不会变红,这条会)
const EXPECT = [{ match: 'item=file_broken', text: '读不到原件' }]

const { server, base } = await startStaticServer(process.env.KB_DAEMON_URL)
const problems = []
for (const engine of ENGINE_NAMES) {
const browser = await launch(engine)
for (const device of DEVICES) {
  const { width, height } = device
  const tag = engine === 'chromium' ? '' : ` [${engine}]`
  const context = await browser.newContext(
    contextOptions(device, engine, { timezoneId: 'Asia/Shanghai', locale: 'zh-CN', reducedMotion: 'reduce' }),
  )
  await installFixture(context, story)
  // 时钟在上下文级装一次:同一上下文里每个页面各装一次在 WebKit 上会报 __pwClock.controller 未定义
  await context.clock.install({ time: NOW })
  for (const route of ROUTES) {
    const tab = await context.newPage()
    await tab.goto(`${base}${route}`, { waitUntil: 'networkidle' })
    await tab.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' })
    await tab.waitForTimeout(350)
    const found = await tab.evaluate((min) => {
      const out = []
      const name = (el) => {
        const cls = String(el.className || '')
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 3)
          .join('.')
        return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`
      }
      // 有意裁切的元素:省略号截断、数字滚动动画、外观页的主题缩略图、Markdown 镜像编辑器
      // (textarea 与高亮层同格叠放、一起滚动)、输入框自身。这些不是缺陷,跳过。
      const byDesign = (el, cs) => {
        if (cs.textOverflow === 'ellipsis') return true
        if (/kb-ellipsis|\bclip\b|kb-roll|kb-md-layer|kb-md-input|kb-cell-input/.test(String(el.className || ''))) return true
        if (el.closest('.kb-theme-pv, .kb-appearance-preview, .pvw')) return true
        // 登录页左侧展示区(装饰画布)按视口裁切是设计稿本来的样子;表单区不豁免。
        // 画布本身固定在 900px 高,会把根节点 `.kb-login` 的 scrollHeight 撑大——只豁免根节点这一个元素,
        // 它的子树(表单 .rp/.lc)仍然照常检查。
        if (el.closest('.kb-login .left, .kb-login .lfoot')) return true
        if (el.classList.contains('kb-login')) return true
        return /^(input|textarea)$/i.test(el.tagName)
      }
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden') continue
        if (byDesign(el, cs)) continue
        const rect = el.getBoundingClientRect()
        if (rect.width < 40 || rect.height < 8) continue
        // 自身可滚动的不算裁切;但只滚一个方向的,另一个方向仍然会裁
        const canScrollY = /(auto|scroll)/.test(cs.overflowY)
        const canScrollX = /(auto|scroll)/.test(cs.overflowX)
        if (!canScrollY && /(hidden|clip)/.test(cs.overflowY) && el.scrollHeight - el.clientHeight >= min) {
          // 子元素自己还能滚的不算(例如卡片里嵌了一个滚动表格)
          out.push({ kind: 'clip-y', el: name(el), detail: `scrollHeight ${el.scrollHeight} > clientHeight ${el.clientHeight}` })
        }
        if (!canScrollX && /(hidden|clip)/.test(cs.overflowX) && el.scrollWidth - el.clientWidth >= min) {
          out.push({ kind: 'clip-x', el: name(el), detail: `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}` })
        }
      }
      // 塌陷:有文字但高度 < 12 的行内块(挤压到看不见)
      for (const el of document.querySelectorAll('body *')) {
        const text = (el.textContent || '').trim()
        if (!text || el.children.length) continue
        const rect = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || rect.width < 4) continue
        // SVG 里的 <text>:computedStyle.fontSize 是图内(viewBox)单位,屏幕上的实际字号要乘整张图的缩放比例(getScreenCTM)。
        // 不乘的话,图缩小之后 rect.height 小、fontSize 却还是图内的大数,会被误判成「塌陷」(图内字号放大之后才暴露出来)。
        // 不能干脆跳过 SVG 文字——那样图里真被压扁的字就看不见了
        const scale = el instanceof SVGGraphicsElement && el.getScreenCTM() ? el.getScreenCTM().a : 1
        const shownSize = parseFloat(cs.fontSize) * scale
        if (rect.height > 0 && rect.height < 10 && cs.fontSize && shownSize >= 11) {
          out.push({ kind: 'collapse', el: name(el), detail: `高 ${Math.round(rect.height)}px,字号 ${cs.fontSize}(屏幕上约 ${shownSize.toFixed(1)}px):“${text.slice(0, 24)}”` })
        }
      }
      // 去重(同一元素同一类只报一次)
      const seen = new Set()
      return out.filter((item) => {
        const key = item.kind + item.el + item.detail
        if (seen.has(key)) return false
        seen.add(key)
        return true
      }).slice(0, 10)
    }, MIN)
    if (found.length) problems.push({ vp: `${width}x${height}${tag}`, route, found })
    for (const expect of EXPECT) {
      if (!route.includes(expect.match)) continue
      const body = await tab.evaluate(() => document.body.innerText)
      if (!body.includes(expect.text)) {
        problems.push({
          vp: `${width}x${height}${tag}`,
          route,
          found: [{ kind: 'text', el: expect.match, detail: `页面里没有「${expect.text}」` }],
        })
      }
    }
    await tab.close()
  }
  await context.close()
}
await browser.close()
}
server.close()
if (!problems.length) console.log(`✓ ${ENGINE_NAMES.join('+')} × ${DEVICES.length} 个视口 × ${ROUTES.length} 个路由:没有被裁掉且滚不到的内容`)
for (const item of problems) {
  console.log(`✗ ${item.vp} ${item.route}`)
  for (const f of item.found) console.log(`    [${f.kind}] ${f.el} — ${f.detail}`)
}
process.exitCode = problems.length ? 1 : 0
