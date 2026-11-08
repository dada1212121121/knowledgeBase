// F3 分享与协作的 Playwright 场景:由 viewer-shots.mjs 引入,在设备矩阵 × 引擎(Chromium / WebKit)下跑。
// 约定同其它场景文件:assert 返回问题数组(空 = 通过);假接口来自 share-fixture.mjs(有状态:点一下数据真的变)。
import { ALL_FEATURES, NOW, adminMe } from './fixture.mjs'
import { SOLO_EDIT_FIXTURE } from './editor-helpers.mjs'
import { linkRoomFixture, linkRoomOf } from './link-room.mjs'
import { PEOPLE, keyOf, makeLink, shareFixture, shareLog } from './share-fixture.mjs'

const DAY = 86_400_000
const COLLECTION = 'knowledgeBase%2Finsights'
const DOC = `/kb?collection=${COLLECTION}&item=ins_8f21`

/** 笔记 ins_8f21 的资源(Browser 里当前打开的那篇) */
export const NOTE = { kind: 'insight', collection: 'knowledgeBase/insights', id: 'ins_8f21' }

/** 面板里最宽的内容有没有超出面板(横向滚动 / 溢出) */
export const overflowOf = (tab, selector) =>
  tab.evaluate((sel) => {
    const root = document.querySelector(sel)
    if (!root) return { missing: true }
    const box = root.getBoundingClientRect()
    const bad = []
    for (const el of root.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const style = getComputedStyle(el)
      if (style.position === 'fixed' || style.visibility === 'hidden') continue
      if (r.right > box.right + 1 || r.left < box.left - 1) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} ${Math.round(r.left)}-${Math.round(r.right)} 超出 ${Math.round(box.left)}-${Math.round(box.right)}`)
    }
    return { missing: false, scrollW: root.scrollWidth, clientW: root.clientWidth, bad: bad.slice(0, 3) }
  }, selector)

/**
 * 这个浏览器当前是不是触屏输入(pointer: coarse)。项目的规矩是按输入方式判断可点区域,不按屏幕宽度;
 * 同一个尺寸在 Chromium(hasTouch → coarse)和 WebKit(可能仍是 fine)下结论可能不同,所以问浏览器,不猜。
 */
const isCoarse = (tab) => tab.evaluate(() => window.matchMedia('(pointer: coarse)').matches)

/**
 * 触屏上这些控件的可点区域要 ≥ 44px。可点区域 = 元素自己的框和它 ::before 伪元素(绝对定位外扩)的并集,
 * 项目里的小按钮 / 开关就是这样把 36px、16px 的视觉撑到 44px 的(见 device.css)。
 * 输入框被 <label> 包着时,可点区域还要并上 label 的框。
 */
export async function smallTargets(tab, selector) {
  return tab.evaluate((sel) => {
    const out = []
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      let width = r.width
      let height = r.height
      const before = getComputedStyle(el, '::before')
      if (before.content !== 'none' && before.position === 'absolute') {
        width = Math.max(width, Number.parseFloat(before.width) || 0)
        height = Math.max(height, Number.parseFloat(before.height) || 0)
      }
      // 被 <label> 包着的输入框:点 label 的任何位置都等于点输入框(浏览器把点击转给它),可点区域取 label 的框。
      // 搜索页手机上的搜索条就是这样:44px 高的 label 里放 36px 高的输入框(实测点输入框上下各 3px 处都能聚焦)
      // (label 里还有别的按钮 / 链接 / 输入框时,点 label 不一定转给它,不算)
      if (el.matches('input, select, textarea')) {
        const label = el.closest('label')
        if (label && label.querySelectorAll('input:not([type=hidden]), select, textarea, button, a[href]').length === 1) {
          const l = label.getBoundingClientRect()
          width = Math.max(width, l.width)
          height = Math.max(height, l.height)
        }
      }
      if (height < 43.5 || width < 43.5) out.push(`${(el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 14)} ${Math.round(width)}×${Math.round(height)}`)
    }
    return out
  }, selector)
}

/**
 * 等元素的矩形(位置 + 尺寸)连续两次相同再返回。
 * 为什么不用固定延时:弹层挂上后 Vue 隔两帧才摘掉 enter-from(KbDialog 起始是 scale(.9),手机底部弹层起始在屏幕下方),
 * 机器忙时帧会被推迟,这段时间量到的是 44px × 0.9 ≈ 40px 的中间值,「触屏可点区域不足」就这样偶发。
 * 两次采样之间隔 3 帧(比摘类需要的 2 帧多一帧),所以第二次一定落在摘类之后;用帧而不是毫秒,是因为
 * 主线程被饿住时两次 evaluate 可能背靠背执行、中间一帧都没渲染。超时仍不稳定就返回 stable: false,由调用方报问题,不硬量。
 */
export function settledRect(tab, selector, { samples = 80 } = {}) {
  return tab.evaluate(
    async ([sel, max]) => {
      const frames = (count) =>
        new Promise((resolve) => {
          let left = count
          const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step))
          requestAnimationFrame(step)
        })
      const read = () => {
        const r = document.querySelector(sel)?.getBoundingClientRect()
        return r ? [r.left, r.top, r.width, r.height] : null
      }
      let last = read()
      for (let i = 0; i < max; i += 1) {
        await frames(3)
        const next = read()
        if (next && last && next.every((value, index) => value === last[index])) return { rect: { left: next[0], top: next[1], right: next[0] + next[2], bottom: next[1] + next[3] }, stable: true }
        last = next
      }
      return { rect: last ? { left: last[0], top: last[1], right: last[0] + last[2], bottom: last[1] + last[3] } : null, stable: false }
    },
    [selector, samples],
  )
}

/** 面板整体没有超出屏幕(手机底部弹层 / 电脑对话框),并且可以滚动到底部的「完成」 */
async function panelFits(tab, size) {
  const issues = []
  // 先等弹层的位置和尺寸稳定(进场动画走完)再量,后面各场景量触屏可点区域也都在这之后
  const { rect: box, stable } = await settledRect(tab, '[role=dialog]:has([data-testid=share-panel])')
  if (!box) return ['没有找到分享面板']
  if (!stable) issues.push('分享面板的位置或尺寸一直在变,进场动画没有结束')
  if (box.left < -1 || box.right > size.width + 1) issues.push(`面板横向超出屏幕 ${Math.round(box.left)}~${Math.round(box.right)} / ${size.width}`)
  if (box.top < -1 || box.bottom > size.height + 1) issues.push(`面板纵向超出屏幕 ${Math.round(box.top)}~${Math.round(box.bottom)} / ${size.height}`)
  const inner = await overflowOf(tab, '[data-testid=share-panel]')
  if (inner.missing) issues.push('面板内容区丢了')
  else {
    if (inner.scrollW > inner.clientW + 1) issues.push(`面板内容横向滚动 ${inner.scrollW} > ${inner.clientW}`)
    if (inner.bad.length) issues.push(`面板里有元素超出:${inner.bad.join(';')}`)
  }
  return issues
}

const openPanel = async (tab) => {
  await tab.locator('[data-testid=doc-share]').click()
  await tab.waitForSelector('[data-testid=share-panel]')
}

// ---------------------------------------------------------------- 共享给我的样例数据
const sharedRoot = (owner, space, title, role, target, extra = {}) => ({
  target: { space_id: space, collection: '_global', ...target },
  key: `shared:${space}:${title}`,
  title,
  role,
  owner,
  shared_at: NOW - DAY,
  expires_at: null,
  hidden: false,
  ...extra,
})
// 最近分享的在前:Bob 最近(2 小时前),张三的依次是 1 天、2 天、3 天前
export const SHARED_ITEMS = [
  sharedRoot(PEOPLE.zhangsan, 'sp_alice', '部署清单', 'viewer', { kind: 'insight', id: 'ins_s1' }, { shared_at: NOW - DAY }),
  sharedRoot(PEOPLE.zhangsan, 'sp_alice', 'docs', 'editor', { kind: 'dir', path: 'docs' }, { shared_at: NOW - 2 * DAY }),
  sharedRoot(PEOPLE.zhangsan, 'sp_alice', 'guide.md', 'commenter', { kind: 'file', path: 'guide.md' }, { shared_at: NOW - 3 * DAY }),
  sharedRoot(PEOPLE.bob, 'sp_bob', 'Bob 的周报', 'editor', { kind: 'insight', id: 'ins_b1' }, { expires_at: NOW + 20 * DAY, shared_at: NOW - 2 * 3_600_000 }),
]
export const SHARED_SPACES = {
  sp_alice: {
    notes: { ins_s1: { title: '部署清单', text: '## 发布前\n\n先备份数据库,再跑冒烟测试。', tags: ['运维'], version: 1 } },
    files: {
      'guide.md': { content: '# 使用指南\n\n第一步……', editable: true, version: 2 },
      'docs/runbook.md': { content: '# 运维手册\n\n重启前先摘流量。', editable: true, version: 3 },
      'docs/ops/restart.md': { content: '# 重启\n\n步骤……', editable: true, version: 1 },
      // 代码文件:只读查看器(CodeEditor)顶上有「查找」「换行」小按钮;Markdown 走渲染器,没有这两个按钮
      'scripts/restart.sh': { content: '#!/bin/sh\nset -e\nsystemctl restart kb\n', editable: false, version: 1 },
    },
    // 同一个文件有多个块(c1、c2),列表里只该出现一次
    rows: [
      { id: 'c1', collection: '_global', kind: 'doc', source: 'docs/runbook.md', title: null, symbol: null, updated_at: NOW - 7_200_000 },
      { id: 'c2', collection: '_global', kind: 'doc', source: 'docs/runbook.md', title: null, symbol: null, updated_at: NOW - 7_200_000 },
      { id: 'c3', collection: '_global', kind: 'doc', source: 'docs/ops/restart.md', title: null, symbol: null, updated_at: NOW - 86_400_000 },
    ],
    comments: { 'guide.md': [{ id: 'an0', body: '第一步需要补充截图', author: 'guest:小王#3fa9c1', created_at: NOW - 5 * 60_000 }] },
  },
  sp_bob: { notes: { ins_b1: { title: 'Bob 的周报', text: '本周做了三件事。', tags: [], version: 4 } }, files: {}, rows: [], comments: {} },
}


// ---------------------------------------------------------------- 共享给我的场景用的小工具
const sharedFixture = (extra = {}, base = {}) => shareFixture({ sharedWithMe: structuredClone(SHARED_ITEMS), spaces: structuredClone(SHARED_SPACES), ...extra }, base)
const SHARED_ROUTE = `/kb?collection=${COLLECTION}`

/** 切到「共享给我」 */
async function switchToShared(tab) {
  await tab.locator('[data-testid=scope-switch] [role=tab]', { hasText: '共享给我' }).click()
  await tab.waitForSelector('[data-testid=shared-sidebar]')
}
/** 窄屏上列表 / 详情二选一:点返回直到看到侧栏列表 */
async function toSharedList(tab) {
  for (let step = 0; step < 4; step += 1) {
    if (await tab.locator('[data-testid=shared-sidebar]').isVisible()) return
    const back = tab.locator('[data-testid=shared-back]')
    if (!(await back.isVisible())) return
    await back.click()
    await tab.waitForTimeout(80)
  }
}
async function openSharedItem(tab, title) {
  await toSharedList(tab)
  await tab.locator(`[data-testid="shared-item-${title}"]`).click()
  await tab.waitForSelector('[data-testid=shared-workspace]')
}
/** 页面上有没有横向溢出(工作区 + 整页) */
async function sharedFits(tab, label) {
  const issues = []
  const page = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  if (page > 1) issues.push(`${label}:整页横向溢出 ${page}px`)
  const ws = await overflowOf(tab, '[data-testid=shared-workspace]')
  if (!ws.missing && ws.scrollW > ws.clientW + 1) issues.push(`${label}:共享工作区横向滚动 ${ws.scrollW} > ${ws.clientW}`)
  if (!ws.missing && ws.bad.length) issues.push(`${label}:工作区里有元素超出 ${ws.bad.join(';')}`)
  return issues
}
/** 记下不带 X-KB-Space 的 get_item(那是在读我自己的知识库,打开别人的内容时不该出现) */
function watchOwnReads(tab) {
  const own = []
  tab.on('request', (request) => {
    if (!request.url().includes('/capabilities/get_item') && !request.url().includes('/capabilities/file_preview')) return
    if (!request.headers()['x-kb-space']) own.push(request.postData())
  })
  return own
}


// ---------------------------------------------------------------- 我的分享页的样例数据
const mineTarget = (kind, extra) => ({ kind, space_id: 'sp_admin', collection: '_global', ...extra })
const MINE = [
  { target: mineTarget('dir', { path: '运维' }), key: 'dir:sp_admin/_global/%E8%BF%90%E7%BB%B4', title: '运维', inherit_broken: false, grantees: [{ user: PEOPLE.bob, role: 'editor' }, { user: PEOPLE.carol, role: 'viewer' }] },
  { target: mineTarget('insight', { id: 'ins_9' }), key: 'doc:sp_admin/_global/i/ins_9', title: '部署清单', inherit_broken: true, grantees: [{ user: PEOPLE.bob, role: 'viewer' }] },
  { target: mineTarget('file', { path: 'docs/guide.md' }), key: 'doc:sp_admin/_global/f/docs/guide.md', title: 'guide.md', inherit_broken: false, grantees: [{ user: PEOPLE.lisi, role: 'commenter' }, { user: PEOPLE.zhangsan, role: 'viewer' }, { user: PEOPLE.wangwu, role: 'viewer' }] },
]
const MINE_LINKS = [
  { target: MINE[0].target, link: makeLink('l1', MINE[0].target, { audience: 'logged_in', role: 'viewer', views: 23, last_view_at: NOW - 600_000, title: '运维' }) },
  { target: MINE[1].target, link: makeLink('l2', MINE[1].target, { audience: 'anyone', role: 'commenter', has_password: true, expires_at: NOW + 7 * DAY, title: '部署清单' }) },
  { target: MINE[0].target, link: makeLink('l3', MINE[0].target, { bundle: true, roots: [MINE[0].target, MINE[1].target], title: '本周评审', audience: 'logged_in', views: 2 }) },
]
const minePage = (extra = {}, base = {}) => shareFixture({ sharedByMe: structuredClone(MINE), links: structuredClone(MINE_LINKS), ...extra }, base)

/** 从外壳的导航点进某个页面(客户端路由,页面从头加载——这样才看得到加载中的骨架屏)。标签栏形态要经「我的」页。 */
async function viaNav(tab, navId) {
  if (await tab.locator('.kb-tabbar').isVisible()) {
    await tab.locator('.kb-tabbar [data-tab=mine]').click()
    await tab.waitForSelector('[data-testid=mine]')
    await tab.locator(`[data-testid=mine] [data-nav-id=${navId}]`).click()
  } else {
    await tab.locator(`[data-nav-id=${navId}]`).first().click()
  }
}

/** 选中表格里指定的几行:桌面点复选框;手机是卡片,先点「选择」再点卡片 */
async function pickRows(tab, size, pane, names) {
  if (size.width < 600) {
    const tools = tab.locator(`[data-testid=${pane}] .kb-rt-toggle`)
    if ((await tools.innerText()).trim() === '选择') await tools.click()
    for (const name of names) await tab.locator(`[data-testid=${pane}] [data-testid=rt-card]`, { hasText: name }).click()
  } else {
    for (const name of names) await tab.locator(`[data-testid=${pane}] [data-testid=rt-row]`, { hasText: name }).locator('input[type=checkbox]').check()
  }
}

// ---------------------------------------------------------------- 访问申请的样例数据
const request = (id, who, role, target, extra = {}) => ({ id, key: `k_${id}`, target, title: '', requester: who, role, message: null, state: 'pending', created_at: NOW - 10 * 60_000, decided_at: null, ...extra })
const NOTE_REQ = mineTarget('insight', { id: 'ins_9' })
const DIR_REQ = mineTarget('dir', { path: '运维' })
const REQUESTS = {
  to_decide: [
    request('r1', PEOPLE.bob, 'editor', NOTE_REQ, { title: '部署清单', message: '想补充回滚步骤' }),
    request('r2', PEOPLE.carol, 'viewer', DIR_REQ, { title: '运维', created_at: NOW - 3 * 3_600_000 }),
  ],
  mine: [
    request('m1', PEOPLE.admin, 'editor', mineTarget('insight', { id: 'ins_x' }), { title: 'Alice 的设计稿' }),
    request('m2', PEOPLE.admin, 'commenter', mineTarget('file', { path: 'a.md' }), { title: 'a.md', state: 'approved', decided_at: NOW - 3_600_000 }),
    request('m3', PEOPLE.admin, 'viewer', mineTarget('dir', { path: 'docs' }), { title: 'docs', state: 'rejected', decided_at: NOW - 2 * 3_600_000 }),
  ],
}

// ---------------------------------------------------------------- 公开分享页的样例数据
const pubTarget = (kind, extra) => ({ kind, space_id: 'sp_alice', collection: '_global', ...extra })
const T_NOTE = pubTarget('insight', { id: 'ins_s1' })
const T_EDIT = pubTarget('insight', { id: 'ins_p1' })
const T_STALE = pubTarget('insight', { id: 'ins_p2' })
const T_GUIDE = pubTarget('file', { path: 'guide.md' })
const T_DOCS = pubTarget('dir', { path: 'docs' })
const T_CODE = pubTarget('file', { path: 'scripts/restart.sh' })
const PUBLIC_SPACES = {
  sp_alice: {
    ...SHARED_SPACES.sp_alice,
    notes: {
      ...SHARED_SPACES.sp_alice.notes,
      ins_p1: { title: '共同编辑的笔记', text: '第一段。', tags: [], version: 1 },
      // 已经被改过几次(版本 3)的笔记:通过链接保存时拿不到版本,会撞上冲突(后端缺口,见汇报)
      ins_p2: { title: '改过很多次的笔记', text: '旧内容。', tags: [], version: 3 },
    },
  },
}
const gone = (status, code, message) => ({ error: { status, code, message }, space: 'sp_alice', roots: [T_NOTE] })
const PUBLIC_LINKS = {
  tokView: { space: 'sp_alice', roots: [T_NOTE], role: 'viewer', title: '部署清单' },
  tokEdit: { space: 'sp_alice', roots: [T_EDIT], role: 'editor', title: '共同编辑的笔记' },
  tokStale: { space: 'sp_alice', roots: [T_STALE], role: 'editor', title: '改过很多次的笔记' },
  tokGuide: { space: 'sp_alice', roots: [T_GUIDE], role: 'commenter', title: 'guide.md' },
  tokFolder: { space: 'sp_alice', roots: [T_DOCS], role: 'viewer', title: 'docs' },
  tokBundle: { space: 'sp_alice', roots: [T_NOTE, T_DOCS, T_GUIDE], bundle: true, role: 'viewer', title: '本周评审' },
  tokSecret: { space: 'sp_alice', roots: [T_NOTE], role: 'viewer', title: '部署清单', password: 'sesame1' },
  tokLock: { space: 'sp_alice', roots: [T_NOTE], role: 'viewer', title: '部署清单', password: 'sesame1', lockAfter: 3 },
  tokCode: { space: 'sp_alice', roots: [T_CODE], role: 'viewer', title: 'restart.sh', allow_download: false },
  tokNoDl: { space: 'sp_alice', roots: [T_GUIDE], role: 'viewer', title: 'guide.md', allow_download: false, watermark: '访客 · 2026-10-28 16:00' },
  tokUser: { space: 'sp_alice', roots: [T_EDIT], role: 'editor', title: '共同编辑的笔记', visitor: { kind: 'user', id: 'usr_me', username: 'me', display_name: '我' }, audience: 'logged_in' },
  tokExpired: gone(410, 'link_expired', '这个链接已过期'),
  tokClosed: gone(410, 'link_closed', '所有者关闭了这个链接'),
  tokRevoked: gone(410, 'link_revoked', '这个链接已被撤销'),
  tokUnavail: gone(410, 'link_unavailable', '这个链接暂时不可用'),
  tokLogin: gone(401, 'login_required', '这个链接需要登录后访问'),
  tokGuestsOff: gone(403, 'guests_disabled', '管理员暂时关闭了游客访问'),
  tokNoAccess: gone(403, 'no_access', '你没有权限访问这个内容,可以向所有者申请'),
  tokRate: gone(429, 'rate_limited', '请求太频繁,请稍后再试'),
}
export const publicPage = (extra = {}, base = {}) => shareFixture({ publicLinks: structuredClone(PUBLIC_LINKS), spaces: structuredClone(PUBLIC_SPACES), ...extra }, base)
/**
 * 公开页「编辑」要用的夹具:链接访问者编辑笔记走多人在线编辑(游客也是),要有接上链接的假房间,见 link-room.mjs。
 * 房间对应 sp_alice 的笔记 noteId;正文落地后 get_item 读到新内容。
 */
const publicEditPage = (noteId, extra = {}) =>
  linkRoomFixture({ publicLinks: structuredClone(PUBLIC_LINKS), spaces: structuredClone(PUBLIC_SPACES), ...extra }, { space: 'sp_alice', noteId })
/** 整页横向溢出(返回问题数组,空 = 没问题) */
const overflowIssues = async (tab) => {
  const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  return overflow > 1 ? [`整页横向溢出 ${overflow}px`] : []
}
/** 等协作连上(状态条 data-status=synced),编辑器可输入 */
async function waitCollabSynced(tab) {
  await tab.waitForSelector('[data-testid=collab-bar][data-status=synced]', { timeout: 15_000 })
  await tab.waitForSelector('[data-testid=shared-doc-editor] .ProseMirror[contenteditable=true]', { timeout: 15_000 })
}
/** 记下公开页发出的、不该有的账号接口请求(公开页是独立页面,不能碰登录相关的接口) */
function watchAccountCalls(tab) {
  const calls = []
  tab.on('request', (request) => {
    if (/\/api\/v1\/(capabilities\/|auth\/me|me\/|auth\/status)/.test(request.url())) calls.push(new URL(request.url()).pathname)
  })
  return calls
}
/** 页面里有没有统一外壳的东西(公开页不该有) */
const shellParts = (tab) => tab.evaluate(() => ['.kb-nav', '.kb-topbar', '[data-testid=tabbar]', '.kb-agent-widget'].filter((sel) => document.querySelector(sel)))

/** 文件夹视图默认打开「目录」树(收起的);平铺的文件行在「列表」页签里。进文件夹后切过去再等行出现 */
const showFolderList = async (tab) => {
  await tab.waitForSelector('[data-testid=view-flat]') // 先出骨架屏,等文件夹真的出来
  await tab.locator('[data-testid=view-flat]').click()
  await tab.waitForSelector('[data-testid^="shared-row-"]')
}

export const SHARE_SCENARIOS = {
  'share-panel-people': {
    // 分享面板 · 协作者页:好友捷径添加、改角色、移除、继承来源与停止继承、完整用户名精确查找;手机是底部弹层、电脑是对话框
    route: DOC,
    ready: '[data-testid=doc-share]',
    fixture: shareFixture({
      grants: [{ target: NOTE, user: PEOPLE.bob, role: 'editor' }, { target: NOTE, user: PEOPLE.carol, role: 'viewer', via: 'link:lnk_1' }, { target: NOTE, user: PEOPLE.wangwu, role: 'viewer' }],
      inherited: [{ user: PEOPLE.zhangsan, role: 'viewer', source: 'dir:sp_x/_global/%E8%BF%90%E7%BB%B4' }],
    }),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      await openPanel(tab)
      await tab.waitForSelector('[data-testid=share-owner]')
      const kind = await tab.evaluate(() => (document.querySelector('[data-testid=share-panel]')?.closest('[data-testid=sheet]') ? 'sheet' : 'dialog'))
      if (size.width < 600 && kind !== 'sheet') issues.push(`手机应是底部弹层,实际 ${kind}`)
      if (size.width >= 600 && kind !== 'dialog') issues.push(`${size.width} 宽应是对话框,实际 ${kind}`)
      issues.push(...(await panelFits(tab, size)))
      // 触屏可点区域要在面板刚打开时量:此时好友快捷按钮(chip)还在屏幕上,选了人以后它们就收起来了
      if (await isCoarse(tab)) {
        const early = await smallTargets(tab, '[data-testid=share-panel] .kb-share-chip, [data-testid=share-panel] button, [data-testid=share-panel] [role=switch], [data-testid=share-panel] .kb-select button')
        if (early.length) issues.push(`触屏可点区域不足 44px(面板刚打开时):${early.slice(0, 4).join('、')}`)
      }

      const text = await tab.locator('[data-testid=share-panel]').innerText()
      for (const word of ['管理员', '所有者', 'Bob', '可编辑', 'Carol', '通过链接加入', '张三', '继承自 文件夹「运维」']) if (!text.includes(word)) issues.push(`协作者页缺少「${word}」`)
      // 继承来的不能改、没有移除
      if (await tab.locator('[data-testid=share-row-zhangsan] button').count()) issues.push('继承来的协作者不该有移除按钮')
      // 好友捷径里不再有已经直接授权的人(王五);没添加的(李四)和只是继承来的(张三,还可以直接给更高的角色)仍在
      if (!(await tab.locator('[data-testid=share-friend-lisi]').count())) issues.push('好友捷径里应有「李四」')
      if (!(await tab.locator('[data-testid=share-friend-zhangsan]').count())) issues.push('只是继承来的好友仍应出现在捷径里(可以直接授予更高角色)')
      if (await tab.locator('[data-testid=share-friend-wangwu]').count()) issues.push('已直接授权的好友不该再出现在捷径里')

      // 点好友 → 选中 → 添加(默认可查看)
      await tab.locator('[data-testid=share-friend-lisi]').click()
      if (!(await tab.locator('[data-testid=share-picked]').innerText()).includes('老李')) issues.push('选中好友后应显示备注名「老李」')
      await tab.locator('[data-testid=share-add-submit]').click()
      await tab.waitForSelector('[data-testid=share-row-lisi]')
      const log = await shareLog(tab)
      const added = log.find((entry) => entry.name === 'grant_set')
      if (!added || added.args.role !== 'viewer' || added.args.user_id !== PEOPLE.lisi.id || keyOf(added.args.target) !== keyOf(NOTE)) issues.push(`添加好友发出的请求不对:${JSON.stringify(added)}`)

      // 改角色:点 Bob 的角色下拉,选「可评论」
      await tab.locator('[data-testid=share-row-bob] .kb-select button').click()
      await tab.locator('.kb-pop-layer[data-open=true] .kb-pop-item', { hasText: '可评论' }).click()
      await tab.waitForFunction(() => document.querySelector('[data-testid=share-row-bob]')?.textContent?.includes('可评论'))
      // 下拉里没有「所有者」,最高到「可管理」
      await tab.locator('[data-testid=share-row-bob] .kb-select button').click()
      const options = await tab.locator('.kb-pop-layer[data-open=true] .kb-pop-item').allInnerTexts()
      if (options.join('|') !== '可查看|可评论|可编辑|可管理') issues.push(`角色下拉应是 可查看|可评论|可编辑|可管理,实际 ${options.join('|')}`)
      await tab.keyboard.press('Escape')

      // 移除 Carol
      await tab.locator('button[aria-label="移除 Carol"]').click()
      await tab.waitForFunction(() => !document.querySelector('[data-testid=share-row-carol]'))
      // 精确查找:输入完整用户名
      await tab.locator('[data-testid=share-add-input]').fill('nobody')
      await tab.locator('[data-testid=share-lookup]').click()
      await tab.waitForSelector('[data-testid=share-add-error]')
      if (!(await tab.locator('[data-testid=share-add-error]').innerText()).includes('没有找到这个用户')) issues.push('找不到用户时应给出人话')
      await tab.locator('[data-testid=share-add-input]').fill('carol')
      await tab.locator('[data-testid=share-lookup]').click()
      await tab.waitForSelector('[data-testid=share-picked]')
      // 停止继承
      await tab.locator('[data-testid=share-inherit] [role=switch]').click()
      await tab.waitForFunction(() => document.querySelector('[data-testid=share-inherit] [role=switch]')?.getAttribute('aria-checked') === 'true')
      const after = await shareLog(tab)
      if (!after.some((entry) => entry.name === 'set_inherit' && entry.args.inherit === false)) issues.push('停止继承没有发出 set_inherit(inherit:false)')
      if (!after.some((entry) => entry.name === 'grant_remove' && entry.args.user_id === PEOPLE.carol.id)) issues.push('移除没有发出 grant_remove')

      issues.push(...(await panelFits(tab, size)))
      if (await isCoarse(tab)) {
        const small = await smallTargets(tab, '[data-testid=share-panel] button, [data-testid=share-panel] [role=switch], [data-testid=share-panel] .kb-select button')
        if (small.length) issues.push(`触屏可点区域不足 44px:${small.slice(0, 4).join('、')}`)
      }
      // Esc 关闭
      await tab.keyboard.press('Escape')
      await tab.waitForFunction(() => !document.querySelector('[data-testid=share-panel]'))
      return issues
    },
  },

  'share-panel-settle': {
    // 弹层进场被拖慢(机器忙、帧延迟)时,量触屏可点区域必须等尺寸稳定:冻结假时钟,让弹层停在进场起点(KbDialog 的 scale(.9)、
    // 手机底部弹层在屏幕下方),此时直接量会得到 44px × 0.9 ≈ 40px。检查 settledRect 在帧冻住期间不返回、放开后量到的是最终尺寸。
    // 去掉 settledRect 里的等待 → 冻结期间它就返回了,这个场景变红(CPU 压力下复现不了这个偶发,所以用冻结时钟确定性地造出来)。
    route: DOC,
    ready: '[data-testid=doc-share]',
    fixture: shareFixture({ grants: [{ target: NOTE, user: PEOPLE.bob, role: 'editor' }] }),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const dialog = '[role=dialog]:has([data-testid=share-panel])'
      let paused = false
      try {
        await tab.clock.pauseAt((await tab.evaluate(() => Date.now())) + 1000)
        paused = true
        await tab.locator('[data-testid=doc-share]').click()
        await tab.waitForSelector('[data-testid=share-panel]')
        let returned = false
        const settling = settledRect(tab, dialog).then((result) => {
          returned = true
          return result
        })
        await tab.waitForTimeout(300)
        if (returned) issues.push('帧被冻住时 settledRect 不该返回:弹层还在进场,这时量到的是中间尺寸')
        await tab.clock.resume()
        paused = false
        const { stable } = await settling
        if (!stable) issues.push('放开时钟后弹层的位置和尺寸仍在变')
      } finally {
        if (paused) await tab.clock.resume()
      }
      await tab.waitForSelector('[data-testid=share-owner]')
      if (await isCoarse(tab)) {
        const small = await smallTargets(tab, '[data-testid=share-panel] .kb-share-chip, [data-testid=share-panel] button, [data-testid=share-panel] [role=switch], [data-testid=share-panel] .kb-select button')
        if (small.length) issues.push(`进场结束后触屏可点区域不足 44px:${small.slice(0, 4).join('、')}`)
      }
      issues.push(...(await panelFits(tab, size)))
      return issues
    },
  },

  'share-panel-link': {
    // 分享面板 · 链接页:创建 → 完整地址只显示一次(要提醒复制)→ 改设置 → 重置 / 删除要确认
    route: DOC,
    ready: '[data-testid=doc-share]',
    fixture: shareFixture({}),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      await openPanel(tab)
      await tab.locator('[role=tab]', { hasText: '链接分享' }).click()
      await tab.waitForSelector('[data-testid=share-link-create]')
      issues.push(...(await panelFits(tab, size)))
      await tab.locator('[data-testid=share-create-submit]').click()
      await tab.waitForSelector('[data-testid=share-fresh-url]')
      const url = await tab.locator('[data-testid=share-url]').innerText()
      if (!/\/s\/[A-Za-z0-9_-]{22}$/.test(url)) issues.push(`链接地址形状不对:${url}`)
      if (!(await tab.locator('[data-testid=share-fresh-url]').innerText()).includes('只显示这一次')) issues.push('创建后应提醒地址只显示一次')
      issues.push(...(await panelFits(tab, size)))

      // 没复制就点「完成」:先提醒;选「回去复制」不关
      await tab.locator('[data-testid=share-done]').click()
      await tab.waitForSelector('[role=alertdialog]')
      if (!(await tab.locator('[role=alertdialog]').innerText()).includes('链接地址还没复制')) issues.push('关闭前应提醒链接地址还没复制')
      await tab.locator('[role=alertdialog] button', { hasText: '回去复制' }).click()
      await tab.waitForFunction(() => !document.querySelector('[role=alertdialog]'))
      if (!(await tab.locator('[data-testid=share-panel]').count())) issues.push('选「回去复制」后面板不该关闭')

      // 改设置:密码 4–12 位、有效期、关闭下载
      await tab.locator('[data-testid=share-password-switch]').scrollIntoViewIfNeeded()
      await tab.locator('[data-testid=share-password-switch]').click()
      await tab.locator('[data-testid=share-password-row] input').fill('ab')
      await tab.locator('[data-testid=share-password-save]').click()
      if (!(await tab.locator('[data-testid=share-password-error]').innerText()).includes('4–12')) issues.push('密码太短应提示 4–12 位')
      await tab.locator('[data-testid=share-password-row] input').fill('sesame1')
      await tab.locator('[data-testid=share-password-save]').click()
      await tab.waitForFunction(() => document.querySelector('[data-testid=share-password-switch]')?.getAttribute('aria-checked') === 'true' && !document.querySelector('[data-testid=share-password-row] input')?.value)
      await tab.locator('[data-testid=share-download]').click()
      await tab.waitForFunction(() => document.querySelector('[data-testid=share-download]')?.getAttribute('aria-checked') === 'false')
      await tab.locator('[data-testid=share-expiry] button').click()
      await tab.locator('.kb-pop-layer[data-open=true] .kb-pop-item', { hasText: '7 天' }).click()
      await tab.waitForFunction(() => document.querySelector('[data-testid=share-panel]')?.textContent?.includes('有效期至'))
      const log = await shareLog(tab)
      const update = (field) => log.find((entry) => entry.name === 'link_update' && entry.args[field] !== undefined)
      if (update('password')?.args.password !== 'sesame1') issues.push('设置密码没有发出 link_update(password)')
      if (update('allow_download')?.args.allow_download !== false) issues.push('关闭下载没有发出 link_update(allow_download:false)')
      if (update('expires_days')?.args.expires_days !== 7) issues.push('选 7 天没有发出 link_update(expires_days:7)')
      if (log.some((entry) => JSON.stringify(entry.args).includes('allow_reshare'))) issues.push('界面不该提供 allow_reshare')
      issues.push(...(await panelFits(tab, size)))

      // 重置:确认框写明后果,确认后拿到新地址
      await tab.locator('[data-testid=share-fresh-url]').waitFor({ state: 'visible' })
      await tab.locator('.kb-share-actions button', { hasText: '重置链接' }).click()
      await tab.waitForSelector('[role=alertdialog]')
      if (!(await tab.locator('[role=alertdialog]').innerText()).includes('旧地址立刻打不开')) issues.push('重置确认框应写明旧地址立刻失效')
      await tab.locator('[role=alertdialog] button', { hasText: '重置' }).click()
      await tab.waitForFunction((old) => document.querySelector('[data-testid=share-url]')?.textContent !== old, url)
      // 删除链接
      await tab.locator('[data-testid=share-revoke]').click()
      await tab.waitForSelector('[role=alertdialog]')
      const warning = await tab.locator('[role=alertdialog]').innerText()
      if (!warning.includes('永久失效') || !warning.includes('协作者不受影响')) issues.push('删除确认框应写明不可恢复和协作者不受影响')
      await tab.locator('[role=alertdialog] button', { hasText: '删除链接' }).click()
      await tab.waitForSelector('[data-testid=share-link-create]')
      return issues
    },
  },

  'share-panel-states': {
    // 四种状态:加载中(骨架)、报错可重试、无权限、权限不够(可编辑不能添加协作者)
    route: DOC,
    ready: '[data-testid=doc-share]',
    fixture: shareFixture({ delayMs: 600, fail: { grant_list: { status: 500, message: 'internal: boom', times: 1 } } }),
    expectConsole: /status of 500/, // 场景自己模拟的 500
    settle: 400,
    assert: async (tab, size) => {
      const issues = []
      await tab.locator('[data-testid=doc-share]').click()
      await tab.waitForSelector('[data-testid=share-panel] [aria-busy=true]', { timeout: 3000 }).catch(() => issues.push('加载中应显示骨架屏'))
      await tab.waitForSelector('[data-testid=share-error]')
      const failed = await tab.locator('[data-testid=share-error]').innerText()
      if (!failed.includes('没有加载出来')) issues.push('报错状态应说清楚发生了什么')
      if (/boom|500|internal/i.test(failed)) issues.push('报错不该露出英文异常 / 状态码')
      issues.push(...(await panelFits(tab, size)))
      await tab.locator('[data-testid=share-error] button', { hasText: '重试' }).click()
      await tab.waitForSelector('[data-testid=share-owner]')
      if (!(await tab.locator('[data-testid=share-empty]').count())) issues.push('重试成功但没有协作者时应显示空状态')
      return issues
    },
  },

  'share-panel-denied': {
    // 没有权限(后端对看不见的资源回 404):显示无权限,不显示添加框
    route: DOC,
    ready: '[data-testid=doc-share]',
    fixture: shareFixture({ fail: { grant_list: { status: 404, message: 'not found: 没有找到这个内容' }, link_get: { status: 404, message: 'not found: 没有找到这个内容' } } }),
    expectConsole: /status of 404/, // 场景自己模拟的 404
    settle: 400,
    assert: async (tab, size) => {
      const issues = []
      await openPanel(tab)
      await tab.waitForSelector('[data-testid=share-denied]')
      if (await tab.locator('[data-testid=share-add-input]').count()) issues.push('无权限时不该显示添加协作者')
      await tab.locator('[role=tab]', { hasText: '链接分享' }).click()
      await tab.waitForSelector('[data-testid=share-panel] [data-testid=share-denied]:visible')
      issues.push(...(await panelFits(tab, size)))
      return issues
    },
  },

  'share-panel-role-cap': {
    // 我只有「可编辑」:后端对 grant_list / link_get 回 403(需要可管理)——面板显示无权限,并原样说明服务端给的原因
    route: DOC,
    ready: '[data-testid=doc-share]',
    fixture: shareFixture({ myRole: 'editor' }),
    expectConsole: /status of 403/, // 场景自己模拟的 403
    settle: 400,
    assert: async (tab, size) => {
      const issues = []
      await openPanel(tab)
      await tab.waitForSelector('[data-testid=share-denied]')
      const text = await tab.locator('[data-testid=share-denied]').innerText()
      if (!text.includes('「可编辑」') || !text.includes('需要「可管理」')) issues.push(`无权限状态应写明原因(你是可编辑、需要可管理),实际:${text.replace(/\n/g, ' ')}`)
      if (await tab.locator('[data-testid=share-add-input]').count()) issues.push('没有「可管理」不该出现添加协作者的输入框')
      issues.push(...(await panelFits(tab, size)))
      return issues
    },
  },

  'share-entry-tree': {
    // 目录树的集合行有分享入口,点它分享的是整个集合
    route: `/kb?collection=${COLLECTION}`,
    ready: '.kb-sidebar-tab-btn',
    fixture: shareFixture({}),
    settle: 400,
    assert: async (tab, size) => {
      const issues = []
      if (size.width < 1024) {
        // 窄屏:手机是列表 / 详情二选一,600–839 的两栏版面选中文档后目录栏会收起;确保列表在眼前
        const back = tab.locator('[aria-label=返回列表]')
        const dir = tab.locator('[data-testid=dir-toggle]')
        if (await back.isVisible()) await back.click()
        else if (await dir.isVisible()) await dir.click()
      }
      await tab.locator('.kb-sidebar-tab-btn', { hasText: '目录' }).click()
      const row = tab.locator('[role=treeitem]', { hasText: 'knowledgeBase/insights' }).first()
      await row.hover()
      const button = tab.locator('[data-testid="tree-share-knowledgeBase/insights"]')
      await button.waitFor({ state: 'visible' })
      if (!(await button.getAttribute('aria-label'))?.includes('分享集合')) issues.push('集合行的分享按钮缺少 aria-label')
      await button.click()
      await tab.waitForSelector('[data-testid=share-panel]')
      const heading = await tab.evaluate(() => document.querySelector('[data-testid=share-panel]')?.closest('[role=dialog]')?.textContent ?? '')
      if (!heading.includes('分享「knowledgeBase/insights」')) issues.push('标题应写明分享的是哪个集合')
      if (!(await tab.locator('[data-testid=share-folder-note]').innerText()).includes('分享集合后')) issues.push('集合应说明「以后新建的文档自动可见」')
      issues.push(...(await panelFits(tab, size)))
      return issues
    },
  },

  'share-entry-feature': {
    // 没有 collab.share 功能点:文档顶栏和目录树都不出现分享入口
    route: DOC,
    ready: '.kb-workspace-bar',
    fixture: shareFixture({}, { __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => id !== 'collab.share'), true) } }),
    settle: 800,
    assert: async (tab, size) => {
      const issues = []
      if (await tab.locator('[data-testid=doc-share]').count()) issues.push('没有 collab.share 不该显示文档顶栏的分享按钮')
      if (size.width >= 1024) {
        await tab.locator('.kb-sidebar-tab-btn', { hasText: '目录' }).click()
        if (await tab.locator('[data-testid^="tree-share-"]').count()) issues.push('没有 collab.share 不该显示目录树行的分享入口')
      }
      return issues
    },
  },

  'shared-list': {
    // 共享给我:按分享人分组、显示我的角色和到期、空/错误态;多选「移出我的列表」只影响显示,可以放回
    route: SHARED_ROUTE,
    ready: '[data-testid=scope-switch]',
    fixture: sharedFixture(),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      if ((await tab.locator('[data-testid=scope-switch]').innerText()).includes('共享给我 4') === false) issues.push('切换条上应显示共享给我的数量 4')
      await switchToShared(tab)
      await tab.waitForSelector('[data-testid^=shared-group-]')
      const groups = await tab.locator('.kb-ssb-owner-name').allInnerTexts()
      if (groups.join('|') !== 'Bob|张三') issues.push(`应按分享人分成两组且最近分享的 Bob 在前,实际 ${groups.join('|')}`)
      const order = await tab.locator('[data-testid^=shared-item-]').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid').replace('shared-item-', '')))
      if (order.join('|') !== 'Bob 的周报|部署清单|docs|guide.md') issues.push(`列表顺序应是新的在前,实际 ${order.join('|')}`)
      const text = await tab.locator('[data-testid=shared-sidebar]').innerText()
      for (const word of ['部署清单', '可查看', 'docs', '可编辑', 'guide.md', '可评论', 'Bob 的周报', '到期 ']) if (!text.includes(word)) issues.push(`共享列表缺少「${word}」`)
      for (const [title, kindWord] of [['部署清单', '笔记'], ['docs', '文件夹'], ['guide.md', '文件']]) if (!(await tab.locator(`[data-testid="shared-item-${title}"]`).innerText()).includes(kindWord)) issues.push(`「${title}」应标明是${kindWord}`)
      // 没有切走过的「我的知识库」内容不该出现在这里
      if (await tab.locator('[data-testid=shared-sidebar] .kb-sidebar-item').count()) issues.push('共享列表里混进了我自己的文档行')
      if (await isCoarse(tab)) {
        const rowBox = await tab.locator('[data-testid="shared-item-部署清单"]').boundingBox()
        if (!rowBox || rowBox.height < 43.5) issues.push(`触屏上共享列表的行应 ≥44px 高,实际 ${rowBox?.height}`)
      }

      // 多选 → 移出我的列表
      await tab.locator('[data-testid=shared-select-toggle]').click()
      await tab.locator('[data-testid="shared-item-部署清单"]').click()
      await tab.locator('[data-testid="shared-item-guide.md"]').click()
      if (!(await tab.locator('[data-testid=batchbar]').innerText()).includes('已选 2 项')) issues.push('批量条应显示已选 2 项')
      await tab.locator('[data-testid=shared-hide]').click()
      await tab.waitForFunction(() => !document.querySelector('[data-testid="shared-item-部署清单"]'))
      if (await tab.locator('[data-testid=batchbar]').count()) issues.push('移出后批量条应收起')
      const log = await shareLog(tab)
      const hides = log.filter((entry) => entry.name === 'hide_share')
      if (hides.length !== 2 || !hides.every((entry) => entry.args.hidden === true)) issues.push(`应发出 2 次 hide_share(hidden:true),实际 ${JSON.stringify(hides.map((h) => h.args))}`)
      if (!(await tab.locator('[data-testid=scope-switch]').innerText()).includes('共享给我 2')) issues.push('移出后数量应变成 2')
      // 打开「已移出」开关:它们回来,标着「已移出」,可以放回
      await tab.locator('[data-testid=shared-show-hidden]').click()
      await tab.waitForSelector('[data-testid="shared-item-部署清单"]')
      if (!(await tab.locator('[data-testid="shared-item-部署清单"]').innerText()).includes('已移出')) issues.push('已移出的应标「已移出」')
      await tab.locator('[data-testid=shared-select-toggle]').click()
      await tab.locator('[data-testid="shared-item-部署清单"]').click()
      if (await tab.locator('[data-testid=shared-hide]').count()) issues.push('只选了已移出的,不该再给「移出」')
      await tab.locator('[data-testid=shared-restore]').click()
      await tab.waitForFunction(() => !document.querySelector('[data-testid="shared-item-部署清单"]')?.textContent?.includes('已移出'))
      issues.push(...(await sharedFits(tab, '共享列表')))
      return issues
    },
  },

  'shared-states': {
    // 共享给我的四种状态:加载骨架、报错可重试、空(没有人分享 / 全被移出)
    route: SHARED_ROUTE,
    ready: '[data-testid=scope-switch]',
    // 页面一进来就会读一次(给切换条上的数字用),切过去再读一次:两次都失败,才能看到报错态
    fixture: sharedFixture({ sharedWithMe: [], delayMs: 500, fail: { shared_with_me: { status: 500, message: 'internal: boom', times: 2 } } }),
    expectConsole: /status of 500/,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-testid=scope-switch] [role=tab]', { hasText: '共享给我' }).click()
      await tab.waitForSelector('[data-testid=shared-sidebar] [aria-busy=true]', { timeout: 3000 }).catch(() => issues.push('加载中应显示骨架屏'))
      await tab.waitForSelector('[data-testid=shared-error]')
      const failed = await tab.locator('[data-testid=shared-error]').innerText()
      if (!failed.includes('没有加载出来')) issues.push('报错应说清楚发生了什么')
      if (/boom|500|internal/i.test(failed)) issues.push('报错不该露出英文异常 / 状态码')
      await tab.locator('[data-testid=shared-error] button', { hasText: '重试' }).click()
      await tab.waitForSelector('[data-testid=shared-empty]')
      const empty = await tab.locator('[data-testid=shared-empty]').innerText()
      if (!empty.includes('还没有人分享内容给你') || !empty.includes('按分享人出现在这里')) issues.push(`空状态应解释会出现什么,实际:${empty.replace(/\n/g, ' ')}`)
      if (!(await tab.locator('[data-testid=shared-main]').innerText()).includes('从左侧选一份共享给你的内容')) issues.push('右侧应提示选一份')
      return issues
    },
  },

  'shared-read-request': {
    // 打开只读的笔记:来源 + 角色 + 只读;申请编辑(选角色 + 附言)→ 已申请;读的是对方的知识库(带 X-KB-Space),不是我自己的
    route: SHARED_ROUTE,
    ready: '[data-testid=scope-switch]',
    fixture: sharedFixture(),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const ownReads = watchOwnReads(tab)
      await switchToShared(tab)
      await openSharedItem(tab, '部署清单')
      const bar = await tab.locator('.kb-sws-bar').innerText()
      for (const word of ['来自 张三', '可查看', '只读', '申请编辑', '移出列表']) if (!bar.includes(word)) issues.push(`顶部缺少「${word}」`)
      await tab.waitForFunction(() => document.querySelector('[data-testid=shared-doc-body]')?.textContent?.includes('先备份数据库'), undefined, { timeout: 15_000 }).catch(() => issues.push('正文没有渲染出来'))
      if (await tab.locator('[data-testid=shared-doc-edit]').count()) issues.push('只读不该有编辑按钮')
      if (await tab.locator('[data-testid=comment-input]').count()) issues.push('只能查看的人不该有评论输入框')
      const log = await shareLog(tab)
      const read = log.find((entry) => entry.name === 'get_item')
      if (!read || read.space !== 'sp_alice' || read.args.id !== 'ins_s1') issues.push(`读笔记应带 X-KB-Space: sp_alice,实际 ${JSON.stringify(read)}`)
      if (ownReads.length) issues.push(`打开别人的内容时不该读我自己的知识库:${ownReads.join(' ')}`)
      issues.push(...(await sharedFits(tab, '只读笔记')))

      // 申请编辑
      await tab.locator('[data-testid=shared-request]').click()
      await tab.waitForSelector('[data-testid=request-access]')
      const dialog = await tab.locator('[data-testid=request-access]').innerText()
      if (!dialog.includes('向 张三 申请「部署清单」')) issues.push('申请对话框应写明向谁申请什么')
      if (!(await tab.locator('[data-testid=request-role] button').innerText()).includes('可编辑')) issues.push('默认应申请「可编辑」')
      await tab.locator('[data-testid=request-message]').fill('想补充回滚步骤')
      await tab.locator('[data-testid=request-send]').click()
      await tab.waitForSelector('[data-testid=shared-requested]')
      const asked = (await shareLog(tab)).find((entry) => entry.name === 'access_request')
      if (!asked || asked.args.role !== 'editor' || asked.args.message !== '想补充回滚步骤' || asked.args.target.id !== 'ins_s1' || asked.args.target.space_id !== 'sp_alice') issues.push(`申请请求不对:${JSON.stringify(asked)}`)
      if (await tab.locator('[data-testid=shared-request]').count()) issues.push('发出申请后不该再有可点的「申请编辑」')
      // 窄屏:返回键回到列表;再回来仍是「已申请」(从服务端读到的状态)
      await toSharedList(tab)
      await openSharedItem(tab, '部署清单')
      await tab.waitForSelector('[data-testid=shared-requested]')
      return issues
    },
  },

  'shared-comment-edit': {
    // 评论(可评论的文件)、文件夹逐级打开(去重、面包屑)、可编辑的文件保存(乐观锁取文件历史)、笔记保存(版本取自版本链)
    route: SHARED_ROUTE,
    ready: '[data-testid=scope-switch]',
    // 单人编辑路径:默认夹具的用户有 collab.edit,点「编辑」会去连假后端没有的协作房间,编辑器永远只读;关掉它(见 editor-helpers.mjs)
    fixture: sharedFixture({}, SOLO_EDIT_FIXTURE),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      await switchToShared(tab)

      // 1) 可评论的文件
      await openSharedItem(tab, 'guide.md')
      await tab.waitForSelector('[data-testid=comment]')
      if (!(await tab.locator('[data-testid=doc-comments]').innerText()).includes('访客 小王')) issues.push('游客的评论应显示「访客 小王」')
      if (await tab.locator('[data-testid=shared-doc-edit]').count()) issues.push('只能评论的人不该有编辑按钮')
      await tab.locator('[data-testid=comment-input]').fill('已补充截图')
      await tab.locator('[data-testid=comment-send]').click()
      await tab.waitForFunction(() => document.querySelectorAll('[data-testid=comment]').length === 2)
      const posted = (await shareLog(tab)).find((entry) => entry.name === 'add_annotation')
      if (!posted || posted.space !== 'sp_alice' || posted.args.source !== 'guide.md' || posted.args.body !== '已补充截图') issues.push(`评论请求不对:${JSON.stringify(posted)}`)
      issues.push(...(await sharedFits(tab, '评论')))

      // 2) 文件夹:列表按文件去重 → 打开 → 编辑 → 保存
      await openSharedItem(tab, 'docs')
      // 文件夹视图在 c9fec2e3 改成和知识库一致的侧栏:默认「目录」树,「列表」页签里一行是 [data-testid=shared-row-<id>],
      // 名字在 .kb-sidebar-item-name(原来的 .kb-sfold-row / .kb-sfold-main 在文件夹里已不存在)
      await showFolderList(tab)
      const names = await tab.locator('[data-testid^="shared-row-"] .kb-sidebar-item-name').allInnerTexts()
      // 要验的是「按文件去重、各出现一次」:新列表按名字排序显示(restart.md 在前),不再是服务端返回的顺序,所以排序后比较
      if ([...names].sort().join('|') !== 'restart.md|runbook.md') issues.push(`文件夹里应是 runbook.md、restart.md 各一次,实际 ${names.join('|')}`)
      const listed = (await shareLog(tab)).filter((entry) => entry.name === 'list_items').at(-1)
      if (listed?.args.path_prefix !== 'docs') issues.push('文件夹授权的列表应带 path_prefix')
      issues.push(...(await sharedFits(tab, '文件夹')))
      await tab.locator('[data-testid^="shared-row-"]', { hasText: 'runbook.md' }).click()
      await tab.waitForSelector('[data-testid=shared-doc-edit]')
      if (!(await tab.locator('.kb-sws-crumb').innerText()).includes('docs')) issues.push('进到文件夹里的文档后应有面包屑')
      await tab.locator('[data-testid=shared-doc-edit]').click()
      await tab.waitForSelector('.cm-content')
      await tab.locator('.cm-content').click()
      await tab.keyboard.press('Control+End')
      await tab.keyboard.type('\n\n新增一行')
      await tab.locator('[data-testid=shared-doc-save]').click()
      await tab.waitForFunction(() => !document.querySelector('[data-testid=shared-doc-editor]'))
      const saved = (await shareLog(tab)).find((entry) => entry.name === 'save_file')
      if (!saved || saved.space !== 'sp_alice' || saved.args.path !== 'docs/runbook.md' || saved.args.expected_version !== 3 || !String(saved.args.content).includes('新增一行')) issues.push(`保存文件请求不对:${JSON.stringify(saved)}`)
      // 面包屑回上一级
      await tab.locator('[data-testid=shared-back]').click()
      await tab.waitForSelector('[data-testid=shared-folder]')

      // 3) Bob 的笔记(可编辑):版本取自版本链(4),不是猜的 1
      await openSharedItem(tab, 'Bob 的周报')
      await tab.locator('[data-testid=shared-doc-edit]').click()
      await tab.waitForSelector('[data-testid=shared-doc-title-input]')
      await tab.locator('[data-testid=shared-doc-title-input]').fill('Bob 的周报(改)')
      await tab.locator('[data-testid=shared-doc-save]').click()
      await tab.waitForFunction(() => document.querySelector('[data-testid=shared-doc-title]')?.textContent === 'Bob 的周报(改)')
      const edited = (await shareLog(tab)).find((entry) => entry.name === 'edit_item')
      if (!edited || edited.space !== 'sp_bob' || edited.args.version !== 4 || edited.args.title !== 'Bob 的周报(改)') issues.push(`保存笔记请求不对(版本应取自版本链 4):${JSON.stringify(edited)}`)
      issues.push(...(await sharedFits(tab, '编辑后')))
      return issues
    },
  },

  'shared-denied-edit': {
    // 后端回 403/409 时的表现:保存冲突如实说、不丢修改(单人编辑路径,夹具理由同 shared-comment-edit)
    route: SHARED_ROUTE,
    ready: '[data-testid=scope-switch]',
    // 单人编辑路径:默认夹具的用户有 collab.edit,点「编辑」会去连假后端没有的协作房间,编辑器永远只读;关掉它(见 editor-helpers.mjs)
    fixture: sharedFixture({ spaces: { sp_alice: SHARED_SPACES.sp_alice, sp_bob: { ...SHARED_SPACES.sp_bob, notes: { ins_b1: { ...SHARED_SPACES.sp_bob.notes.ins_b1, version: 4 } } } }, fail: { item_history: { status: 403, message: 'forbidden: 通过分享链接不能进行这个操作' } } }, SOLO_EDIT_FIXTURE),
    expectConsole: /status of (403|409)/,
    settle: 500,
    assert: async (tab) => {
      const issues = []
      await switchToShared(tab)
      await openSharedItem(tab, 'Bob 的周报')
      await tab.locator('[data-testid=shared-doc-edit]').click()
      await tab.waitForSelector('[data-testid=shared-doc-title-input]')
      await tab.locator('[data-testid=shared-doc-title-input]').fill('我改的标题')
      await tab.locator('[data-testid=shared-doc-save]').click()
      // 版本链取不到 → 只能猜 1 → 笔记已是 v4,后端回 409:如实说并保留修改
      await tab.waitForSelector('[data-testid=shared-doc-save-error]')
      const message = await tab.locator('[data-testid=shared-doc-save-error]').innerText()
      if (!message.includes('内容刚被别人改过')) issues.push(`冲突应如实说明,实际:${message}`)
      if (/expected|conflict|409/.test(message)) issues.push('冲突提示不该露出英文 / 状态码')
      if ((await tab.locator('[data-testid=shared-doc-title-input]').inputValue()) !== '我改的标题') issues.push('冲突后不该丢掉用户的修改')
      return issues
    },
  },

  'list-multiselect': {
    // 我的知识库的文档列表:Ctrl/⌘ + 点击、Shift 连选、批量条「分享」「合集链接」(桌面);触屏用「选择」按钮和长按
    route: DOC,
    ready: '[data-testid=doc-share]',
    fixture: shareFixture({}),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      if (size.width < 1024) {
        // 手机:返回列表;两栏(600–839):选中文档后目录栏收起了,点「列表」展开
        const back = tab.locator('[aria-label=返回列表]')
        const dir = tab.locator('[data-testid=dir-toggle]')
        if (await back.isVisible()) await back.click()
        else if (await dir.isVisible()) await dir.click()
      }
      await tab.waitForSelector('[data-testid^=list-row-]')
      const rows = tab.locator('[data-testid^=list-row-]')
      if ((await rows.count()) < 4) return ['列表里至少该有 4 行']
      const touch = size.touch
      if (!touch) {
        // 桌面:Ctrl 点第一行、Shift 点第四行 → 连选 4 行
        await rows.nth(0).click({ modifiers: ['Control'] })
        await rows.nth(3).click({ modifiers: ['Shift'] })
      } else {
        await tab.locator('[data-testid=select-toggle]').click()
        for (const index of [0, 1, 2, 3]) await rows.nth(index).click()
      }
      const count = async () => (await tab.locator('[data-testid=batchbar]').innerText()).match(/已选 (\d+) 项/)?.[1]
      if ((await count()) !== '4') issues.push(`应选中 4 行,实际 ${await count()}`)
      // 选择模式下点行是切换,不是打开
      await rows.nth(1).click()
      if ((await count()) !== '3') issues.push('选择模式下再点一行应取消选中')
      await rows.nth(1).click()
      if ((await tab.locator('.kb-sidebar-item.is-active').count()) > 1) issues.push('选择模式下不该顺手打开文档')

      // 批量分享:一个面板、全部选中项
      await tab.locator('[data-testid=batch-share]').click()
      await tab.waitForSelector('[data-testid=share-selected]')
      const heading = await tab.locator('[data-testid=share-selected]').innerText()
      if (!heading.includes('已选 4 项')) issues.push(`面板应写明已选 4 项,实际 ${heading}`)
      await tab.locator('[data-testid=share-friend-lisi]').click()
      await tab.locator('[data-testid=share-add-submit]').click()
      await tab.waitForFunction(() => document.querySelector('[data-testid=share-row-lisi]'))
      const batch = (await shareLog(tab)).find((entry) => entry.name === 'grant_batch')
      if (!batch || batch.args.targets.length !== 4 || batch.args.people[0].user_id !== PEOPLE.lisi.id || batch.args.people[0].role !== 'viewer') issues.push(`批量分享请求不对:${JSON.stringify(batch)}`)
      issues.push(...(await panelFits(tab, size)))
      // 合集链接页
      await tab.locator('[role=tab]', { hasText: '合集链接' }).click()
      await tab.locator('input[aria-label="合集名称"]').fill('本周评审')
      await tab.locator('[data-testid=share-create-submit]').click()
      await tab.waitForSelector('[data-testid=share-fresh-url]')
      const link = (await shareLog(tab)).find((entry) => entry.name === 'link_create')
      if (!link || link.args.targets?.length !== 4 || link.args.title !== '本周评审' || 'target' in link.args) issues.push(`合集链接请求不对:${JSON.stringify(link)}`)
      // 关掉面板:先提醒还没复制 → 仍要关闭;关闭后批量条收起
      await tab.locator('[data-testid=share-done]').click()
      await tab.waitForSelector('[role=alertdialog]')
      await tab.locator('[role=alertdialog] button', { hasText: '仍要关闭' }).click()
      await tab.waitForFunction(() => !document.querySelector('[data-testid=share-panel]'))
      if (await tab.locator('[data-testid=batchbar]').count()) issues.push('分享完成关闭面板后,批量条应收起')
      return issues
    },
  },

  'list-longpress': {
    // 触屏长按列表行进入多选并选中这一行;抬手那一下不会把它打开
    route: DOC,
    ready: '[data-testid=doc-share]',
    sizes: ['390x844', '820x1180', '1180x820'],
    fixture: shareFixture({}),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      if (size.width < 1024) {
        // 手机:返回列表;两栏(600–839):选中文档后目录栏收起了,点「列表」展开
        const back = tab.locator('[aria-label=返回列表]')
        const dir = tab.locator('[data-testid=dir-toggle]')
        if (await back.isVisible()) await back.click()
        else if (await dir.isVisible()) await dir.click()
      }
      await tab.waitForSelector('[data-testid^=list-row-]')
      const row = tab.locator('[data-testid^=list-row-]').nth(1)
      const box = await row.boundingBox()
      const at = { clientX: box.x + 40, clientY: box.y + box.height / 2, pointerType: 'touch', pointerId: 7, isPrimary: true, bubbles: true }
      await row.dispatchEvent('pointerdown', at)
      await tab.waitForTimeout(600)
      await row.dispatchEvent('pointerup', at)
      await row.click({ position: { x: 40, y: box.height / 2 } })
      await tab.waitForSelector('[data-testid=batchbar]')
      if (!(await tab.locator('[data-testid=batchbar]').innerText()).includes('已选 1 项')) issues.push('长按后应选中 1 项(抬手那一下的 click 不能把它又点掉)')
      // 短按不触发
      const other = tab.locator('[data-testid^=list-row-]').nth(2)
      const otherBox = await other.boundingBox()
      const short = { clientX: otherBox.x + 40, clientY: otherBox.y + otherBox.height / 2, pointerType: 'touch', pointerId: 8, isPrimary: true, bubbles: true }
      await other.dispatchEvent('pointerdown', short)
      await tab.waitForTimeout(100)
      await other.dispatchEvent('pointerup', short)
      return issues
    },
  },

  'shares-page': {
    // 我的分享:分享出去的 / 分享链接两个页签;多选后批量添加协作者、改角色(只动他已有的项)、移除、生成合集链接;链接批量关闭 / 删除
    route: '/shares',
    ready: '[data-testid=shares-page] [data-testid=rt-row], [data-testid=shares-page] [data-testid=rt-card]',
    fixture: minePage(),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const fits = async (label) => {
        const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        if (overflow > 1) issues.push(`${label}:整页横向溢出 ${overflow}px`)
      }
      const text = await tab.locator('[data-testid=shares-items]').innerText()
      for (const word of ['运维', '部署清单', 'guide.md', 'Bob、Carol', '李四、张三 等 3 人', '不继承上级']) if (!text.includes(word)) issues.push(`分享出去的缺少「${word}」`)
      if (!(await tab.locator('[role=tablist]').last().innerText()).includes('3')) issues.push('页签上应有数量')
      await fits('分享出去的')

      // 多选 运维 + 部署清单 → 添加协作者(协作者页,已选 2 项)
      await pickRows(tab, size, 'shares-items', ['运维', '部署清单'])
      if (!(await tab.locator('[data-testid=batchbar]').innerText()).includes('已选 2 项')) issues.push('批量条应显示已选 2 项')
      // 手机上的批量条(设计稿):第一行计数 + 全选 + 取消选择,第二行操作按钮整行铺满,
      // 不能是「按钮靠右挤成一排、左边空一截、取消选择另起一行」
      if (size.width < 600) {
        const bar = await tab.evaluate(() => {
          const el = document.querySelector('[data-testid=batchbar]')
          const box = el.getBoundingClientRect()
          const cs = getComputedStyle(el)
          const innerLeft = box.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth)
          const innerRight = box.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth)
          const r = (sel) => { const n = el.querySelector(sel); const b = n.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), mid: Math.round(b.top + b.height / 2) } }
          const links = [...el.querySelectorAll('.kb-batchbar-link')].map((n) => { const b = n.getBoundingClientRect(); return { text: n.textContent.trim(), mid: Math.round(b.top + b.height / 2), right: Math.round(b.right) } })
          return { innerLeft: Math.round(innerLeft), innerRight: Math.round(innerRight), count: r('.kb-batchbar-count'), actions: r('.kb-batchbar-actions'), links }
        })
        const clear = bar.links.find((link) => link.text === '取消选择')
        // 比较垂直中心线:「取消选择」触屏上最小 44px 高,计数只有一行文字高,顶边本来就不会相等
        if (!clear || Math.abs(clear.mid - bar.count.mid) > 4) issues.push(`「取消选择」应和计数在同一行(垂直中心对齐):取消选择 ${clear?.mid} 计数 ${bar.count.mid}`)
        if (Math.abs(bar.actions.left - bar.innerLeft) > 2 || Math.abs(bar.actions.right - bar.innerRight) > 2) issues.push(`操作按钮区应铺满整行:区 ${bar.actions.left}~${bar.actions.right},条内容区 ${bar.innerLeft}~${bar.innerRight}`)
      }
      await tab.locator('[data-testid=shares-add]').click()
      await tab.waitForSelector('[data-testid=share-selected]')
      if (!(await tab.locator('[data-testid=share-selected]').innerText()).includes('已选 2 项')) issues.push('面板应写明已选 2 项')
      await tab.locator('[data-testid=share-friend-lisi]').click()
      await tab.locator('[data-testid=share-add-submit]').click()
      await tab.waitForFunction(() => document.querySelector('[data-testid=share-row-lisi]'))
      issues.push(...(await panelFits(tab, size)))
      await tab.locator('[data-testid=share-done]').click()
      await tab.waitForFunction(() => !document.querySelector('[data-testid=share-panel]'))

      // 全选 3 项 → 改 Bob 的角色:他只在前两项上有权限,第三项不会被动
      await pickRows(tab, size, 'shares-items', ['guide.md'])
      if (!(await tab.locator('[data-testid=batchbar]').innerText()).includes('已选 3 项')) issues.push('此时应已选 3 项')
      await tab.locator('[data-testid=shares-role]').click()
      await tab.waitForSelector('[data-testid=batch-person]')
      await tab.locator('[data-testid=batch-person-select] button').click()
      await tab.locator('.kb-pop-layer[data-open=true] .kb-pop-item', { hasText: 'Bob' }).click()
      if (!(await tab.locator('[data-testid=batch-person-scope]').innerText()).includes('2 / 3')) issues.push('范围说明应是「2 / 3 项」')
      await tab.locator('[data-testid=batch-person-role] button').click()
      await tab.locator('.kb-pop-layer[data-open=true] .kb-pop-item', { hasText: '可管理' }).click()
      const small = (await isCoarse(tab)) ? await smallTargets(tab, '[data-testid=batch-person] .kb-select button') : []
      if (small.length) issues.push(`批量对话框的下拉可点区域不足:${small.join('、')}`)
      await tab.locator('[data-testid=batch-person-submit]').click()
      await tab.waitForFunction(() => !document.querySelector('[data-testid=batch-person]'))
      const roleCall = (await shareLog(tab)).filter((entry) => entry.name === 'grant_batch').at(-1)
      if (!roleCall || roleCall.args.targets.length !== 2 || roleCall.args.people[0].user_id !== PEOPLE.bob.id || roleCall.args.people[0].role !== 'manager') issues.push(`改角色请求不对(应只含 Bob 有权限的 2 项):${JSON.stringify(roleCall)}`)
      if (await tab.locator('[data-testid=batchbar]').count()) issues.push('做完后应清空选择')

      // 选 2 项 → 合集链接(链接页、合集)
      await pickRows(tab, size, 'shares-items', ['运维', '部署清单'])
      await tab.locator('[data-testid=shares-bundle]').click()
      await tab.waitForSelector('[data-testid=share-link-create]')
      if (!(await tab.locator('[data-testid=share-panel]').innerText()).includes('合集链接')) issues.push('多选的链接页应是合集链接')
      issues.push(...(await panelFits(tab, size)))
      await tab.keyboard.press('Escape')
      await tab.waitForFunction(() => !document.querySelector('[data-testid=share-panel]'))
      return issues
    },
  },

  'shares-links': {
    // 分享链接页签:状态 / 范围 / 密码 / 访问量;点「管理」只管这一条;批量关闭(确认)与删除(确认,红色)
    route: '/shares?tab=links',
    ready: '[data-testid=shares-links] [data-testid=rt-row], [data-testid=shares-links] [data-testid=rt-card]',
    fixture: minePage(),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const text = await tab.locator('[data-testid=shares-links]').innerText()
      for (const word of ['本周评审', '合集 · 2 项', '生效中', '有密码', '23 次']) if (!text.includes(word)) issues.push(`链接列表缺少「${word}」`)
      if (!text.includes('完整的链接地址只在创建或重置时显示一次')) issues.push('应说明完整地址只显示一次')
      const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      if (overflow > 1) issues.push(`整页横向溢出 ${overflow}px`)

      // 管理合集链接:面板只有链接页,没有协作者页签
      const manage = size.width < 600 ? tab.locator('[data-testid=shares-links] [data-testid=rt-card]', { hasText: '本周评审' }).locator('button[aria-label^="管理链接"]') : tab.locator('[data-testid=shares-links] [data-testid=rt-row]', { hasText: '本周评审' }).locator('button[aria-label^="管理链接"]')
      await manage.click()
      await tab.waitForSelector('[data-testid=share-panel]')
      const tabs = await tab.locator('[data-testid=share-panel]').locator('xpath=ancestor::*[@role="dialog"][1]').locator('[role=tab]').allInnerTexts()
      if (tabs.join('|') !== '合集链接') issues.push(`管理一条链接时只该有「合集链接」页签,实际 ${tabs.join('|')}`)
      if (!(await tab.locator('[data-testid=share-panel]').innerText()).includes('生效中')) issues.push('应显示这条链接的状态')
      issues.push(...(await panelFits(tab, size)))
      // 在面板里删除这条合集链接 → 面板关闭,列表里不再有它
      await tab.locator('[data-testid=share-revoke]').click()
      await tab.waitForSelector('[role=alertdialog]')
      await tab.locator('[role=alertdialog] button', { hasText: '删除链接' }).click()
      await tab.waitForFunction(() => !document.querySelector('[data-testid=share-panel]'))
      await tab.waitForFunction(() => !document.querySelector('[data-testid=shares-links]')?.textContent?.includes('本周评审'))

      // 批量关闭:确认;只对还开着的发请求
      await pickRows(tab, size, 'shares-links', ['运维'])
      await tab.locator('[data-testid=links-close]').click()
      await tab.waitForSelector('[role=alertdialog]')
      const warning = await tab.locator('[role=alertdialog]').innerText()
      if (!warning.includes('暂时打不开') || !warning.includes('随时可以')) issues.push('关闭确认应写明后果和可恢复')
      await tab.locator('[role=alertdialog] button', { hasText: '关闭链接' }).click()
      await tab.waitForFunction(() => document.querySelector('[data-testid=shares-links]')?.textContent?.includes('已关闭'))
      const closed = (await shareLog(tab)).filter((entry) => entry.name === 'link_update' && entry.args.enabled === false)
      if (closed.length !== 1 || closed[0].args.id !== 'l1') issues.push(`应只关闭被选中的 l1,实际 ${JSON.stringify(closed.map((entry) => entry.args))}`)

      // 批量删除(红色按钮,写明永久失效)
      await pickRows(tab, size, 'shares-links', ['部署清单'])
      await tab.locator('[data-testid=links-delete]').click()
      await tab.waitForSelector('[role=alertdialog]')
      const danger = await tab.locator('[role=alertdialog] button.is-danger').innerText()
      if (danger !== '删除链接') issues.push('删除应是红色按钮')
      if (!(await tab.locator('[role=alertdialog]').innerText()).includes('永久失效')) issues.push('删除确认应写明永久失效')
      await tab.locator('[role=alertdialog] button.is-danger').click()
      await tab.waitForFunction(() => !document.querySelector('[data-testid=shares-links]')?.textContent?.includes('部署清单'))
      const revoked = (await shareLog(tab)).filter((entry) => entry.name === 'link_revoke').map((entry) => entry.args.id)
      if (!revoked.includes('l2')) issues.push(`应删除被选中的 l2,实际 ${revoked.join(',')}`)
      return issues
    },
  },

  'shares-states': {
    // 我的分享的四种状态:加载骨架、报错可重试、空(给下一步)
    route: '/home',
    ready: 'body',
    fixture: minePage({ sharedByMe: [], links: [], delayMs: 600, fail: { shared_by_me: { status: 500, message: 'internal: boom', times: 1 } } }),
    expectConsole: /status of 500/,
    settle: 400,
    assert: async (tab) => {
      const issues = []
      await viaNav(tab, 'shares')
      await tab.waitForSelector('[data-testid=shares-items] [aria-busy=true]', { timeout: 3000 }).catch(() => issues.push('加载中应显示骨架屏'))
      await tab.waitForSelector('[data-testid=shares-items-error]')
      const failed = await tab.locator('[data-testid=shares-items-error]').innerText()
      if (!failed.includes('没有加载出来') || /boom|500|internal/i.test(failed)) issues.push(`报错文案不对:${failed}`)
      await tab.locator('[data-testid=shares-items-error] button').click()
      await tab.waitForSelector('[data-testid=shares-items-empty]')
      const empty = await tab.locator('[data-testid=shares-items-empty]').innerText()
      if (!empty.includes('你还没有分享过内容') || !empty.includes('去知识库')) issues.push(`空状态应给下一步:${empty.replace(/\n/g, ' ')}`)
      await tab.locator('[role=tab]', { hasText: '分享链接' }).click()
      await tab.waitForSelector('[data-testid=shares-links-empty]')
      return issues
    },
  },

  'shares-feature-off': {
    // 没有 collab.share:导航里没有「我的分享」,直接访问显示未开通
    route: '/shares',
    ready: '[data-testid=shares-page]',
    fixture: shareFixture({}, { __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => id !== 'collab.share'), true) } }),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      await tab.waitForSelector('[data-testid=feature-off]')
      if (!(await tab.locator('[data-testid=feature-off]').innerText()).includes('你的账号没有开通这个功能,请联系管理员')) issues.push('未开通文案不对')
      if (await tab.locator('[data-testid=shares-items]').count()) issues.push('未开通不该显示列表')
      if (size.width >= 1024 && (await tab.locator('[data-nav-id=shares]').count())) issues.push('没有 collab.share 导航里不该有「我的分享」')
      return issues
    },
  },

  'shares-nav': {
    // 有 collab.share:导航里有「我的分享」,点进去是这个页面(标签栏形态在「我的」页里)
    route: '/home',
    ready: 'body',
    fixture: shareFixture({}),
    settle: 700,
    assert: async (tab) => {
      const issues = []
      await viaNav(tab, 'shares')
      await tab.waitForSelector('[data-testid=shares-page]')
      if (new URL(tab.url()).pathname !== '/shares') issues.push(`应跳到 /shares,实际 ${tab.url()}`)
      return issues
    },
  },

  'shares-requests': {
    // 访问申请:列表(谁、什么权限、附言)、同意时改角色、拒绝要确认并写明后果、处理完列表清空、我发出的三种状态
    route: '/shares?tab=requests',
    ready: '[data-testid="request-r1"]',
    fixture: minePage({ accessRequests: structuredClone(REQUESTS) }),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const fits = async (label) => {
        const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        if (overflow > 1) issues.push(`${label}:整页横向溢出 ${overflow}px`)
      }
      const first = await tab.locator('[data-testid="request-r1"]').innerText()
      for (const word of ['Bob', '申请「可编辑」权限', '部署清单', '笔记', '想补充回滚步骤']) if (!first.includes(word)) issues.push(`申请卡片缺少「${word}」`)
      if (!(await tab.locator('[data-testid="request-r2"]').innerText()).includes('文件夹')) issues.push('第二条应标明是文件夹')
      if (!(await tab.locator('[role=tablist]').last().innerText()).match(/访问申请\s*2/)) issues.push('页签上应显示等我处理的数量 2')
      const mine = await tab.locator('[data-testid=access-requests]').innerText()
      for (const word of ['等待处理', '已通过', '已拒绝', 'Alice 的设计稿']) if (!mine.includes(word)) issues.push(`我发出的缺少「${word}」`)
      await fits('访问申请')
      if (await isCoarse(tab)) {
        const small = await smallTargets(tab, '[data-testid="request-r1"] button')
        if (small.length) issues.push(`触屏可点区域不足 44px:${small.join('、')}`)
      }

      // 同意 r1,但把角色降成「可评论」
      await tab.locator('[data-testid="request-role-r1"] button').click()
      await tab.locator('.kb-pop-layer[data-open=true] .kb-pop-item', { hasText: '可评论' }).click()
      await tab.locator('[data-testid="request-approve-r1"]').click()
      await tab.waitForFunction(() => !document.querySelector('[data-testid="request-r1"]'))
      const approved = (await shareLog(tab)).find((entry) => entry.name === 'access_decide' && entry.args.id === 'r1')
      if (!approved || approved.args.approve !== true || approved.args.role !== 'commenter') issues.push(`同意请求不对(应带改过的角色 commenter):${JSON.stringify(approved)}`)

      // 拒绝 r2:确认框写明后果
      await tab.locator('[data-testid="request-reject-r2"]').click()
      await tab.waitForSelector('[role=alertdialog]')
      const warning = await tab.locator('[role=alertdialog]').innerText()
      if (!warning.includes('24 小时') || !warning.includes('收到通知')) issues.push(`拒绝确认应写明后果,实际:${warning.replace(/\n/g, ' ')}`)
      await tab.locator('[role=alertdialog] button.is-danger').click()
      await tab.waitForSelector('[data-testid=requests-empty]')
      const rejected = (await shareLog(tab)).find((entry) => entry.name === 'access_decide' && entry.args.id === 'r2')
      if (!rejected || rejected.args.approve !== false || 'role' in rejected.args) issues.push(`拒绝请求不对:${JSON.stringify(rejected)}`)
      if (!(await tab.locator('[data-testid=requests-empty]').innerText()).includes('现在没有等你处理的申请')) issues.push('处理完应显示空状态')
      await fits('处理完')
      return issues
    },
  },

  'shares-requests-stale': {
    // 对方的申请已经被别人处理了(后端 404):这一行如实写明,不是默默失败
    route: '/shares?tab=requests',
    ready: '[data-testid="request-r1"]',
    fixture: minePage({ accessRequests: structuredClone(REQUESTS), fail: { access_decide: { status: 404, message: 'not found: 没有这条待处理的申请', times: 1 } } }),
    expectConsole: /status of 404/,
    settle: 400,
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-testid="request-approve-r1"]').click()
      await tab.waitForSelector('[data-testid="request-error-r1"]')
      const message = await tab.locator('[data-testid="request-error-r1"]').innerText()
      if (!message.includes('没有这条待处理的申请')) issues.push(`应写明原因,实际:${message}`)
      if (/not found|404/i.test(message)) issues.push('不该露出英文 / 状态码')
      return issues
    },
  },

  'public-view': {
    // 公开页 · 游客只读:不用外壳、品牌一小行、来源与角色、游客昵称、「想参与编辑」、没有编辑 / 评论输入;不碰账号接口;noindex
    route: '/s/tokView',
    ready: '[data-testid=public-content] [data-testid=shared-doc-title]',
    fixture: publicPage(),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const brand = await tab.locator('[data-testid=public-brand]').innerText()
      if (brand !== '团队知识库') issues.push(`顶部应是站点名,实际 ${brand}`)
      if (!(await tab.locator('[data-testid=public-owner]').innerText()).includes('张三 分享给你')) issues.push('应写明是谁分享的')
      if ((await tab.locator('[data-testid=public-role]').innerText()) !== '可查看') issues.push('应显示角色「可查看」')
      if ((await tab.locator('[data-testid=guest-name]').innerText()) !== '访客 3fa9') issues.push('应显示游客昵称')
      const login = await tab.locator('[data-testid=public-login-link]').getAttribute('href')
      if (login !== '/login?next=%2Fs%2FtokView') issues.push(`登录链接应带回跳地址,实际 ${login}`)
      if (!(await tab.locator('[data-testid=public-login-hint]').innerText()).includes('想参与编辑')) issues.push('应有「想参与编辑?登录」提示')
      await tab.waitForFunction(() => document.querySelector('[data-testid=shared-doc-body]')?.textContent?.includes('先备份数据库'), undefined, { timeout: 15_000 }).catch(() => issues.push('正文没有渲染出来'))
      if (await tab.locator('[data-testid=shared-doc-edit]').count()) issues.push('只读不该有编辑按钮')
      if (await tab.locator('[data-testid=comment-input]').count()) issues.push('只读不该有评论输入框')
      if (await tab.locator('[data-testid=public-guest-note]').count()) issues.push('只读游客不用提醒「会记在名下」')
      const parts = await shellParts(tab)
      if (parts.length) issues.push(`公开页不该有统一外壳的部件:${parts.join(',')}`)
      const robots = await tab.evaluate(() => document.querySelector('meta[name=robots]')?.getAttribute('content') ?? '')
      if (!robots.includes('noindex')) issues.push('应有 noindex')
      const log = await shareLog(tab)
      const read = log.find((entry) => entry.name === 'public:get_item')
      if (!read || read.args.id !== 'ins_s1') issues.push(`读笔记应走 /share/{token}/call/get_item,实际 ${JSON.stringify(read)}`)
      if (!(await tab.title()).includes('部署清单')) issues.push(`页面标题应带内容名,实际 ${await tab.title()}`)
      const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      if (overflow > 1) issues.push(`整页横向溢出 ${overflow}px`)
      if (size.width < 600) {
        const header = await tab.locator('.kb-pub-top').boundingBox()
        if (!header || header.height > 130) issues.push(`手机顶栏不该占太高,实际 ${header?.height}`)
      }
      return issues
    },
  },

  'public-no-account-calls': {
    // 公开页是独立页面:加载和渲染过程中不许请求任何账号接口(能力 / 当前用户 / 登录状态)。
    // 监听在刷新之前挂上(否则刷新期间的请求看不到),并用一次故意发出的请求证明监听本身是活的。
    route: '/s/tokView',
    ready: '[data-testid=public-content]',
    fixture: publicPage(),
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const calls = watchAccountCalls(tab)
      await tab.reload({ waitUntil: 'networkidle' })
      await tab.waitForSelector('[data-testid=public-content]')
      await tab.waitForTimeout(600)
      if (calls.length) issues.push(`公开页不该请求账号接口:${calls.join(', ')}`)
      // 对照:同一个监听必须能看到一次真正发出的账号请求,否则上面的“没有”不说明任何事
      calls.length = 0
      await tab.evaluate(() => fetch('/api/v1/auth/me'))
      await tab.waitForTimeout(100)
      if (calls.length !== 1) issues.push(`监听失效:故意发出的 /auth/me 没被看到(${calls.length})`)
      return issues
    },
  },

  'public-rename': {
    // 游客改名:前端先拦不合法的(空 / 太长 / 含 < >),合法的发给服务端,顶栏立刻变,刷新后还在
    route: '/s/tokGuide',
    ready: '[data-testid=guest-rename]',
    fixture: publicPage(),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      await tab.locator('[data-testid=guest-rename]').click()
      await tab.locator('[data-testid=guest-input]').fill('<b>x</b>')
      await tab.locator('[data-testid=guest-save]').click()
      if (!(await tab.locator('[data-testid=guest-error]').innerText()).includes('不能包含')) issues.push('含 < > 应在前端被拦住')
      await tab.locator('[data-testid=guest-input]').fill('字'.repeat(21))
      await tab.locator('[data-testid=guest-save]').click()
      if (!(await tab.locator('[data-testid=guest-error]').innerText()).includes('最多 20 个字')) issues.push('超过 20 字应被拦住')
      if ((await shareLog(tab)).some((entry) => entry.name === 'public:rename')) issues.push('不合法的名字不该发请求')
      const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      if (overflow > 1) issues.push(`改名表单让整页横向溢出 ${overflow}px`)
      if (await isCoarse(tab)) {
        const small = await smallTargets(tab, '.kb-guest-form button')
        if (small.length) issues.push(`触屏可点区域不足 44px:${small.join('、')}`)
      }
      await tab.locator('[data-testid=guest-input]').fill('小王')
      await tab.keyboard.press('Enter')
      await tab.waitForFunction(() => document.querySelector('[data-testid=guest-name]')?.textContent === '小王')
      const renamed = (await shareLog(tab)).find((entry) => entry.name === 'public:rename')
      if (renamed?.args.nickname !== '小王') issues.push(`改名请求不对:${JSON.stringify(renamed)}`)
      // 刷新后还是这个名字(存在服务端)
      await tab.reload({ waitUntil: 'networkidle' })
      await tab.waitForSelector('[data-testid=guest-name]')
      if ((await tab.locator('[data-testid=guest-name]').innerText()) !== '小王') issues.push('刷新后昵称应保持')
      return issues
    },
  },

  'public-comment-edit': {
    // 游客可评论 / 编辑:提醒「会记在名下」;评论带游客身份;编辑走多人在线编辑(游客也是),正文随输入进房间,点「完成」落地
    // (旧版这里断言「源码编辑 + 保存」:链接访问者的编辑早已改成协作,那条路径进不去,所以场景一直红;见 link-room.mjs)
    route: '/s/tokEdit',
    ready: '[data-testid=shared-doc-edit]',
    fixture: publicEditPage('ins_p1'),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      if (!(await tab.locator('[data-testid=public-guest-note]').innerText()).includes('会记在「访客 3fa9」名下')) issues.push('应提醒评论和修改会记在游客名下')
      if (await tab.locator('[data-testid=public-login-hint]').count()) issues.push('已经能编辑的游客不用再催登录')
      // 评论
      await tab.locator('[data-testid=comment-input]').fill('第一段写得清楚')
      await tab.locator('[data-testid=comment-send]').click()
      await tab.waitForSelector('[data-testid=comment]')
      if (!(await tab.locator('[data-testid=doc-comments]').innerText()).includes('访客 3fa9')) issues.push('评论作者应显示游客昵称')
      const posted = (await shareLog(tab)).find((entry) => entry.name === 'public:add_annotation')
      if (!posted || posted.args.source !== 'insight:ins_p1' || posted.args.body !== '第一段写得清楚') issues.push(`评论请求不对:${JSON.stringify(posted)}`)
      // 编辑:连上房间 → 输入进房间 → 完成时正文落地
      await tab.locator('[data-testid=shared-doc-edit]').click()
      await waitCollabSynced(tab)
      const { room } = linkRoomOf(tab)
      if (!room.richText().includes('第一段')) issues.push(`初始化者没有把原正文放进房间:${room.richText()}`)
      await tab.locator('[data-testid=shared-doc-editor] .ProseMirror').click()
      await tab.keyboard.press('Control+End')
      await tab.keyboard.type(' 第二段。')
      await tab.waitForFunction(() => document.querySelector('[data-testid=shared-doc-editor] .ProseMirror')?.textContent?.includes('第二段'))
      await tab.waitForTimeout(400)
      if (!room.richText().includes('第二段')) issues.push(`输入的字没有进房间:${room.richText()}`)
      issues.push(...(await overflowIssues(tab)))
      await tab.locator('[data-testid=shared-doc-finish]').click()
      await tab.waitForFunction(() => !document.querySelector('[data-testid=shared-doc-editor]'))
      const landed = room.landed.at(-1)
      if (!landed || !landed.markdown.includes('第二段') || !landed.markdown.includes('第一段')) issues.push(`完成时应把新旧正文一起落地:${JSON.stringify(landed?.markdown)}`)
      const log = await shareLog(tab)
      if (log.some((entry) => entry.name === 'public:edit_item')) issues.push('标题没改,不该提交 edit_item(正文走落地)')
      if (log.some((entry) => entry.name === 'public:create_item' || entry.name === 'public:delete_item')) issues.push('通过链接不该有新建 / 删除')
      await tab.waitForFunction(() => document.querySelector('[data-testid=shared-doc-body]')?.textContent?.includes('第二段'))
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'public-title-edit': {
    // 游客只改标题:标题不在协作文档里,走 edit_item;通过链接拿不到版本链,版本退回 1(笔记确实是 v1,所以成功)
    route: '/s/tokEdit',
    ready: '[data-testid=shared-doc-edit]',
    fixture: publicEditPage('ins_p1'),
    expectConsole: /status of 403/, // item_history 通过链接不开放(预期的 403)
    settle: 500,
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-testid=shared-doc-edit]').click()
      await waitCollabSynced(tab)
      await tab.locator('[data-testid=shared-doc-title-input]').fill('共同编辑的笔记(改名)')
      await tab.locator('[data-testid=shared-doc-finish]').click()
      await tab.waitForFunction(() => !document.querySelector('[data-testid=shared-doc-editor]'))
      const edited = (await shareLog(tab)).find((entry) => entry.name === 'public:edit_item')
      if (!edited || edited.args.id !== 'ins_p1' || edited.args.version !== 1 || edited.args.title !== '共同编辑的笔记(改名)') issues.push(`改标题请求不对:${JSON.stringify(edited)}`)
      await tab.waitForFunction(() => document.querySelector('[data-testid=shared-doc-title]')?.textContent === '共同编辑的笔记(改名)')
      // 没动正文:落地者提交的必须还是原文(曾经提交空串,等于清空笔记),读回来正文也还在
      for (const landing of linkRoomOf(tab).room.landed) if (!landing.markdown.includes('第一段')) issues.push(`没动正文时不该改写正文,落地的是:${JSON.stringify(landing.markdown)}`)
      if (!(await tab.locator('[data-testid=shared-doc-body]').innerText()).includes('第一段')) issues.push('改标题之后正文不见了')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'public-password': {
    // 带密码的链接:输对前什么都不透露;密码错可再试;输对后进入正文
    route: '/s/tokSecret',
    ready: '[data-testid=public-password]',
    fixture: publicPage(),
    expectConsole: /status of 401/, // 密码错的 401 是预期的
    settle: 400,
    assert: async (tab, size) => {
      const issues = []
      const page = await tab.locator('[data-testid=public-page]').innerText()
      for (const secret of ['部署清单', '张三', '可查看', '先备份']) if (page.includes(secret)) issues.push(`输对密码前不该透露「${secret}」`)
      if ((await tab.locator('[data-testid=public-password-input]').getAttribute('type')) !== 'password') issues.push('密码框应是 password 类型')
      if ((await tab.locator('[data-testid=public-password-submit]').getAttribute('disabled')) === null) issues.push('没输密码时按钮应禁用')
      if (await isCoarse(tab)) {
        const font = await tab.locator('[data-testid=public-password-input]').evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))
        if (font < 16) issues.push(`触屏上输入框字号应 ≥16px(否则 iOS 聚焦会放大页面),实际 ${font}`)
      }
      await tab.locator('[data-testid=public-password-input]').fill('wrong')
      await tab.locator('[data-testid=public-password-submit]').click()
      await tab.waitForSelector('[data-testid=public-password-error]')
      const wrong = await tab.locator('[data-testid=public-password-error]').innerText()
      if (!wrong.includes('访问密码不对')) issues.push(`密码错的提示不对:${wrong}`)
      if ((await tab.locator('[data-testid=public-password-error]').getAttribute('data-locked')) !== 'false') issues.push('密码错不是「被锁」')
      const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      if (overflow > 1) issues.push(`整页横向溢出 ${overflow}px`)
      await tab.locator('[data-testid=public-password-input]').fill('sesame1')
      await tab.keyboard.press('Enter')
      await tab.waitForSelector('[data-testid=public-content]')
      if (await tab.locator('[data-testid=public-password]').count()) issues.push('输对后密码页应消失')
      const log = await shareLog(tab)
      if (log.filter((entry) => entry.name === 'public:info').length !== 2) issues.push('输对后应重新取一次状态(第一次是锁定状态)')
      return issues
    },
  },

  'public-lockout': {
    // 输错太多次被锁:换成另一种文案,即使这时输对也进不去
    route: '/s/tokLock',
    ready: '[data-testid=public-password]',
    fixture: publicPage(),
    expectConsole: /status of (401|429)/,
    settle: 400,
    assert: async (tab) => {
      const issues = []
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await tab.locator('[data-testid=public-password-input]').fill(`bad${attempt}`)
        await tab.locator('[data-testid=public-password-submit]').click()
        await tab.waitForFunction((n) => document.querySelectorAll('[data-testid=public-password-error]').length === 1 && document.querySelector('[data-testid=public-password-error]').textContent.includes('访问密码不对'), attempt)
      }
      // 第 4 次(这时输对也一样):被锁
      await tab.locator('[data-testid=public-password-input]').fill('sesame1')
      await tab.locator('[data-testid=public-password-submit]').click()
      await tab.waitForFunction(() => document.querySelector('[data-testid=public-password-error]')?.getAttribute('data-locked') === 'true')
      const locked = await tab.locator('[data-testid=public-password-error]').innerText()
      if (!locked.includes('10 分钟')) issues.push(`被锁的提示应写明要等多久,实际:${locked}`)
      if (locked.includes('不对')) issues.push('被锁和密码错应是两种文案')
      if (await tab.locator('[data-testid=public-content]').count()) issues.push('被锁时不该进入正文')
      if ((await tab.locator('[data-testid=public-password-input]').inputValue()) !== '') issues.push('被锁后应清掉密码框')
      return issues
    },
  },

  'public-status': {
    // 各种状态页:不存在 / 关闭 / 过期 / 撤销 / 暂不可用 / 需要登录 / 游客被关 / 没权限 / 限流;每种文案不同、都不露英文
    route: '/s/tokExpired',
    ready: '[data-testid=public-status]',
    fixture: publicPage(),
    expectConsole: /status of (401|403|404|410|429)/,
    settle: 300,
    assert: async (tab, size) => {
      const issues = []
      const cases = [
        ['tokExpired', 'link_expired', '这个链接已过期', null],
        ['tokClosed', 'link_closed', '所有者关闭了这个链接', null],
        ['tokRevoked', 'link_revoked', '这个链接已被撤销', null],
        ['tokUnavail', 'link_unavailable', '这个链接暂时不可用', null],
        ['tokMissing', 'link_not_found', '这个链接不存在或已失效', null],
        ['tokLogin', 'login_required', '需要登录后才能查看', 'login'],
        ['tokGuestsOff', 'guests_disabled', '现在不允许游客访问', 'login'],
        ['tokNoAccess', 'no_access', '你没有权限查看这个内容', null],
        ['tokRate', 'rate_limited', '访问太频繁了', 'retry'],
      ]
      const seen = new Set()
      for (const [token, code, title, action] of cases) {
        await tab.goto(new URL(`/s/${token}`, tab.url()).toString(), { waitUntil: 'networkidle' })
        await tab.waitForSelector('[data-testid=public-status]')
        const got = await tab.locator('[data-testid=public-status]').getAttribute('data-code')
        if (got !== code) issues.push(`${token}:错误码应是 ${code},实际 ${got}`)
        const text = await tab.locator('[data-testid=public-status]').innerText()
        if (!text.includes(title)) issues.push(`${token}:标题应是「${title}」,实际 ${text.split('\n')[0]}`)
        if (/[A-Za-z]{4,}|\b\d{3}\b/.test(text.replace(/Ctrl/g, ''))) issues.push(`${token}:不该露出英文或状态码:${text.replace(/\n/g, ' ')}`)
        seen.add(text)
        const hasLogin = (await tab.locator('[data-testid=public-login]').count()) > 0
        const hasRetry = (await tab.locator('[data-testid=public-retry]').count()) > 0
        if (hasLogin !== (action === 'login')) issues.push(`${token}:登录入口 ${hasLogin} 与预期 ${action} 不符`)
        if (hasRetry !== (action === 'retry')) issues.push(`${token}:重试入口 ${hasRetry} 与预期 ${action} 不符`)
        if (action === 'login' && (await tab.locator('[data-testid=public-login]').getAttribute('href')) !== `/login?next=${encodeURIComponent(`/s/${token}`)}`) issues.push(`${token}:登录后应回到这个链接`)
        if (await tab.locator('[data-testid=public-content], [data-testid=public-password]').count()) issues.push(`${token}:状态页里不该有正文或密码框`)
        const parts = await shellParts(tab)
        if (parts.length) issues.push(`${token}:状态页不该有外壳 ${parts.join(',')}`)
      }
      if (seen.size !== cases.length) issues.push('每种状态应有自己的文案')
      const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      if (overflow > 1) issues.push(`整页横向溢出 ${overflow}px`)
      if (await isCoarse(tab)) {
        const small = await smallTargets(tab, '[data-testid=public-status] .btn, [data-testid=public-status] button')
        if (small.length) issues.push(`触屏可点区域不足 44px:${small.join('、')}`)
      }
      return issues
    },
  },

  'public-bundle': {
    // 合集链接:虚拟目录(标题 + 共几项),笔记取到标题;逐项打开,面包屑回合集;文件夹里再进文件
    route: '/s/tokBundle',
    ready: '[data-testid=public-roots]',
    fixture: publicPage(),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      if ((await tab.locator('[data-testid=public-title]').innerText()) !== '本周评审') issues.push('应显示合集名')
      if (!(await tab.locator('.kb-pcon-sub').innerText()).includes('共 3 项')) issues.push('应写明共几项')
      await tab.waitForFunction(() => [...document.querySelectorAll('.kb-sfold-main b')].map((el) => el.textContent).includes('部署清单'), undefined, { timeout: 10_000 }).catch(() => issues.push('合集里的笔记应显示标题而不是「笔记」'))
      const names = await tab.locator('.kb-sfold-main b').allInnerTexts()
      if (names.join('|') !== '部署清单|docs|guide.md') issues.push(`合集里应是 部署清单|docs|guide.md,实际 ${names.join('|')}`)
      if ((await tab.locator('[data-testid=public-page]').innerText()).includes('ins_s1')) issues.push('不该露出笔记 id')
      // 笔记
      await tab.locator('[data-testid="public-root-部署清单"]').click()
      await tab.waitForSelector('[data-testid=shared-doc-title]')
      if (!(await tab.locator('.kb-pcon-crumb').innerText()).includes('本周评审')) issues.push('面包屑应从合集名开始')
      await tab.locator('[data-testid=public-crumb-root]').click()
      await tab.waitForSelector('[data-testid=public-roots]')
      // 文件夹 → 文件 → 回到文件夹 → 回到合集
      await tab.locator('[data-testid="public-root-docs"]').click()
      await showFolderList(tab)
      await tab.locator('[data-testid^="shared-row-"]', { hasText: 'runbook.md' }).click()
      await tab.waitForSelector('[data-testid=shared-doc-title]')
      const crumb = await tab.locator('.kb-pcon-crumb').innerText()
      if (!crumb.includes('本周评审') || !crumb.includes('docs') || !crumb.includes('runbook.md')) issues.push(`面包屑应是 合集 / docs / runbook.md,实际 ${crumb}`)
      await tab.locator('.kb-pcon-crumb-btn', { hasText: 'docs' }).click()
      await showFolderList(tab)
      await tab.locator('[data-testid=public-crumb-root]').click()
      await tab.waitForSelector('[data-testid=public-roots]')
      const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      if (overflow > 1) issues.push(`整页横向溢出 ${overflow}px`)
      const log = await shareLog(tab)
      if (log.some((entry) => entry.name === 'public:list_items' && entry.args.path_prefix !== 'docs')) issues.push('文件夹的列表应带 path_prefix')
      return issues
    },
  },

  'public-nodownload': {
    // 关了下载 + 水印:没有「下载原件」;水印铺在页面上但不挡点击;原件接口被拒时页面不坏
    route: '/s/tokNoDl',
    ready: '[data-testid=shared-doc-title]',
    fixture: publicPage(),
    settle: 500,
    assert: async (tab) => {
      const issues = []
      if (await tab.locator('[data-testid=shared-doc-download]').count()) issues.push('关了下载不该有「下载原件」')
      const watermark = tab.locator('[data-testid=public-watermark]')
      if (!(await watermark.count())) return [...issues, '开了水印应有水印层']
      if (!(await watermark.innerText()).includes('访客 · 2026-10-28 16:00')) issues.push('水印文字应是服务端给的「访问者 · 时间」')
      const style = await watermark.evaluate((el) => ({ events: getComputedStyle(el).pointerEvents, hidden: el.getAttribute('aria-hidden') }))
      if (style.events !== 'none') issues.push('水印不能拦截点击')
      if (style.hidden !== 'true') issues.push('水印应对读屏软件隐藏')
      // 点击能穿过水印:点评论区的“改名”
      await tab.locator('[data-testid=guest-rename]').click()
      await tab.waitForSelector('[data-testid=guest-input]')
      return issues
    },
  },

  'public-user': {
    // 登录用户打开链接:顶栏是他的名字,没有改名 / 登录 / 想参与编辑;能编辑
    route: '/s/tokUser',
    ready: '[data-testid=shared-doc-edit]',
    fixture: publicPage(),
    settle: 500,
    assert: async (tab) => {
      const issues = []
      if (!(await tab.locator('[data-testid=public-user]').innerText()).includes('我')) issues.push('顶栏应是登录用户的名字')
      for (const id of ['guest-nickname', 'public-login-link', 'public-login-hint', 'public-guest-note']) if (await tab.locator(`[data-testid=${id}]`).count()) issues.push(`登录用户不该有 ${id}`)
      return issues
    },
  },

  'public-scrolls': {
    // 分享页没有外壳,全局样式把 body 锁成 overflow:hidden + 100vh:内容比屏幕高时滚轮 / 触摸都滚不动(用户真机反馈)。
    // 往页面里塞一段很高的内容,滚轮要真的能把页面推上去,而且能滚到最下面
    route: '/s/tokView',
    ready: '[data-testid=public-content] [data-testid=shared-doc-title]',
    fixture: publicPage(),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      await tab.evaluate(() => {
        const tall = document.createElement('div')
        tall.id = 'probe-tall'
        tall.style.cssText = 'height:3000px;flex:none'
        tall.textContent = '很高的内容'
        document.querySelector('.kb-pub-main').appendChild(tall)
      })
      await tab.mouse.move(size.width / 2, size.height / 2)
      await tab.mouse.wheel(0, 500)
      await tab.waitForTimeout(300)
      const moved = await tab.evaluate(() => Math.max(window.scrollY, document.scrollingElement?.scrollTop ?? 0, document.querySelector('.kb-pub')?.scrollTop ?? 0))
      if (moved < 100) issues.push(`滚轮往下滚 500 之后页面只动了 ${moved}px(应该能滚动)`)
      await tab.evaluate(() => document.getElementById('probe-tall').scrollIntoView({ block: 'end' }))
      await tab.waitForTimeout(200)
      const box = await tab.locator('#probe-tall').boundingBox()
      if (!box || box.y + box.height > size.height + 2) issues.push(`滚到底之后最后一块内容还在屏幕外:下缘 ${box ? box.y + box.height : '找不到'},屏幕高 ${size.height}`)
      return issues
    },
  },

  'public-owner-avatar': {
    // 游客(没登录)打开链接:「谁分享给你」前面是分享人的真头像(走按链接校验的接口,不是需要登录的 /users/{id}/avatar);
    // 图片真的加载出来了,控制台没有 401
    route: '/s/tokView',
    ready: '[data-testid=public-owner]',
    fixture: publicPage({ publicLinks: { ...structuredClone(PUBLIC_LINKS), tokView: { ...PUBLIC_LINKS.tokView, ownerAvatar: 'owner-v1.png' } } }),
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const img = tab.locator('[data-testid=public-owner] img').first()
      const src = await img.getAttribute('src').catch(() => null)
      if (!src) return ['分享人前面应是头像图片,实际是首字母']
      if (!src.includes('/api/v1/share/tokView/owner-avatar') || !src.includes('v=owner-v1.png')) issues.push(`头像地址不对:${src}`)
      const loaded = await img.evaluate((el) => el.complete && el.naturalWidth > 0)
      if (!loaded) issues.push('头像图片没有加载出来')
      const log = await shareLog(tab)
      if (!log.some((entry) => entry.name === 'public:owner-avatar')) issues.push('应该请求按链接校验的头像接口')
      return issues
    },
  },

  'public-owner-no-avatar': {
    // 分享人没有头像:画首字母,不发图片请求(不制造 404)
    route: '/s/tokView',
    ready: '[data-testid=public-owner]',
    fixture: publicPage(),
    settle: 500,
    assert: async (tab) => {
      const issues = []
      if (await tab.locator('[data-testid=public-owner] img').count()) issues.push('没有头像时不该有图片')
      if (!(await tab.locator('[data-testid=public-owner] .kb-avatar-initial').count())) issues.push('没有头像时应画首字母')
      const log = await shareLog(tab)
      if (log.some((entry) => entry.name === 'public:owner-avatar')) issues.push('没有头像就不该去请求头像接口')
      return issues
    },
  },

  'public-user-avatar': {
    // 登录用户打开链接:顶栏右上角是他自己的头像(不是首字母);接口返回的 visitor.avatar 要被用上
    route: '/s/tokUser',
    ready: '[data-testid=shared-doc-edit]',
    fixture: publicPage(
      {
        publicLinks: {
          ...structuredClone(PUBLIC_LINKS),
          tokUser: { ...PUBLIC_LINKS.tokUser, visitor: { ...PUBLIC_LINKS.tokUser.visitor, avatar: 'v1.png' } },
        },
      },
      { __userAvatars: { usr_me: 'v1.png' } },
    ),
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const src = await tab.locator('[data-testid=public-user] img').first().getAttribute('src').catch(() => null)
      if (!src) issues.push('顶栏应显示头像图片,实际是首字母')
      else if (!src.includes('/api/v1/users/usr_me/avatar') || !src.includes('v=v1.png')) issues.push(`头像地址不对:${src}`)
      return issues
    },
  },

  'public-stale-edit': {
    // 笔记已经被改过几次(v3):游客改标题时通过链接拿不到版本,只能猜 v1 → 撞上冲突——如实说明,不丢用户写的内容
    // (后端缺口:get_item 不返回 version;正文走协作落地,不受版本影响,所以正文要保住、标题没保存要说清楚)
    route: '/s/tokStale',
    ready: '[data-testid=shared-doc-edit]',
    fixture: publicEditPage('ins_p2'),
    expectConsole: /status of (403|409)/,
    settle: 500,
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-testid=shared-doc-edit]').click()
      await waitCollabSynced(tab)
      await tab.locator('[data-testid=shared-doc-editor] .ProseMirror').click()
      await tab.keyboard.press('Control+End')
      await tab.keyboard.type('我加的一段很重要的内容')
      await tab.waitForTimeout(400)
      await tab.locator('[data-testid=shared-doc-title-input]').fill('我改的新标题')
      await tab.locator('[data-testid=shared-doc-finish]').click()
      await tab.waitForSelector('[data-testid=shared-doc-save-error]')
      const message = await tab.locator('[data-testid=shared-doc-save-error]').innerText()
      if (!message.includes('内容刚被别人改过')) issues.push(`冲突应如实说明,实际:${message}`)
      if (!message.includes('标题没有保存')) issues.push(`应说清楚没保存的是标题,实际:${message}`)
      if (/version|expected|409|conflict/i.test(message)) issues.push('冲突提示不该露出英文 / 状态码')
      if (!(await tab.locator('[data-testid=shared-doc-editor] .ProseMirror').innerText()).includes('我加的一段很重要的内容')) issues.push('冲突后不该丢掉用户写的内容')
      if ((await tab.locator('[data-testid=shared-doc-title-input]').inputValue()) !== '我改的新标题') issues.push('冲突后不该丢掉用户改的标题')
      if (!(await tab.locator('[data-testid=shared-doc-reload]').count())) issues.push('冲突提示旁应有「重新载入」')
      return issues
    },
  },

  'public-inapp': {
    // 微信内置浏览器:能下载的链接提示「在浏览器中打开」
    route: '/s/tokGuide',
    ready: '[data-testid=shared-doc-title]',
    fixture: publicPage(),
    init: () => Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 MicroMessenger/8.0.40', configurable: true }),
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const note = await tab.locator('[data-testid=public-inapp]').innerText().catch(() => '')
      if (!note.includes('在浏览器中打开')) issues.push('微信里应提示「在浏览器中打开」')
      return issues
    },
  },
}

/**
 * 巡检脚本(sweep / clipcheck 的 --story=share)用的“有内容”的分享数据:我的分享、链接、访问申请、
 * 共享给我、公开页的各种链接都有。不加这个故事时通用 fixture 下这些页面只会显示空状态 / 404 状态页。
 */
export const SHARE_STORY = shareFixture({
  sharedByMe: structuredClone(MINE),
  links: structuredClone(MINE_LINKS),
  accessRequests: structuredClone(REQUESTS),
  sharedWithMe: structuredClone(SHARED_ITEMS),
  spaces: structuredClone(PUBLIC_SPACES),
  publicLinks: structuredClone(PUBLIC_LINKS),
})
