// 多人在线编辑的 Playwright 场景:由 viewer-shots.mjs 引入,在设备矩阵 × 引擎(Chromium / WebKit)下跑。
// 守护进程换成 e2e/collab-room.mjs 的假房间,经 routeWebSocket 接到页面的 /api/v1/collab/ws 上;
// 页面、编辑器、Yjs 都是真的,只有服务端是照 core.rs 写的状态机。其余接口沿用分享场景的有状态假后端。
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as Y from 'yjs'
import { FakeRoom } from './collab-room.mjs'
import { PEOPLE, installShareApi } from './share-fixture.mjs'

const COLLECTION = 'knowledgeBase%2Finsights'
const DOC = `/kb?collection=${COLLECTION}&item=ins_8f21`
const ME = { id: PEOPLE.admin.id, name: PEOPLE.admin.display_name ?? PEOPLE.admin.username ?? '管理员' }

/** 每个浏览器上下文一个房间,场景里按上下文取回来操控 */
const rooms = new WeakMap()
export const roomOf = (tab) => rooms.get(tab.context())

/**
 * 往房间里放一个"别人":发一帧在线状态,让页面的在线名单里出现他。
 * `options.cursor` 给了就同时带上光标(文档第一段里第几个字符之后;`to` 不同于 `at` 时是一段选区),页面会把他的光标和名牌画出来。
 * 光标位置是 Yjs 的相对位置,要从房间里已有的文本节点上取,所以要在初始化者把正文放进去之后再调用。
 */
function addPeer(room, who, options = {}) {
  const conn = room.join(who, true, { send() {}, close() {} })
  const awareness = new awarenessProtocol.Awareness(new Y.Doc())
  // 颜色这里写什么都没用:服务端(和假房间)按用户 id 重算,客户端自称的不采信
  const state = { user: { id: who.id, name: who.name, color: '#1971c2' } }
  if (options.cursor) {
    const text = room.doc.getXmlFragment('prosemirror').get(0)?.get?.(0)
    if (text) {
      const at = Y.createRelativePositionFromTypeIndex(text, options.cursor.at)
      const to = Y.createRelativePositionFromTypeIndex(text, options.cursor.to ?? options.cursor.at)
      state.cursor = { anchor: Y.relativePositionToJSON(at), head: Y.relativePositionToJSON(to) }
    }
  }
  awareness.setLocalState(state)
  peerStates.set(conn, { awareness, state })
  sendAwareness(room, conn, awareness)
  return conn
}

/** 别人的在线状态(movePeer 要在同一个 client id 上继续发,时钟才会递增) */
const peerStates = new WeakMap()

function sendAwareness(room, conn, awareness) {
  const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID])
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 1)
  encoding.writeVarUint8Array(encoder, update)
  room.receive(conn, encoding.toUint8Array(encoder))
}

/** 让已经在房间里的人把光标挪到第一段的另一个位置:页面上他的头像应该亮起「正在编辑」 */
function movePeer(room, conn, at) {
  const entry = peerStates.get(conn)
  const text = room.doc.getXmlFragment('prosemirror').get(0)?.get?.(0)
  if (!entry || !text) return
  const position = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, at))
  entry.state.cursor = { anchor: position, head: position }
  entry.awareness.setLocalState({ ...entry.state })
  sendAwareness(room, conn, entry.awareness)
}

async function installCollab(context, options) {
  const room = new FakeRoom({ kind: 'rich', markdown: '# 部署手册\n\n先停服,再升级。', ...options.room })
  const control = { room, addPeer: (who, options) => addPeer(room, who, options), movePeer: (conn, at) => movePeer(room, conn, at), refuse: false, writable: options.writable ?? true, sockets: [], mine: null, opened: 0 }
  rooms.set(context, control)
  await context.routeWebSocket(/\/api\/v1\/collab\/ws/, (ws) => {
    control.opened += 1
    if (control.refuse) {
      // 握手被拒:页面只看到连接失败
      ws.close({ code: 1006 })
      return
    }
    // 重连时沿用当前的可写状态:被降级的人重连后服务端仍然只给只读
    const conn = room.join(ME, control.writable, {
      send: (bytes) => ws.send(Buffer.from(bytes)),
      close: (code, reason) => ws.close({ code, reason }),
    })
    control.mine = conn
    control.sockets.push(ws)
    ws.onMessage((message) => room.receive(conn, typeof message === 'string' ? new TextEncoder().encode(message) : new Uint8Array(message)))
    ws.onClose(() => room.leave(conn))
  })
}

export function collabFixture(options = {}) {
  return {
    // 笔记详情的覆盖:要让"页面标题 / 正文第一行"之类依赖 get_item 的场景自己定正文(协作时 get_item 的正文只是父级跟踪的副本,房间里的才是真正在编辑的)
    ...(options.item ? { get_item: () => ({ item: { id: 'ins_8f21', collection: 'knowledgeBase/insights', kind: 'insight', insight_kind: 'note', tags: [], source: '', updated_at: 1793000000, version: 3, status: 'active', ...options.item }, context: null }) } : {}),
    __after: async (context) => {
      await installShareApi(context, {})
      await installCollab(context, options)
    },
  }
}

export const GREEN = { id: 'usr_green_2', name: 'Green' }
export const BOB = { id: PEOPLE.bob.id, name: PEOPLE.bob.display_name ?? PEOPLE.bob.username ?? 'Bob' }

export async function startEditing(tab) {
  await tab.getByRole('button', { name: '编辑', exact: true }).first().click({ timeout: 10_000 })
  await tab.waitForSelector('[data-testid=collab-bar]', { timeout: 10_000 })
}
const statusOf = (tab) => tab.evaluate(() => document.querySelector('[data-testid=collab-bar]')?.getAttribute('data-status'))
const textOf = (tab) => tab.evaluate(() => document.querySelector('[data-testid=collab-status]')?.textContent ?? '')
export const waitStatus = (tab, status, timeout = 15_000) =>
  tab.waitForFunction((want) => document.querySelector('[data-testid=collab-bar]')?.getAttribute('data-status') === want, status, { timeout })
const editable = (tab) => tab.evaluate(() => document.querySelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)')?.getAttribute('contenteditable') === 'true')

/**
 * 状态条不能比屏幕宽,里面的每个元素也不能伸出状态条。
 * 不用 scrollWidth 判断:小按钮靠 ::before 外扩出 44px 的可点区域(见 device.css),它会计入 scrollWidth,但那是有意为之。
 */
async function barFits(tab, size) {
  const box = await tab.evaluate(() => {
    const el = document.querySelector('[data-testid=collab-bar]')
    const r = el?.getBoundingClientRect()
    if (!r) return null
    const kids = [...el.querySelectorAll('*')]
      .map((child) => ({ tag: `${child.tagName.toLowerCase()}.${String(child.className).split(' ')[0]}`, box: child.getBoundingClientRect() }))
      .filter((kid) => kid.box.width > 0 && (kid.box.right > r.right + 1 || kid.box.left < r.left - 1))
      .map((kid) => `${kid.tag} ${Math.round(kid.box.left - r.left)}..${Math.round(kid.box.right - r.left)}`)
    return { left: r.left, right: r.right, width: r.width, kids: kids.slice(0, 3) }
  })
  if (!box) return ['状态条不见了']
  const issues = []
  if (box.left < -1 || box.right > size.width + 1) issues.push(`状态条超出屏幕 ${Math.round(box.left)}~${Math.round(box.right)} / ${size.width}`)
  if (box.kids.length) issues.push(`状态条里的元素伸出了状态条(宽 ${Math.round(box.width)}):${box.kids.join('、')}`)
  return issues
}

export const COLLAB_SCENARIOS = {
  'collab-synced': {
    // 进入编辑:连上房间,初始化者把正文放进去,状态变成"已同步",在线名单里有 Bob;输入的字进到房间里
    route: DOC,
    ready: '[data-testid=doc-share]',
    fixture: collabFixture(),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      await startEditing(tab)
      await waitStatus(tab, 'synced')
      // 初始化者必须是我(第一个进房间的人),所以同伴等我就绪之后再加入
      roomOf(tab).addPeer(BOB)
      if (!(await textOf(tab)).includes('已同步')) issues.push(`状态文案不对:${await textOf(tab)}`)
      if (!(await editable(tab))) issues.push('已同步后编辑器应可编辑')
      await tab.locator('[data-testid=collab-peers] [data-peer]').first().waitFor({ timeout: 5000 }).catch(() => issues.push('在线名单里没有 Bob'))
      issues.push(...(await barFits(tab, size)))
      const { room } = roomOf(tab)
      if (!room.richText().includes('先停服')) issues.push(`初始化者没有把正文放进房间:${room.richText()}`)
      await tab.locator(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)').click()
      await tab.keyboard.press('Control+End')
      await tab.keyboard.type(' 新增一句')
      await tab.waitForTimeout(400)
      if (!room.richText().includes('新增一句')) issues.push(`输入的字没有进房间:${room.richText()}`)
      return issues
    },
  },

  'collab-avatars': {
    // 腾讯文档式的"谁在编辑":顶栏头像堆(我排第一,每人一圈光标色)、点开的"正在编辑"列表、文档里别人的光标与名牌。
    // 同事 Green 的 id 经颜色算法落在绿色 #2f9e44 上:白字在上面只有 3.45,名牌必须改用黑字
    route: DOC,
    ready: '[data-testid=doc-share]',
    fixture: collabFixture(),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      await startEditing(tab)
      await waitStatus(tab, 'synced')
      roomOf(tab).addPeer(GREEN, { cursor: { at: 2 } })
      const stack = tab.locator('[data-testid=collab-stack]')
      await stack.waitFor({ timeout: 8000 }).catch(() => issues.push('顶栏没有头像堆'))
      await tab.locator('[data-testid=collab-peers] [data-peer]').nth(1).waitFor({ timeout: 8000 }).catch(() => issues.push('头像堆里没有 Green'))
      const order = await tab.evaluate(() => [...document.querySelectorAll('[data-testid=collab-peers] [data-peer]')].map((el) => ({ id: el.getAttribute('data-peer'), me: el.hasAttribute('data-me') })))
      if (!order[0]?.me) issues.push(`头像堆里我应该排第一并带 data-me:${JSON.stringify(order)}`)
      if (order.slice(1).some((p) => p.me)) issues.push('只该有一个"我"')
      if (order.length !== 2) issues.push(`应有 2 个头像(我 + Green),实际 ${order.length}`)
      // 头像堆在顶栏里,不超屏幕、不压住"保存 / 完成"
      const box = await tab.evaluate(() => {
        const r = (sel) => document.querySelector(sel)?.getBoundingClientRect()
        const s = r('[data-testid=collab-stack]')
        const bar = r('.kb-workspace-bar')
        const done = [...document.querySelectorAll('.kb-workspace-bar-right .btn')].map((b) => b.getBoundingClientRect())
        return { s: s && { l: s.left, r: s.right, t: s.top, b: s.bottom }, bar: bar && { t: bar.top, b: bar.bottom }, overlap: done.some((d) => s && d.width > 0 && d.left < s.right - 0.5 && d.right > s.left + 0.5 && d.top < s.bottom && d.bottom > s.top) }
      })
      if (box.s && (box.s.l < 0 || box.s.r > size.width + 0.5)) issues.push(`头像堆超出屏幕:${Math.round(box.s.l)}~${Math.round(box.s.r)} / ${size.width}`)
      if (box.s && box.bar && (box.s.t < box.bar.t - 0.5 || box.s.b > box.bar.b + 0.5)) issues.push('头像堆应在顶栏里面')
      if (box.overlap) issues.push('头像堆压住了顶栏上的按钮')
      // 文档里 Green 的光标和名牌
      await tab.locator('.kb-dp .kb-cursor').first().waitFor({ timeout: 8000 }).catch(() => issues.push('文档里没有画出 Green 的光标'))
      const cursor = await tab.evaluate(() => {
        const el = document.querySelector('.kb-dp .kb-cursor')
        const label = el?.querySelector('.kb-cursor-label')
        return el && { name: label?.textContent, color: el.style.getPropertyValue('--cursor-color'), ink: el.style.getPropertyValue('--cursor-ink'), shown: label ? getComputedStyle(label).visibility : null, border: getComputedStyle(el).borderLeftWidth }
      })
      if (cursor) {
        if (cursor.name !== 'Green') issues.push(`名牌应写 Green,实际 ${cursor.name}`)
        if (cursor.color !== '#2f9e44') issues.push(`名牌底色应是服务端按 id 算出的颜色,实际 ${cursor.color}`)
        if (cursor.ink !== '#000') issues.push(`绿底上名牌应用黑字(白字对比度 3.45),实际 ${cursor.ink}`)
        // 不靠手写的期望值:页面里把名牌的实际字色和底色再算一遍对比度
        const ratio = await tab.evaluate(() => {
          const label = document.querySelector('.kb-dp .kb-cursor-label')
          const parse = (css) => css.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number)
          const lum = ([r, g, b]) => [r, g, b].map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((acc, c, i) => acc + c * [0.2126, 0.7152, 0.0722][i], 0)
          const style = getComputedStyle(label)
          const [hi, lo] = [lum(parse(style.color)), lum(parse(style.backgroundColor))].sort((a, b) => b - a)
          return (hi + 0.05) / (lo + 0.05)
        })
        if (ratio < 4.5) issues.push(`名牌文字对比度应 ≥ 4.5,实际 ${ratio.toFixed(2)}`)
        if (cursor.shown !== 'visible') issues.push('刚出现时名牌应该是显示的')
        if (parseFloat(cursor.border) < 1.5) issues.push(`光标线应有 2px,实际 ${cursor.border}`)
      }
      // 点开"正在编辑"
      await stack.locator('button').click()
      await tab.waitForSelector('[data-testid=collab-list]', { timeout: 5000 }).catch(() => issues.push('点头像堆没有弹出列表'))
      const rows = await tab.evaluate(() => [...document.querySelectorAll('[data-testid=collab-list] .kb-clist-row')].map((row) => ({ name: row.querySelector('.kb-clist-name')?.textContent?.trim(), you: !!row.querySelector('.kb-clist-tag') })))
      if (rows.length !== 2) issues.push(`列表应有 2 行,实际 ${rows.length}`)
      if (!rows[0]?.you) issues.push('第一行应是我,并带"你"标记')
      if (rows[1]?.name !== 'Green') issues.push(`第二行应是 Green,实际 ${rows[1]?.name}`)
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('[data-testid=collab-list]', { state: 'detached', timeout: 3000 }).catch(() => issues.push('Esc 应关掉列表'))
      // 断线后:头像堆变灰,名单里不再有"还在线"的 Green(连接没了,名单是过期的),只剩我
      const control = roomOf(tab)
      control.refuse = true
      control.sockets.at(-1).close({ code: 1001, reason: '服务重启' })
      await waitStatus(tab, 'offline', 20_000).catch(() => issues.push('断线后状态应变成 offline'))
      const after = await tab.evaluate(() => ({ dim: !!document.querySelector('[data-testid=collab-stack].is-dim'), peers: [...document.querySelectorAll('[data-testid=collab-peers] [data-peer]')].map((el) => el.getAttribute('data-peer')) }))
      if (!after.dim) issues.push('断线后头像堆应变灰')
      if (after.peers.includes(GREEN.id)) issues.push('断线后不该继续显示 Green 还在线')
      return issues
    },
  },

  'collab-dup-title': {
    // 正文第一行是和标题同名的一级标题:读页面时藏掉(标题只出现一次),进入编辑后必须显示出来,用户要能改到它。
    // 笔记标题和 get_item 的正文第一行、房间里的正文第一行都是「部署手册」
    route: DOC,
    ready: '[data-testid=doc-share]',
    fixture: collabFixture({
      item: { title: '部署手册', text: '# 部署手册\n\n先停服,再升级。' },
      room: { markdown: '# 部署手册\n\n先停服,再升级。' },
    }),
    sizes: ['390x844'],
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const titleH1s = () => tab.evaluate(() => [...document.querySelectorAll(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) h1')].filter((el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0).length)
      // 读模式:页头已经写了「部署手册」,正文里同名的一级标题不再画第二遍
      await tab.waitForSelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) h1', { state: 'attached', timeout: 10_000 }).catch(() => issues.push('读模式下正文里应有这个 h1(只是被藏起来)'))
      if ((await titleH1s()) !== 0) issues.push(`读模式下正文里和标题同名的一级标题应被藏起来,实际可见 ${await titleH1s()} 个`)
      await startEditing(tab)
      await waitStatus(tab, 'synced')
      await tab.waitForTimeout(500)
      if ((await titleH1s()) < 1) issues.push('编辑模式下正文里的同名一级标题应显示出来(用户要能改到它)')
      return issues
    },
  },

  'density-editor-body-start': {
    // 编辑页(设计规范):手机上第一行正文不能太靠下。已同步状态下量「第一个内容块」的顶边占屏高的比例。
    // 协作模式下 y-prosemirror 会在 ProseMirror 最前面插一个高 0 的 div.ProseMirror-widget(光标占位):
    // 它成了 :first-child,于是"第一个块上边距清零"的规则命中了它而不是真正的第一个块,标题上方白白多出 39px
    route: DOC,
    ready: '[data-testid=doc-share]',
    fixture: collabFixture(),
    sizes: ['390x844'],
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      await startEditing(tab)
      await waitStatus(tab, 'synced')
      await tab.waitForTimeout(300)
      const m = await tab.evaluate(() => {
        const pm = document.querySelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)')
        const first = [...pm.children].find((el) => !el.classList.contains('ProseMirror-widget'))
        const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), h: Math.round(b.height) } }
        const fb = first.getBoundingClientRect()
        return { vh: innerHeight, firstTag: first.tagName.toLowerCase(), firstTop: Math.round(fb.top), firstMargin: parseFloat(getComputedStyle(first).marginTop), bar: r('.kb-workspace-bar'), title: r('.kb-dp-title'), meta: r('.kb-dp-meta'), toolbar: r('.kb-doc-bar') ?? r('.kb-editor-chrome') }
      })
      // 元信息区(状态 / 类型 / 更新时间 / 字数 / 标签)最多两行:字数不该再单独占一行
      const rows = await tab.evaluate(() => new Set([...document.querySelector('.kb-dp-meta').children].filter((el) => el.getBoundingClientRect().height > 0).map((el) => Math.round(el.getBoundingClientRect().top))).size)
      if (rows > 2) issues.push(`元信息区应最多两行(状态·类型·更新·字数 / 标签),实际 ${rows} 行`)
      const ratio = m.firstTop / m.vh
      if (m.firstMargin > 0.5) issues.push(`第一个内容块(${m.firstTag})上方还有 ${m.firstMargin}px 的外边距,应为 0(协作占位元素可能抢走了 :first-child)`)
      if (ratio > 0.30) issues.push(`编辑页第一行正文在屏高的 ${Math.round(ratio * 100)}% 处(应 ≤ 30%):顶栏 ${m.bar.h} 标题 ${m.title.h} 元信息 ${m.meta.h} 工具栏 ${m.toolbar?.h},正文顶边 ${m.firstTop}px`)
      return issues
    },
  },

  'collab-offline-recover': {
    // 服务端断开:显示"重连中"和"立即重试",本地继续写;恢复后改动合并进房间
    route: DOC,
    ready: '[data-testid=doc-share]',
    fixture: collabFixture(),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      await startEditing(tab)
      await waitStatus(tab, 'synced')
      const control = roomOf(tab)
      control.refuse = true
      control.sockets.at(-1).close({ code: 1001, reason: '服务重启' })
      await waitStatus(tab, 'offline', 8000).catch(() => issues.push(`断开后没有进入离线状态:${'当前 ' + ''}`))
      const text = await textOf(tab)
      if (!text.includes('重连')) issues.push(`离线文案没有说明正在重连:${text}`)
      if (!(await tab.locator('[data-testid=collab-retry]').count())) issues.push('离线时应有「立即重试」')
      issues.push(...(await barFits(tab, size)))
      await tab.locator(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)').click().catch(() => undefined)
      await tab.keyboard.press('Control+End')
      await tab.keyboard.type(' 断线时写的')
      control.refuse = false
      await tab.locator('[data-testid=collab-retry]').click()
      await waitStatus(tab, 'synced', 15_000).catch(() => issues.push('恢复后没有回到已同步'))
      await tab.waitForTimeout(500)
      if (!control.room.richText().includes('断线时写的')) issues.push(`断线时的修改没有在恢复后合并进房间:${control.room.richText()}`)
      return issues
    },
  },

  'collab-denied': {
    // 权限被收回(4403):说清原因,不再重连,编辑器只读,没有"重试"
    route: DOC,
    ready: '[data-testid=doc-share]',
    fixture: collabFixture(),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      await startEditing(tab)
      await waitStatus(tab, 'synced')
      const control = roomOf(tab)
      const before = control.opened
      control.room.removeUser(ME.id, '你对这篇文档的编辑权限已被收回')
      await waitStatus(tab, 'closed', 8000).catch(() => issues.push('被收回权限后状态应为已断开'))
      const text = await textOf(tab)
      if (!text.includes('权限')) issues.push(`没有说明是权限被收回:${text}`)
      if (await tab.locator('[data-testid=collab-retry], [data-testid=collab-reopen]').count()) issues.push('权限被收回后不应再提供重试 / 重新打开')
      if (await editable(tab)) issues.push('权限被收回后编辑器应变成只读')
      await tab.waitForTimeout(2500)
      if (control.opened !== before) issues.push('权限被收回后不该继续重连')
      issues.push(...(await barFits(tab, size)))
      return issues
    },
  },

  'collab-stale-reopen': {
    // 文档在别处被改(4409):提示并给"重新打开",点了换一份新文档重连
    route: DOC,
    ready: '[data-testid=doc-share]',
    fixture: collabFixture(),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      await startEditing(tab)
      await waitStatus(tab, 'synced')
      const control = roomOf(tab)
      control.room.discard(4409, '这篇文档在别处被修改了')
      await waitStatus(tab, 'closed', 8000).catch(() => issues.push('4409 后状态应为已断开'))
      if (!(await tab.locator('[data-testid=collab-reopen]').count())) issues.push('4409 应提供「重新打开」')
      issues.push(...(await barFits(tab, size)))
      control.room.init = 'done'
      await tab.locator('[data-testid=collab-reopen]').click()
      await waitStatus(tab, 'synced', 15_000).catch(() => issues.push('重新打开后没有回到已同步'))
      return issues
    },
  },

  'collab-readonly': {
    // 被降级成只读:状态条说明,编辑器不可编辑,仍能看到别人的修改
    route: DOC,
    ready: '[data-testid=doc-share]',
    fixture: collabFixture(),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      await startEditing(tab)
      await waitStatus(tab, 'synced')
      const control = roomOf(tab)
      control.writable = false
      control.room.setWritable(control.mine, false)
      await tab.waitForFunction(() => document.querySelector('[data-testid=collab-status]')?.textContent?.includes('只读'), null, { timeout: 8000 }).catch(() => issues.push(`降级后状态条没有说明只读:${'当前状态 ' + 'unknown'}`))
      if (await editable(tab)) issues.push('降级后编辑器应只读')
      issues.push(...(await barFits(tab, size)))
      return issues
    },
  },

  'collab-jump': {
    // 腾讯文档式:对方动光标 → 头像亮点、名单里写「正在编辑」,几秒后熄灭;点名单里的人 → 视图跳到他的光标并让名牌重新亮出来;
    // 他还没把光标放进正文 → 名单不关,说明一句;触屏上这一行够 44px
    route: DOC,
    ready: '[data-testid=doc-share]',
    fixture: collabFixture(),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      await startEditing(tab)
      await waitStatus(tab, 'synced')
      const control = roomOf(tab)
      const green = control.addPeer(GREEN, { cursor: { at: 2 } })
      control.addPeer(BOB)
      await tab.locator('[data-testid=collab-peers] [data-peer]').nth(2).waitFor({ timeout: 8000 }).catch(() => issues.push('头像堆里没有 Green 和 Bob'))
      // 刚加入、光标还没动过:不算「正在编辑」
      await tab.waitForTimeout(300)
      if (await tab.locator('[data-testid=collab-peers] [data-active]').count()) issues.push('刚加入时头像不该亮点(第一次看到的光标不算活动)')
      control.movePeer(green, 6)
      await tab.locator(`[data-testid=collab-peers] [data-peer="${GREEN.id}"][data-active]`).waitFor({ timeout: 3000 }).catch(() => issues.push('Green 动了光标,头像上应该亮点'))
      // 点开名单:Green 一行写着「正在编辑」,并且是个按钮
      await tab.locator('[data-testid=collab-stack] button').first().click()
      await tab.waitForSelector('[data-testid=collab-list]', { timeout: 5000 }).catch(() => issues.push('点头像堆没有弹出列表'))
      const greenRow = tab.locator(`[data-testid=collab-list] [data-peer="${GREEN.id}"]`)
      if (!(await greenRow.locator('[data-testid=collab-active]').isVisible().catch(() => false))) issues.push('名单里 Green 应写着「正在编辑」')
      const jump = greenRow.locator('[data-testid=collab-jump]')
      const target = await jump.boundingBox().catch(() => null)
      const coarse = await tab.evaluate(() => matchMedia('(pointer: coarse)').matches)
      if (coarse && target && target.height < 43.5) issues.push(`名单里这一行触屏可点高度不足 44px:${Math.round(target.height)}`)
      if (!(await jump.getAttribute('aria-label').catch(() => null))?.includes('Green')) issues.push('跳转按钮缺少带名字的 aria-label')
      // 我自己的行不是按钮
      if (await tab.locator('[data-testid=collab-list] [data-peer] [data-testid=collab-jump]').count() !== 2) issues.push('名单里应只有别人的 2 行是跳转按钮,我自己那行不是')
      // Bob 还没有光标:点了不关名单,说明一句
      await tab.locator(`[data-testid=collab-list] [data-peer="${BOB.id}"] [data-testid=collab-jump]`).click()
      if (!(await tab.locator('[data-testid=collab-list] .kb-clist-hint').isVisible().catch(() => false))) issues.push('对方还没有光标时应在名单里说明,而不是点了没反应')
      if (!(await tab.locator('[data-testid=collab-list]').isVisible().catch(() => false))) issues.push('对方没有光标时不该关掉名单')
      // 点 Green:关掉名单,名牌重新亮出来(is-revealing),他的光标在视野里
      await jump.click()
      await tab.waitForSelector('[data-testid=collab-list]', { state: 'detached', timeout: 3000 }).catch(() => issues.push('跳转后应关掉名单'))
      await tab.locator('.kb-dp .is-revealing').waitFor({ timeout: 3000 }).catch(() => issues.push('跳转后文档应进入「名牌重新亮出」状态(is-revealing)'))
      const seen = await tab.evaluate(() => {
        const cursor = document.querySelector('.kb-dp .kb-cursor')
        const r = cursor?.getBoundingClientRect()
        const label = cursor?.querySelector('.kb-cursor-label')
        return r && { top: r.top, bottom: r.bottom, vh: innerHeight, label: label ? getComputedStyle(label).visibility : null }
      })
      if (!seen) issues.push('文档里没有画出 Green 的光标')
      else {
        if (seen.bottom < 0 || seen.top > seen.vh) issues.push(`跳转后 Green 的光标不在视野里:${Math.round(seen.top)}~${Math.round(seen.bottom)} / ${seen.vh}`)
        if (seen.label !== 'visible') issues.push('跳转后名牌应是显示的')
      }
      // 不动了:几秒后灯熄灭
      await tab.waitForTimeout(3600)
      if (await tab.locator(`[data-testid=collab-peers] [data-peer="${GREEN.id}"][data-active]`).count()) issues.push('光标不动 3 秒后头像上的点应熄灭')
      issues.push(...(await barFits(tab, size)))
      return issues
    },
  },

  'collab-cursor-edge': {
    // 对方的光标在一整行的最右端、名字又很长:名牌不能伸出屏幕或被裁掉(名牌向右展开,10em 宽,靠右的光标会超出)
    route: DOC,
    ready: '[data-testid=doc-share]',
    fixture: collabFixture({ room: { markdown: '这是一段很长很长的正文用来撑满整行然后换行继续写下去直到超过一行的宽度为止。'.repeat(6) } }),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      await startEditing(tab)
      await waitStatus(tab, 'synced')
      await tab.locator(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) p').first().waitFor({ timeout: 8000 })
      // 算出第一行最后一个字之后的位置:光标放在那里,就在这一行的最右端
      const at = await tab.evaluate(() => {
        const node = document.querySelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror) p')?.firstChild
        if (!node) return 0
        const range = document.createRange()
        let top = null
        let last = 0
        for (let i = 1; i <= node.length; i += 1) {
          range.setStart(node, i - 1)
          range.setEnd(node, i)
          const rect = range.getClientRects()[0]
          if (!rect) continue
          if (top === null) top = rect.top
          if (Math.abs(rect.top - top) < 2) last = i
          else break
        }
        return last
      })
      if (at < 5) return ['没能算出第一行的行尾位置']
      // 放在行尾前一个字:正好在折行点上的光标会被浏览器画到下一行的行首,测不到最右端
      roomOf(tab).addPeer({ id: 'usr_long_1', name: '一个名字特别特别长的同事' }, { cursor: { at: at - 1 } })
      await tab.locator('.kb-dp .kb-cursor').first().waitFor({ timeout: 8000 })
      await tab.waitForTimeout(300)
      // 光标元素不接收指针事件,不能用 elementFromPoint 判断有没有被盖住;直接比名牌和文档区、屏幕的边界
      const label = await tab.evaluate(() => {
        const el = document.querySelector('.kb-dp .kb-cursor-label')
        const r = el?.getBoundingClientRect()
        const doc = document.querySelector(':is(.kb-doc, .kb-text-surface)')?.getBoundingClientRect()
        if (!el || !r || !doc) return null
        return { left: r.left, right: r.right, docLeft: doc.left, docRight: doc.right, vw: innerWidth, flipped: !!el.parentElement?.classList.contains('is-flip') }
      })
      if (!label) return ['找不到名牌']
      if (label.left < Math.max(0, label.docLeft) - 0.5) issues.push(`名牌伸出文档区左侧:${Math.round(label.left)} / ${Math.round(label.docLeft)}`)
      if (label.right > label.vw + 0.5) issues.push(`名牌伸出屏幕右侧:${Math.round(label.right)} / ${label.vw}`)
      if (label.right > label.docRight + 0.5) issues.push(`名牌伸出文档区右侧:${Math.round(label.right)} / ${Math.round(label.docRight)}`)
      return issues
    },
  },

  'collab-notice': {
    // 刚改完就被降成只读:服务端丢掉了这笔修改,本地换成最新内容。这句「没有保存」以前没有任何界面显示,是静默的。
    // 提示必须在编辑器因换代而重建之后还在、是警告(role=alert)、不超出屏幕、能点掉
    route: DOC,
    ready: '[data-testid=doc-share]',
    fixture: collabFixture(),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      await startEditing(tab)
      await waitStatus(tab, 'synced')
      await tab.locator(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)').click()
      await tab.keyboard.press('Control+End')
      await tab.keyboard.type(' 马上要丢的一句')
      const control = roomOf(tab)
      control.writable = false
      control.room.setWritable(control.mine, false)
      const notices = tab.locator('[data-testid=collab-notices]')
      await notices.waitFor({ timeout: 8000 }).catch(() => issues.push('降权后没有出现任何提示'))
      const text = (await notices.innerText().catch(() => '')) || ''
      if (!text.includes('没有保存')) issues.push(`提示里没有说明修改没保存:${text}`)
      if ((await tab.locator('[data-testid=collab-notices] [role=alert]').count()) === 0) issues.push('丢了修改的提示应是警告(role=alert)')
      const box = await notices.boundingBox().catch(() => null)
      if (box && (box.x < -1 || box.x + box.width > size.width + 1)) issues.push(`提示超出屏幕 ${Math.round(box.x)}~${Math.round(box.x + box.width)} / ${size.width}`)
      // 等一会儿(超过普通提示的自动收起时间)警告也不能自己消失
      await tab.waitForTimeout(9000)
      if (!(await notices.isVisible().catch(() => false))) issues.push('警告提示不该自己消失,丢了修改的话必须用户看过')
      const dismiss = tab.locator('[data-testid=collab-notices] button', { hasText: '知道了' }).first()
      const target = await dismiss.boundingBox().catch(() => null)
      const coarse = await tab.evaluate(() => matchMedia('(pointer: coarse)').matches)
      if (coarse && target && (target.width < 43.5 || target.height < 43.5)) issues.push(`「知道了」触屏可点区域不足 44px:${Math.round(target.width)}×${Math.round(target.height)}`)
      await dismiss.click().catch(() => issues.push('找不到「知道了」按钮'))
      if (await notices.isVisible().catch(() => false)) {
        const left = (await notices.innerText().catch(() => '')) || ''
        if (left.includes('没有保存')) issues.push('点「知道了」后这条提示应消失')
      }
      issues.push(...(await barFits(tab, size)))
      return issues
    },
  },

  'collab-handshake-refused': {
    // 一直连不上(握手被拒):说清楚在重试、改动留在本页,不是白屏也不是静默
    route: DOC,
    ready: '[data-testid=doc-share]',
    fixture: { __after: async (context) => {
      await installShareApi(context, {})
      await installCollab(context, {})
      roomOf({ context: () => context }).refuse = true
    } },
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      await startEditing(tab)
      await waitStatus(tab, 'offline', 15_000).catch(() => issues.push('握手被拒时应显示离线'))
      // 握手连续失败第 2 次时前端会探一次文档还在不在:还在就继续重试,不存在 / 没权限才会终止并换成别的提示。
      // 等到第 3 次重连(已经过了探测)再看,断言的才是探测之后的稳定状态;不然只是赶在探测之前采样,过不过看机器忙不忙
      await tab
        .waitForFunction(() => /第 [3-9] 次重连/.test(document.querySelector('[data-testid=collab-status]')?.textContent ?? ''), null, { timeout: 15_000 })
        .catch(() => issues.push('握手被拒后应一直重试(至少到第 3 次),实际提前停了'))
      if ((await statusOf(tab)) !== 'offline') issues.push(`握手被拒时应保持离线重试,实际 ${await statusOf(tab)}`)
      const text = await textOf(tab)
      if (!/连不上|重试|重连/.test(text)) issues.push(`没有说明连不上 / 在重试:${text}`)
      if (await editable(tab)) issues.push('没连上时编辑器不应可编辑(输入会被丢掉)')
      issues.push(...(await barFits(tab, size)))
      return issues
    },
  },
}
