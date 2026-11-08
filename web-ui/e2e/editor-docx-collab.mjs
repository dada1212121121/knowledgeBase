#!/usr/bin/env node
/**
 * Word 原生协同 e2e
 *
 * 浏览器 × 2~3 经**真房间**（`e2e/office-room.mjs`：office-worker 的生产 `Room` + 服务端副本 + `agentEdit`）
 * 打开同一份 docx。验证：
 *   1. 不同段落：各改一处，双方实时互见；
 *   2. 同一段落：一个在段首、一个在段尾，交错输入，一个字都不丢，两边最终一致；
 *   3. 远端光标：对方点哪里，这里的光标层就出现在页面上同一个位置（±3px），带名字；
 *   4. 延迟：A 按键 → B 看到（用 B 的远端光标移动作信号，它只在文字到达引擎后才会动），中位 ≤150 ms；
 *   5. 断线：B 的连接被拒绝 5 秒，期间双方各自继续改；放行后自动重连并合并，谁的字都不丢；
 *   6. 远端变更不进本地撤销栈：A 撤销只撤自己的字，B 的字还在，再撤销也撤不到 B 的；
 *   7. 只读连接：能实时看到别人的修改和光标，自己的键入不改文档、也不会传给房间；
 *   8. AI `doc_edit`（服务端副本上改再广播，与 agent_edit 同一条路径）：实时到达所有人，不把人踢出去，不盖掉别人刚敲的字；
 *   9. 落地：服务端落地的字节里有所有人和 AI 的改动。
 *
 * 守护进程级的真实链路（鉴权、落盘、版本）由 `office-worker/test/e2e-ai.mjs` 覆盖；这里重点是新编辑面与房间的接线。
 *
 * 用法：npm run build && node e2e/editor-docx-collab.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { contextOptions, launch } from './devices.mjs'
import { adminMe, FILES, installFixture } from './fixture.mjs'
import { docxPlainText } from './office-compare.mjs'
import { startOfficeRoom } from './office-room.mjs'
import { startStaticServer } from './serve.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const COLLECTION = 'knowledgeBase%2Finsights'
// 不带 editor 参数：协同也走默认路由（翻默认之后默认就是新面）
const PAGE = `/kb?collection=${COLLECTION}&item=file_docx`
const SESSION = { mode: 'collab', base_sha: 'sha-fixture-original', writable: true, room_writable: true, lossless: true, participants: 0, size: 4096 }
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await wait(80)
  }
  return false
}

const failures = []
const check = (name, ok, detail = '') => {
  if (ok) console.log(`✓ ${name}`)
  else {
    failures.push(`${name}${detail ? `：${detail}` : ''}`)
    console.log(`✗ ${name}${detail ? `：${detail}` : ''}`)
  }
}

/** 一条连接：跟踪是否被"拒绝重连"（模拟断网），以及两端互通的帧数 */
function gate(room, user) {
  const state = { blocked: false, attached: 0, refused: 0, writable: true }
  return {
    state,
    handler: (ws) => {
      if (state.blocked) {
        state.refused += 1
        ws.close({ code: 1006, reason: 'e2e: network down' })
        return
      }
      state.attached += 1
      room.attach(ws, { writable: state.writable, user })
    },
    /** 掐掉当前所有连接并在 `blocked` 期间拒绝新的 */
    cut(sockets) {
      state.blocked = true
      for (const ws of sockets) ws.close({ code: 1006, reason: 'e2e: network down' })
    },
  }
}

async function openTab(browser, base, room, name, { writable = true } = {}) {
  const context = await browser.newContext(contextOptions({ width: 1440, height: 900, dpr: 1, touch: false, mobile: false }, 'chromium', { locale: 'zh-CN' }))
  const user = { id: `usr_${name}`, name }
  const sockets = new Set()
  const link = gate(room, user)
  link.state.writable = writable
  await context.routeWebSocket(/\/api\/v1\/office\/collab\?/, (ws) => {
    sockets.add(ws)
    ws.onClose(() => sockets.delete(ws))
    link.handler(ws)
  })
  await installFixture(context, {
    __officeSession: { ...SESSION, writable, room_writable: writable },
    __officeBase: () => room.base,
    __officeSeed: () => room.replica.seed(),
    file_info: () => ({ sha256: 'sha-fixture-original', origin: 'upload', max_replace_bytes: 64 * 1024 * 1024 }),
    // 显示名决定远端光标旁的名字；每个窗口一个名字才分得出是谁（保留 collab.edit 功能点）
    __me: { local: false, user: { ...adminMe(), display_name: name } },
  })
  const tab = await context.newPage()
  tab.on('pageerror', (error) => failures.push(`${name} 页面异常：${error.message}`))
  await tab.goto(`${base}${PAGE}`, { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector('[data-testid="office-edit-open"]', { timeout: 30_000 })
  await tab.click('[data-testid="office-edit-open"]')
  await tab.waitForSelector('.kb-office-host .kb-dex canvas', { timeout: 60_000 })
  return { context, tab, name, link, sockets }
}

const status = async (peer) => (await peer.tab.locator('[data-testid="office-collab-status"]').textContent().catch(() => '')) ?? ''
/** 宿主底部状态栏的主文案：Word 协同要接房间状态来源，否则会一直写「正在连接协同…」 */
const barText = async (peer) => ((await peer.tab.locator('[data-testid="editor-status-text"]').textContent().catch(() => '')) ?? '').trim()
/** 宿主底部状态栏整行文字（含右侧协同文案），用来确认「正在连接协同…」没有残留 */
const barLine = async (peer) => ((await peer.tab.locator('[data-testid="editor-status-bar"]').textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()

async function paragraphs(peer) {
  const { tab } = peer
  await tab.evaluate(() => {
    const button = document.querySelector('.kb-office-host .sr-only button[aria-expanded]')
    if (button.getAttribute('aria-expanded') === 'true') button.click()
  })
  await tab.waitForTimeout(120)
  await tab.evaluate(() => document.querySelector('.kb-office-host .sr-only button[aria-expanded]').click())
  await tab.waitForFunction(() => document.querySelectorAll('.kb-office-host section[aria-label] p').length > 0, null, { timeout: 8000 })
  await tab.waitForTimeout(250)
  return tab.evaluate(() => [...document.querySelectorAll('.kb-office-host section[aria-label] p')].map((p) => p.textContent ?? ''))
}

/** 等某个窗口读到的段落满足条件（协同到达有延迟，轮询而不是睡死） */
async function until(peer, predicate, timeoutMs = 10_000) {
  let last = []
  const ok = await waitFor(async () => {
    last = await paragraphs(peer)
    return predicate(last)
  }, timeoutMs)
  return { ok, last }
}

/** 光标移到第 n 段（0 起）的开头 / 末尾：只用键盘，不依赖像素坐标 */
async function caretTo(peer, paragraph, where) {
  await peer.tab.locator('textarea.paged-editor__input').focus()
  await peer.tab.keyboard.press('Control+Home')
  for (let i = 0; i < paragraph; i += 1) await peer.tab.keyboard.press('ArrowDown')
  await peer.tab.keyboard.press(where === 'start' ? 'Home' : 'End')
  await peer.tab.waitForTimeout(200)
}

async function main() {
  const sample = readFileSync(resolve(ROOT, 'e2e/fixtures/editor/doc-latin.docx'))
  process.env.KB_SAMPLE_DOCX = resolve(ROOT, 'e2e/fixtures/editor/doc-latin.docx')
  FILES.file_docx.item.origin = 'upload'
  FILES.file_docx.preview.origin = 'upload'

  const { server, base } = await startStaticServer()
  const browser = await launch('chromium')
  const room = await startOfficeRoom({ bytes: sample, format: 'docx' })
  room.base = new Uint8Array(sample)
  const peers = []
  try {
    const a = await openTab(browser, base, room, '甲')
    peers.push(a)
    check('A 进入已同步', await waitFor(async () => (await status(a)).includes('已同步'), 30_000), await status(a))
    const b = await openTab(browser, base, room, '乙')
    peers.push(b)
    check('B 进入已同步', await waitFor(async () => (await status(b)).includes('已同步'), 30_000), await status(b))
    check('A 的宿主状态栏跟着房间写「已同步」', await waitFor(async () => (await barText(a)) === '已同步', 20_000), await barText(a))
    check('A 的宿主状态栏不再残留「正在连接协同…」', !(await barLine(a)).includes('正在连接'), await barLine(a))
    check('A 看到房间里另有 1 人', await waitFor(async () => /另有 1 人/.test(await status(a)), 10_000), await status(a))

    const original = await paragraphs(a)
    check('夹具是 3 段', original.length === 3, JSON.stringify(original))

    // ---- 1. 不同段落 ----
    await caretTo(a, 0, 'end')
    await a.tab.keyboard.type('[A1]', { delay: 25 })
    await caretTo(b, 2, 'end')
    await b.tab.keyboard.type('[B1]', { delay: 25 })
    const seenByA = await until(a, (list) => list[0]?.endsWith('[A1]') && list[2]?.endsWith('[B1]'))
    const seenByB = await until(b, (list) => list[0]?.endsWith('[A1]') && list[2]?.endsWith('[B1]'))
    check('不同段落：A 看到 B 的改动、自己的还在', seenByA.ok, JSON.stringify(seenByA.last))
    check('不同段落：B 看到 A 的改动、自己的还在', seenByB.ok, JSON.stringify(seenByB.last))

    // ---- 2. 同一段落（A 段首、B 段尾，交错输入） ----
    await caretTo(a, 1, 'start')
    await caretTo(b, 1, 'end')
    const text = 'abcdefgh'
    for (let i = 0; i < text.length; i += 1) {
      // 两边几乎同时敲一个字：谁先到房间不确定，结果必须收敛
      await Promise.all([a.tab.keyboard.type(`1${text[i]}`, { delay: 5 }), b.tab.keyboard.type(`2${text[i]}`, { delay: 5 })])
    }
    const expectedA = [...text].map((char) => `1${char}`).join('')
    const expectedB = [...text].map((char) => `2${char}`).join('')
    const settled = await waitFor(async () => {
      const [x, y] = [await paragraphs(a), await paragraphs(b)]
      return x[1] === y[1] && x[1].startsWith(expectedA) && x[1].includes(expectedB)
    }, 15_000)
    const finalA = (await paragraphs(a))[1]
    const finalB = (await paragraphs(b))[1]
    check('同一段落：交错输入后两边一致，各自的字一个不丢', settled, `A=${JSON.stringify(finalA)} B=${JSON.stringify(finalB)}`)

    // ---- 3. 远端光标位置 ----
    await caretTo(a, 0, 'end')
    await a.tab.waitForTimeout(500)
    const localCaret = await a.tab.evaluate(() => {
      const rect = document.querySelector('[data-testid="docx-edit-caret"]')?.getBoundingClientRect()
      return rect ? { x: rect.x, y: rect.y, h: rect.height } : null
    })
    check('远端光标出现在 B 的页面上，带着 A 的名字', await waitFor(async () => (await b.tab.locator('[data-testid="remote-presence-caret"][data-name="甲"]').count()) > 0, 10_000))
    const remoteCaret = await b.tab.evaluate(() => {
      const rect = document.querySelector('[data-testid="remote-presence-caret"][data-name="甲"]')?.getBoundingClientRect()
      return rect ? { x: rect.x, y: rect.y, h: rect.height } : null
    })
    // 两个窗口大小一样、页面同位置：A 本地光标的屏幕位置和 B 上 A 的远端光标应一致（远端光标条比本地宽 1px、左移 1px）
    const near = localCaret && remoteCaret && Math.abs(localCaret.x - remoteCaret.x) <= 3 && Math.abs(localCaret.y - remoteCaret.y) <= 3 && Math.abs(localCaret.h - remoteCaret.h) <= 3
    check('远端光标位置与对方本地光标一致（±3px）', !!near, `本地 ${JSON.stringify(localCaret)} 远端 ${JSON.stringify(remoteCaret)}`)

    // 对方选中一段：B 上出现选区矩形
    await a.tab.keyboard.press('Shift+Home')
    await a.tab.waitForTimeout(700)
    check('对方选中文字：这里出现半透明选区块', (await b.tab.locator('.kb-dex-presence-range').count()) > 0)

    // ---- 4. 延迟：A 按键 → B 的远端光标移动 ----
    await caretTo(a, 2, 'end')
    await b.tab.waitForTimeout(600)
    await b.tab.evaluate(() => {
      window.__moves = []
      const caret = () => document.querySelector('[data-testid="remote-presence-caret"][data-name="甲"]')
      let last = caret()?.style.left
      new MutationObserver(() => {
        const now = caret()?.style.left
        if (now !== last) {
          last = now
          window.__moves.push(performance.timeOrigin + performance.now())
        }
      }).observe(document.querySelector('.kb-dex-presence'), { subtree: true, attributes: true, childList: true, attributeFilter: ['style'] })
    })
    await a.tab.evaluate(() => {
      window.__downs = []
      document.addEventListener('keydown', () => window.__downs.push(performance.timeOrigin + performance.now()), true)
    })
    for (let i = 0; i < 20; i += 1) {
      await a.tab.keyboard.type(String.fromCharCode(97 + (i % 26)))
      await wait(250)
    }
    await wait(500)
    const [downs, moves] = await Promise.all([a.tab.evaluate(() => window.__downs), b.tab.evaluate(() => window.__moves)])
    // 每个按键之后第一个光标移动就是它到达的时刻
    const latencies = downs.flatMap((down) => {
      const arrival = moves.find((time) => time >= down)
      return arrival !== undefined && arrival - down < 2000 ? [arrival - down] : []
    }).sort((x, y) => x - y)
    if (latencies.length >= 12) {
      const median = latencies[Math.floor(latencies.length / 2)]
      console.log(`    · 一次修改到达另一窗口：中位 ${median.toFixed(0)} ms，p95 ${latencies[Math.floor(latencies.length * 0.95)].toFixed(0)} ms，最大 ${latencies.at(-1).toFixed(0)} ms（${latencies.length} 次）`)
      check('一次修改到达另一窗口 中位 ≤150 ms', median <= 150, `${median.toFixed(0)} ms`)
    } else check('延迟测量：至少量到 12 次到达', false, `只有 ${latencies.length} 次（按键 ${downs.length}，光标移动 ${moves.length}）`)

    // ---- 6. 远端变更不进本地撤销栈 ----
    // 现状：A 刚打了一串字母在末段。让 B 在首段尾打一个标记，A 撤销若干次后，B 的标记必须还在
    await wait(700)
    await caretTo(b, 0, 'end')
    await b.tab.keyboard.type('[B2]', { delay: 25 })
    check('B 的标记到达 A', (await until(a, (list) => list[0]?.includes('[B2]'))).ok)
    await a.tab.locator('textarea.paged-editor__input').focus()
    for (let i = 0; i < 6; i += 1) {
      await a.tab.keyboard.press('Control+z')
      await wait(650)
    }
    const afterUndo = await paragraphs(a)
    check('A 撤销只撤自己的：B 的 [B2] 还在', !!afterUndo[0]?.includes('[B2]'), JSON.stringify(afterUndo))
    check('A 的撤销确实生效了（末段刚打的字母没了）', !/abcdefghijklmnopqrst/.test(afterUndo[2] ?? ''), JSON.stringify(afterUndo[2]))
    for (let i = 0; i < 40; i += 1) await a.tab.keyboard.press('Control+z')
    await wait(900)
    const deepUndo = await paragraphs(a)
    // B 的两处改动：[B2] 在首段，[B1] 在末段；撤销撤到底也撤不到
    check('撤销撤到底也撤不到 B 的改动', !!deepUndo[0]?.includes('[B2]') && !!deepUndo[2]?.includes('[B1]'), JSON.stringify(deepUndo))
    check('A 自己在段首打的字也被撤销了（撤销栈里全是 A 自己的）', !deepUndo[1]?.includes('1a'), JSON.stringify(deepUndo[1]))
    check('A 把自己的 [A1] 撤掉了', !deepUndo[0]?.includes('[A1]'), JSON.stringify(deepUndo))
    check('B 那边：自己的和 A 撤销后的状态一致', (await until(b, (list) => JSON.stringify(list) === JSON.stringify(deepUndo))).ok)

    // ---- 5. 断线 5 秒重连并合并 ----
    const attachedBefore = b.link.state.attached
    b.link.cut(b.sockets)
    check('B 的状态显示离线', await waitFor(async () => /离线|连接中/.test(await status(b)), 8_000), await status(b))
    const cutAt = Date.now()
    // 离线期间双方各自继续改（B 的改动先缓存在本地）
    await caretTo(b, 1, 'end')
    await b.tab.keyboard.type('[OFFLINE-B]', { delay: 20 })
    await caretTo(a, 2, 'end')
    await a.tab.keyboard.type('[ONLINE-A]', { delay: 20 })
    const hiddenFromA = await until(a, (list) => !list.join('').includes('OFFLINE-B'), 1500)
    check('离线期间 B 的改动 A 还看不到（连接确实断了）', hiddenFromA.ok)
    await wait(Math.max(0, 5000 - (Date.now() - cutAt)))
    b.link.state.blocked = false
    check('放行后 B 自动重连（不用刷新）', await waitFor(() => b.link.state.attached > attachedBefore, 15_000), `attached ${b.link.state.attached}（之前 ${attachedBefore}），被拒 ${b.link.state.refused} 次`)
    check('重连后 B 回到已同步', await waitFor(async () => (await status(b)).includes('已同步'), 15_000), await status(b))
    check('重连后 B 的宿主状态栏回到「已同步」', await waitFor(async () => (await barText(b)) === '已同步', 15_000), await barText(b))
    const merged = await waitFor(async () => {
      const [x, y] = [await paragraphs(a), await paragraphs(b)]
      return JSON.stringify(x) === JSON.stringify(y) && x[1]?.includes('[OFFLINE-B]') && x[2]?.includes('[ONLINE-A]')
    }, 15_000)
    check('断线 5 秒后重连合并：双方在离线期间的改动都在，且两边一致', merged, `A=${JSON.stringify(await paragraphs(a))}`)

    // ---- 7. 只读连接 ----
    const c = await openTab(browser, base, room, '丙', { writable: false })
    peers.push(c)
    check('只读连接进入已同步', await waitFor(async () => (await status(c)).includes('已同步'), 30_000), await status(c))
    const readonlyInput = await c.tab.evaluate(() => document.querySelector('textarea.paged-editor__input')?.readOnly)
    check('只读连接的输入框是只读', readonlyInput === true)
    const beforeC = await paragraphs(a)
    await c.tab.locator('textarea.paged-editor__input').focus()
    await c.tab.keyboard.press('Control+Home')
    await c.tab.keyboard.type('NOPE', { delay: 20 })
    await wait(800)
    const afterC = await paragraphs(a)
    check('只读连接的键入不改文档（A 那边不变）', JSON.stringify(beforeC) === JSON.stringify(afterC), JSON.stringify(afterC))
    check('只读连接本地也没有被改', !(await paragraphs(c)).join('').includes('NOPE'))
    await caretTo(a, 0, 'end')
    await a.tab.keyboard.type('[LIVE]', { delay: 25 })
    check('只读连接实时看到别人的修改', (await until(c, (list) => list[0]?.includes('[LIVE]'))).ok)
    check('只读连接也能看到别人的光标', await waitFor(async () => (await c.tab.locator('[data-testid="remote-presence-caret"]').count()) > 0, 10_000))

    // ---- 8. AI doc_edit 直改 ----
    await caretTo(b, 1, 'end')
    const aiStarted = Date.now()
    const changed = await room.agentEdit([{ old: 'Hello world.', new: 'Hello AI world.' }], 'AI')
    check('agentEdit 改了 1 处', changed === 1, String(changed))
    // AI 改的同时 B 继续打字：不能被盖掉
    await b.tab.keyboard.type('[TYPING-DURING-AI]', { delay: 20 })
    const aiSeenA = await until(a, (list) => list[0]?.includes('Hello AI world.'), 5_000)
    const aiSeenB = await until(b, (list) => list[0]?.includes('Hello AI world.'), 5_000)
    const aiSeenC = await until(c, (list) => list[0]?.includes('Hello AI world.'), 5_000)
    console.log(`    · AI 改动到达：A ${aiSeenA.ok ? '✓' : '✗'} B ${aiSeenB.ok ? '✓' : '✗'} C(只读) ${aiSeenC.ok ? '✓' : '✗'}，用时约 ${Date.now() - aiStarted} ms`)
    check('AI 直改实时到达 A、B 和只读的 C', aiSeenA.ok && aiSeenB.ok && aiSeenC.ok, JSON.stringify(aiSeenA.last[0]))
    check('AI 改动没有盖掉 B 同时敲的字', (await until(a, (list) => list[1]?.includes('[TYPING-DURING-AI]'))).ok)
    check('AI 改动没有把任何人踢出房间（三个窗口仍是已同步）', (await status(a)).includes('已同步') && (await status(b)).includes('已同步') && (await status(c)).includes('已同步'), `${await status(a)} | ${await status(b)} | ${await status(c)}`)
    check('AI 改动之后双方仍能继续编辑', await (async () => {
      await caretTo(a, 2, 'end')
      await a.tab.keyboard.type('[AFTER-AI]', { delay: 20 })
      return (await until(b, (list) => list[2]?.includes('[AFTER-AI]'))).ok
    })())

    // ---- 8a. AI 建议的"接受"：按当时的内容重新定位 ----
    // 服务端接受建议最终落到 agent_edit（对房间的服务端副本做"把原文换成新文字"，原文必须在文档里恰好出现一次）。
    // 这里用同一个函数验证三种结局：原文还在 → 实时并进所有人的编辑器；原文已被人改掉 → 明确失败、文档不变；原文出现多处 → 失败并要求更多上下文
    await caretTo(a, 2, 'end')
    await a.tab.keyboard.type(' ACCEPTME', { delay: 20 })
    check('建议接受之前，A 刚敲的字已到房间', (await until(b, (list) => list[2]?.includes('ACCEPTME'))).ok)
    const accepted = await room.agentEdit([{ old: 'ACCEPTME', new: 'ACCEPTED-BY-HUMAN' }], 'mcp:claude')
    check('原文还在：接受成功（改了 1 处）', accepted === 1, String(accepted))
    check('接受后实时出现在 A、B、只读的 C', (await until(a, (list) => list[2]?.includes('ACCEPTED-BY-HUMAN'))).ok && (await until(b, (list) => list[2]?.includes('ACCEPTED-BY-HUMAN'))).ok && (await until(c, (list) => list[2]?.includes('ACCEPTED-BY-HUMAN'))).ok)

    // 原文在建议提出之后被人改掉了：接受必须失败，且文档完全不变
    await caretTo(b, 2, 'end')
    await b.tab.keyboard.press('Backspace')
    await b.tab.keyboard.type('X', { delay: 20 })
    await until(a, (list) => list[2]?.endsWith('MANX') || /ACCEPTED-BY-HUMA[A-Z]/.test(list[2] ?? ''))
    const beforeStale = await paragraphs(a)
    let staleError = ''
    try {
      await room.agentEdit([{ old: 'ACCEPTED-BY-HUMAN', new: '过期的建议' }], 'mcp:claude')
    } catch (error) {
      staleError = error instanceof Error ? error.message : String(error)
    }
    check('原文已被人改掉：接受失败，并明确说"没找到要替换的原文"', /没找到要替换的原文/.test(staleError), staleError || '没有抛错')
    await wait(500)
    check('失败的接受不改文档（任何人那里都不变）', JSON.stringify(await paragraphs(a)) === JSON.stringify(beforeStale) && JSON.stringify(await paragraphs(b)) === JSON.stringify(beforeStale))

    // 原文出现多处：不知道改哪一处，要求更多上下文，不乱改
    let ambiguousError = ''
    try {
      await room.agentEdit([{ old: 'paragraph', new: '段落' }], 'mcp:claude')
    } catch (error) {
      ambiguousError = error instanceof Error ? error.message : String(error)
    }
    check('原文出现多处：失败并要求带上更多上下文', /出现了 \d+ 处/.test(ambiguousError), ambiguousError || '没有抛错')

    // ---- 8b. 评论与修订：另一个窗口实时看到（含只读连接）----
    const openReview = async (peer, tab) => {
      const slot = peer.tab.locator('[data-testid="editor-toolbar-slot"] [data-action="docx.review"]')
      if (!(await peer.tab.locator('[data-testid="docx-review-panel"]').count())) {
        if (await slot.count()) await slot.first().click()
        else {
          await peer.tab.click('[data-testid="editor-toolbar-more"]')
          await peer.tab.click('[data-testid="editor-toolbar-more-menu"] [data-action="docx.review"]')
        }
        await peer.tab.waitForSelector('[data-testid="docx-review-panel"]', { timeout: 5000 })
      }
      await peer.tab.click(`[data-testid="docx-tab-${tab}"]`)
    }
    const threads = (peer) => peer.tab.locator('[data-testid="docx-comment-thread"]').count()
    await openReview(a, 'comments')
    await openReview(b, 'comments')
    await openReview(c, 'comments')
    check('只读连接的审阅栏没有"新评论"输入框（能看不能写）', (await c.tab.locator('[data-testid="docx-comment-draft"]').count()) === 0)

    await caretTo(a, 0, 'start')
    await a.tab.keyboard.press('Shift+End')
    await a.tab.waitForTimeout(300)
    await a.tab.fill('[data-testid="docx-comment-draft"]', '甲的评论：请核对这句')
    await a.tab.click('[data-testid="docx-comment-submit"]')
    check('A 新建评论：B 的审阅栏实时出现', await waitFor(async () => (await threads(b)) === 1, 10_000))
    check('A 新建评论：只读的 C 也实时看到', await waitFor(async () => (await threads(c)) === 1, 10_000))
    const seenText = (await b.tab.locator('[data-testid="docx-comment-text"]').first().textContent())?.trim()
    check('B 看到的评论文字与作者正确', seenText === '甲的评论：请核对这句' && /甲/.test((await b.tab.locator('.kb-dex-comment-meta').first().textContent()) ?? ''), seenText)

    await b.tab.click('[data-testid="docx-comment-reply-open"]')
    await b.tab.fill('[data-testid="docx-comment-reply-draft"]', '乙的回复：已核对')
    await b.tab.click('[data-testid="docx-comment-reply-submit"]')
    check('B 回复：A 实时看到回复', await waitFor(async () => (await a.tab.locator('[data-testid="docx-comment-reply"]').count()) === 1, 10_000))
    check('B 的回复里作者是乙', /乙/.test((await a.tab.locator('[data-testid="docx-comment-reply"] .kb-dex-comment-meta').first().textContent()) ?? ''))

    // B 不能删 A 的评论（只能删自己写的）：根评论上没有删除按钮
    check('B 看不到删除 A 的评论的按钮', (await b.tab.locator('[data-testid="docx-comment-delete"]').count()) === 0)

    await a.tab.click('[data-testid="docx-comment-resolve"]')
    check('A 解决评论：B 那边进入"已解决"，进行中为 0', await waitFor(async () => (await threads(b)) === 0 && (await b.tab.locator('[data-testid="docx-resolved-toggle"]').count()) > 0, 10_000))

    // 修订：A 开修订模式改一处，B / C 的修订列表实时出现
    await openReview(a, 'revisions')
    await openReview(b, 'revisions')
    await openReview(c, 'revisions')
    await a.tab.check('[data-testid="docx-tracking-toggle"]')
    check('只读的 C 没有修订开关和接受 / 拒绝按钮', (await c.tab.locator('[data-testid="docx-tracking-toggle"]').count()) === 0 && (await c.tab.locator('[data-testid="docx-revision-accept"]').count()) === 0)
    await caretTo(a, 2, 'end')
    await a.tab.keyboard.type('[TRACKED]', { delay: 25 })
    const revisionRows = (peer) => peer.tab.locator('[data-testid="docx-revision"]').count()
    check('A 开修订改字：B 的修订列表实时出现', await waitFor(async () => (await revisionRows(b)) >= 1, 10_000), String(await revisionRows(b)))
    check('A 开修订改字：只读的 C 也看到修订', await waitFor(async () => (await revisionRows(c)) >= 1, 10_000))
    check('修订的作者是甲', /甲/.test((await b.tab.locator('[data-testid="docx-revisions-summary"]').textContent()) ?? ''))
    // B 接受 A 的修订：A 那边实时消失，文字定稿
    await b.tab.click('[data-testid="docx-accept-all"]')
    check('B 全部接受：A 的修订列表清空', await waitFor(async () => (await revisionRows(a)) === 0, 15_000), String(await revisionRows(a)))
    check('接受后文字仍在两边', (await until(a, (list) => list[2]?.includes('[TRACKED]'))).ok && (await until(b, (list) => list[2]?.includes('[TRACKED]'))).ok)
    await a.tab.uncheck('[data-testid="docx-tracking-toggle"]')

    // ---- 9. 落地 ----
    for (const peer of peers) await peer.context.close()
    peers.length = 0
    // 最后一个人离开时房间立刻落地，但落地是异步的（要把整份 docx 重新序列化）：等到房间不再有未落地的改动，
    // 而不是睡一个固定时间——机器忙时固定时间会让这条断言偶发失败
    await waitFor(() => !room.room.dirty && !room.room.landing, 30_000)
    const landed = room.landed.at(-1)
    if (!landed) check('房间关闭时落地了字节', false, '没有落地')
    else {
      const landedText = await docxPlainText(landed)
      // A 撤销掉的（[A1]、段首的 1a…、末段的字母）不该落地；没被撤销的（B 的、离线期间的、AI 的、[LIVE]、[AFTER-AI]）必须在
      const kept = ['[B1]', '[B2]', '[OFFLINE-B]', '[ONLINE-A]', '[LIVE]', 'Hello AI world.', '[TYPING-DURING-AI]', '[AFTER-AI]', '[TRACKED]', ...[...text].map((char) => `2${char}`)]
      const missing = kept.filter((fragment) => !landedText.includes(fragment))
      check('服务端落地的字节包含所有人与 AI 没被撤销的改动', missing.length === 0, `缺 ${missing.join(' ')}；落地文字：${landedText.slice(0, 200)}`)
      const undone = ['[A1]', '1a', '1h'].filter((fragment) => landedText.includes(fragment))
      check('A 撤销掉的改动没有落地（落地的就是房间的最终状态）', undone.length === 0, `仍在：${undone.join(' ')}`)
      check('落地的包里有评论部件，评论与回复的文字都在', await (async () => {
        const { default: JSZip } = await import('jszip')
        const zip = await JSZip.loadAsync(landed)
        const comments = await zip.file('word/comments.xml')?.async('string')
        return !!comments && comments.includes('甲的评论：请核对这句') && comments.includes('乙的回复：已核对')
      })())
      check('落地的包是完整的 docx（以 PK 开头）', Buffer.from(landed).subarray(0, 2).toString('latin1') === 'PK')
    }
  } finally {
    for (const peer of peers) await peer.context.close().catch(() => undefined)
    room.close()
    await browser.close()
    server.close()
  }
  if (failures.length) {
    console.error(`\n✗ ${failures.length} 项未通过\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('\n✓ Word 原生协同 e2e 全部通过')
}

await main()
