// 跨视口巡检:对每个路由 × 每个视口,检测
//   1) 页面横向滚动(documentElement.scrollWidth > innerWidth)
//   2) 文字溢出所在卡片(文字框超出最近的 .card / 面板)
//   3) 文字互相重叠(同一容器里两段文字的外框相交)
// 用法: node e2e/sweep.mjs [--story=prod|share|ingest] [--vp=1280x800,1180x820 | --devices=core|phone|tablet|desktop|all] [--routes=/dashboard,/settings?tab=components] [--shots]
// 引擎: KB_ENGINE=chromium|webkit|firefox|all(默认 chromium);设备矩阵见 e2e/devices.mjs
import { mkdir } from 'node:fs/promises'
import { contextOptions, launch, pickDevices, pickEngines } from './devices.mjs'
import { startStaticServer } from './serve.mjs'
import { ingestStory, installFixture, NOW, prodStory } from './fixture.mjs'
import { SHARE_STORY } from './share-scenarios.mjs'

const arg = (name, fallback) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
// ingest:导入记录 / 批次详情 / 文件时间线有数据的版本(通用夹具下这几页只是空状态或"找不到")
const stories = { prod: prodStory, share: SHARE_STORY, ingest: ingestStory }
const story = stories[arg('story', '')] ?? {}
const DEVICES = arg('devices', '')
  ? pickDevices({ sizes: '', group: arg('devices', '') })
  : pickDevices({ sizes: arg('vp', '1024x768,1180x820,1280x800,1366x768,1440x900,1920x1080,820x1180,390x844') })
const ENGINE_NAMES = pickEngines()
const ROUTES = arg(
  'routes',
  // 新地址(.4 路由重组);/settings?tab=appearance 故意保留旧写法,顺带走一遍重定向
  '/home,/mine,/admin/overview,/admin/overview?palette=1,/kb,/import,/import/queue,/search?q=uds,/review,/assistant,/tasks,/admin/audit,/admin/eval,/admin/projects,/admin/system,/admin/users,/admin/params,/friends,/friends?tab=requests,/friends?tab=blocked,/friends?tab=privacy,/me,/me/appearance,/dev/kit,/admin/settings?tab=general,/settings?tab=appearance,/admin/settings?tab=components,/admin/settings?tab=llm,/admin/settings?tab=mcp,/admin/settings?tab=tokens,/admin/settings?tab=model,/admin/settings?tab=backup,/shares,/shares?tab=links,/shares?tab=requests,/s/tokView',
).split(',')
const shots = process.argv.includes('--shots')
await mkdir('/tmp/sweep', { recursive: true })

const { server, base } = await startStaticServer(process.env.KB_DAEMON_URL)
const problems = []
for (const engine of ENGINE_NAMES) {
const browser = await launch(engine)
for (const device of DEVICES) {
  const { width, height } = device
  const tag = engine === 'chromium' ? '' : ` [${engine}]`
  const context = await browser.newContext(contextOptions(device, engine, { timezoneId: 'Asia/Shanghai', locale: 'zh-CN', reducedMotion: 'reduce' }))
  await installFixture(context, story)
  // 时钟在上下文级装一次:同一上下文里每个页面各装一次在 WebKit 上会报 __pwClock.controller 未定义
  await context.clock.install({ time: NOW })
  for (const route of ROUTES) {
    const tab = await context.newPage()
    await tab.goto(`${base}${route}`, { waitUntil: 'networkidle' })
    await tab.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' })
    await tab.waitForTimeout(400)
    const found = await tab.evaluate(() => {
      const out = []
      const doc = document.documentElement
      if (doc.scrollWidth > window.innerWidth + 1) out.push({ kind: 'hscroll', detail: `${doc.scrollWidth} > ${window.innerWidth}` })
      // display:contents 的元素自己没有盒子(矩形全是 0),拿它当面板会把每段文字都量成「超出面板」。
      // 例如手机上搜索卡片拆开后(.kb-search-top{display:contents}):跳过它,继续往外找真正有盒子的面板。
      // 这只修度量:真有盒子的面板照样检查,阈值没动
      const PANEL = '.card, .kb-split-detail, .kb-split-list, .kb-split-tree, .pal, .kb-dialog, .side, .top, .foot'
      const panelOf = (el) => {
        for (let hit = el.closest(PANEL); hit; hit = hit.parentElement?.closest(PANEL) ?? null) {
          if (getComputedStyle(hit).display !== 'contents') return hit
        }
        return null
      }
      const rects = []
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent.trim()
        if (!text) continue
        const el = node.parentElement
        if (!el || el.closest('script,style,svg,textarea,input,option,[aria-hidden=true]')) continue
        // 折起的 <details> 里面的文字根本没画出来:WebKit 给的文字框是 0×0,Chromium 却照「展开后的位置」给出矩形,
        // 会和下面的内容报「重叠」——这是度量假象。标题行(summary)本身仍然检查
        let folded = false
        for (let d = el.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) {
          const own = el.closest('summary')
          if (!d.open && !(own && own.parentElement === d)) {
            folded = true
            break
          }
        }
        if (folded) continue
        const style = getComputedStyle(el)
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        const box = range.getBoundingClientRect()
        if (box.width < 2 || box.height < 2) continue
        // 被祖先裁掉的(overflow hidden/clip/auto/scroll)不算溢出,但要用裁剪框做可见性判断
        let clip = null
        for (let a = el; a && a !== document.body; a = a.parentElement) {
          const cs = getComputedStyle(a)
          if (/(hidden|clip|auto|scroll)/.test(cs.overflowX + cs.overflowY)) {
            const r = a.getBoundingClientRect()
            clip = clip ? { l: Math.max(clip.l, r.left), r: Math.min(clip.r, r.right), t: Math.max(clip.t, r.top), b: Math.min(clip.b, r.bottom) } : { l: r.left, r: r.right, t: r.top, b: r.bottom }
          }
        }
        const visible = !clip || (box.left < clip.r - 1 && box.right > clip.l + 1 && box.top < clip.b - 1 && box.bottom > clip.t + 1)
        if (!visible) continue
        // 被 overflow / text-overflow 裁掉的部分肉眼看不到,不参与重叠判断:把文字框收窄到裁剪框内
        const seen = clip
          ? { left: Math.max(box.left, clip.l), right: Math.min(box.right, clip.r), top: Math.max(box.top, clip.t), bottom: Math.min(box.bottom, clip.b) }
          : { left: box.left, right: box.right, top: box.top, bottom: box.bottom }
        const panel = panelOf(el)
        rects.push({ el, text: text.slice(0, 40), box: seen, panel, clip })
        const limit = panel?.getBoundingClientRect()
        // 面板自己设了 overflow(hidden / clip / auto)——出面板的部分是被有意裁掉的(例如设计稿里被裁切的宽表格),不算溢出
        const panelClips = panel && /(hidden|clip|auto|scroll)/.test(getComputedStyle(panel).overflowX)
        const clipped = panelClips || (clip && box.right > clip.r + 1)
        if (limit && !clipped && (box.right > limit.right + 1 || box.left < limit.left - 1)) {
          out.push({ kind: 'bleed', detail: `“${text.slice(0, 30)}” 超出面板 ${Math.round(box.right - limit.right)}px` })
        }
        if (box.right > window.innerWidth + 1 && !clipped) out.push({ kind: 'offscreen', detail: `“${text.slice(0, 30)}” 右边在视口外 ${Math.round(box.right - window.innerWidth)}px` })
      }
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i]
          const b = rects[j]
          if (a.el.contains(b.el) || b.el.contains(a.el) || a.el === b.el) continue
          // 折行的内联高亮 span(CodeMirror / PDF 文字层 / docx)的外接矩形会跨行互相包住,
          // 这是度量假象不是视觉重叠:这些区域改由 viewer-shots.mjs 的截图与断言覆盖
          if (a.el.closest('.cm-content, .textLayer, .kbdocx-wrapper, .kb-md-read-body, .ProseMirror') && b.el.closest('.cm-content, .textLayer, .kbdocx-wrapper, .kb-md-read-body, .ProseMirror')) continue
          if (a.panel !== b.panel) continue
          const w = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left)
          const h = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top)
          if (w > 3 && h > 5) out.push({ kind: 'overlap', detail: `“${a.text}” × “${b.text}”` })
        }
      }
      return out.slice(0, 12)
    })
    if (found.length) {
      problems.push({ vp: `${width}x${height}${tag}`, route, found })
      if (shots) await tab.screenshot({ path: `/tmp/sweep/${width}x${height}-${route.replace(/[^a-z0-9]+/gi, '_')}.png` })
    }
    await tab.close()
  }
  await context.close()
}
await browser.close()
}
server.close()
if (!problems.length) console.log(`✓ ${ENGINE_NAMES.join('+')} × ${DEVICES.length} 个视口 × ${ROUTES.length} 个路由:没有横向滚动 / 文字溢出 / 文字重叠`)
for (const item of problems) {
  console.log(`✗ ${item.vp} ${item.route}`)
  for (const f of item.found) console.log(`    [${f.kind}] ${f.detail}`)
}
process.exitCode = problems.length ? 1 : 0
