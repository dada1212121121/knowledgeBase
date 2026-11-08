// 通知抽屉的 Playwright 场景:由 viewer-shots.mjs 引入,在设备矩阵 × 引擎下跑。
// 通知用 fixture 的 __notifications 预置(真实的种类和数据形状,见 src/utils/notifications.ts 顶部),实时推送用 pushLive。
import { ALL_FEATURES, NOW, adminMe, pushLive } from './fixture.mjs'
import { profile } from './fixture-social.mjs'
import { rect } from './shell-scenarios.mjs'

const MINUTE = 60_000
const isPhone = (size) => size.width < 600

const zhao = profile('zhaoliu', '赵六')
const qian = profile('qian', '钱七')
const OTHER = { space_id: 'sp_other', collection: 'knowledgeBase/insights' }
const OWN = { space_id: 'sp_primary', collection: 'knowledgeBase/insights' }

/** 40 条:前 8 条各种类,后面 32 条是更早的系统公告(用来验证「加载更多」)。未读 4 条。 */
const notifications = () => [
  { id: 40, kind: 'friend_request', data: { request_id: 'frq_1', from: zhao, message: '我是上周的同事' }, read_at: null, created_at: NOW - 5 * MINUTE },
  { id: 39, kind: 'share_received', data: { key: 'k1', target: { kind: 'insight', id: 'ins_8f21', ...OTHER }, title: 'UDS 断线后 CLI 自动降级为直读 SQLite', count: 1, role: 'editor', role_label: '可编辑', from: qian }, read_at: null, created_at: NOW - 20 * MINUTE },
  { id: 38, kind: 'access_request', data: { request_id: 'ar_1', key: 'k2', target: { kind: 'insight', id: 'ins_7d02', ...OWN }, title: 'rerank 超时 → 降级为向量序', requester: zhao, role: 'editor', role_label: '可编辑', message: '想一起改' }, read_at: null, created_at: NOW - 40 * MINUTE },
  { id: 37, kind: 'collaborator_removed', data: { key: 'k3', target: { kind: 'insight', id: 'ins_old', ...OTHER }, title: '旧的部署清单', from: qian }, read_at: null, created_at: NOW - 90 * MINUTE },
  { id: 36, kind: 'friend_result', data: { accepted: true, via_invite: true, by: qian }, read_at: NOW - MINUTE, created_at: NOW - 3 * 60 * MINUTE },
  { id: 35, kind: 'access_result', data: { request_id: 'ar_0', key: 'k4', target: { kind: 'insight', id: 'ins_8e07', ...OTHER }, title: 'kb search 输出 --json 时 stderr 不能混入进度', approved: true, role: 'viewer', role_label: '可查看', by: qian }, read_at: NOW - MINUTE, created_at: NOW - 5 * 60 * MINUTE },
  { id: 34, kind: 'mention', data: { from: zhao, title: '周报', excerpt: '@你 看一下本周的数据' }, read_at: NOW - MINUTE, created_at: NOW - 8 * 60 * MINUTE },
  { id: 33, kind: 'announcement', data: { title: '今晚维护', body: '23:00 起停机 10 分钟' }, read_at: NOW - MINUTE, created_at: NOW - 24 * 60 * MINUTE },
  ...Array.from({ length: 32 }, (_, index) => ({ id: 32 - index, kind: 'announcement', data: { title: `旧公告 ${32 - index}`, body: '' }, read_at: NOW - MINUTE, created_at: NOW - (30 + index) * 60 * MINUTE })),
]

const fixtureReads = (tab) => tab.evaluate(() => fetch('/api/v1/__fixture/notifications').then((r) => r.json())).then((body) => body.data)
const light = (scenario) => ({ ...scenario, init: () => localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'light' })) })

/** 打开通知抽屉:底部标签栏形态点「通知」标签,其余点顶栏铃铛。 */
async function openDrawer(tab) {
  if (await tab.locator('[data-testid=tabbar]').isVisible().catch(() => false)) await tab.locator('[data-tab=notify]').click()
  else await tab.locator('[data-testid=bell]').first().click()
  await tab.waitForSelector('[data-testid=notification-drawer]', { timeout: 3000 })
  await tab.waitForTimeout(200)
}
const titles = (tab) => tab.locator('[data-testid=notification-item] .kb-nr-title').allInnerTexts()
const badge = (tab) => tab.locator('[data-testid=bell-badge], [data-testid=tab-badge-notify]').first().innerText().then((text) => text.trim()).catch(() => '')

const DRAWER = {
  route: '/home',
  ready: '[data-testid=topbar], [data-testid=tabbar]',
  fixture: { __live: true, __notifications: notifications() },
  settle: 500,
  assert: async (tab, size) => {
    const issues = []
    if ((await badge(tab)) !== '4') issues.push(`角标应是 4,实际「${await badge(tab)}」`)
    await openDrawer(tab)

    // 列表:每条一句人话
    const first = await titles(tab)
    if (first.length !== 30) issues.push(`第一页应有 30 条,实际 ${first.length}`)
    const expected = [
      '赵六(@zhaoliu) 请求加你为好友',
      '钱七 向你分享了「UDS 断线后 CLI 自动降级为直读 SQLite」',
      '赵六 申请「rerank 超时 → 降级为向量序」的可编辑权限',
      '钱七 把你从「旧的部署清单」的协作者中移除了',
      '钱七(@qian) 通过你的邀请码加入,已自动成为你的好友',
    ]
    expected.forEach((title, index) => { if (first[index] !== title) issues.push(`第 ${index + 1} 条应是「${title}」,实际「${first[index]}」`) })
    const rows = await tab.locator('[data-testid=notification-item]').first().innerText()
    if (!rows.includes('“我是上周的同事”') || !rows.includes('好友申请')) issues.push(`第一条应有附言和种类:${rows}`)
    if (!(await tab.locator('[data-testid=notification-unread]').innerText()).includes('4 条未读')) issues.push('应写「4 条未读」')

    // 版面:抽屉在屏幕内;可点区域
    const drawer = await rect(tab, '.kb-drawer')
    if (!drawer || drawer.left < -1 || drawer.right > size.width + 1 || drawer.bottom > size.height + 1) issues.push(`通知抽屉超出了屏幕:${JSON.stringify(drawer)}`)
    if (size.touch) {
      for (const control of await tab.locator('[data-testid=notification-read]').all()) {
        const box = await control.boundingBox()
        if (box && box.height < 35.5) issues.push(`「标为已读」按钮太矮:${box.height}`)
      }
      const rowBox = await tab.locator('[data-testid=notification-item] .kb-nr-main').first().boundingBox()
      if (rowBox && rowBox.height < 43.5) issues.push(`整行可点区域应 ≥ 44:${rowBox.height}`)
    }

    // 筛选
    const filter = async (label) => {
      await tab.locator('[data-testid=notification-filter] [role=tab]').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).click()
      await tab.waitForTimeout(150)
    }
    await filter('好友')
    const friendTitles = await titles(tab)
    if (friendTitles.length !== 2) issues.push(`「好友」应有 2 条(申请 + 邀请码加入),实际 ${friendTitles.length}`)
    await filter('分享')
    if ((await titles(tab)).length !== 4) issues.push(`「分享」应有 4 条(分享、访问申请、被移出、访问结果)`)
    await filter('评论')
    if ((await titles(tab)).length !== 1) issues.push('「评论」应有 1 条(提到我)')
    await filter('系统')
    if ((await titles(tab)).length < 2) issues.push('「系统」应有公告')
    await filter('全部')

    // 加载更多:追加更早的 10 条
    await tab.locator('[data-testid=notification-more]').scrollIntoViewIfNeeded()
    await tab.locator('[data-testid=notification-more]').click()
    await tab.waitForFunction(() => document.querySelectorAll('[data-testid=notification-item]').length === 40, null, { timeout: 4000 }).catch(() => issues.push('点「加载更多」后应有 40 条'))
    if (await tab.locator('[data-testid=notification-more]').count()) issues.push('没有更早的通知后不该再有「加载更多」')
    await tab.locator('[data-testid=notification-list]').evaluate((el) => el.scrollIntoView({ block: 'start' }))

    // 单条已读:被移出协作者没有去处,只能标为已读
    const removedRow = tab.locator('[data-testid=notification-item][data-kind=collaborator_removed]')
    if ((await removedRow.locator('button.kb-nr-main').count()) !== 0) issues.push('被移出协作者没有去处,这一行不该是按钮')
    await removedRow.locator('[data-testid=notification-read]').click()
    await tab.waitForTimeout(300)
    if ((await badge(tab)) !== '3') issues.push(`标一条已读后角标应是 3,实际「${await badge(tab)}」`)
    if ((await fixtureReads(tab)).reads.map((entry) => JSON.stringify(entry)).join() !== '{"ids":[37]}') issues.push('应向服务端发 notification_read {ids:[37]}')

    // 实时:推一条新的,角标 +1、抽屉最上面多一条(未读数以服务端为准)
    pushLive(tab.context(), { type: 'notify', data: { notification: { id: 41, kind: 'friend_request', data: { request_id: 'frq_9', from: qian, message: '' }, read_at: null, created_at: NOW }, unread: 4 } })
    await tab.waitForTimeout(400)
    if ((await badge(tab)) !== '4') issues.push(`实时推来新通知后角标应是 4,实际「${await badge(tab)}」`)
    const live = await titles(tab)
    if (live[0] !== '钱七(@qian) 请求加你为好友') issues.push(`新通知应出现在最上面,实际第一条「${live[0]}」`)
    if (live.length !== 41) issues.push(`新通知进来后应有 41 条,实际 ${live.length}`)

    // 点一条分享:关闭抽屉,标为已读,跳到知识库(别人的知识库带 space)
    await tab.locator('[data-testid=notification-item][data-kind=share_received] .kb-nr-main').click()
    await tab.waitForURL(/\/kb\?/, { timeout: 4000 }).catch(() => issues.push('点收到的分享应跳到知识库'))
    const url = tab.url()
    for (const part of ['item=ins_8f21', 'space=sp_other']) if (!url.includes(part)) issues.push(`跳转地址里应有 ${part}:${url}`)
    if (await tab.locator('[data-testid=notification-drawer]').count()) issues.push('点了通知后抽屉应关闭')
    const reads = (await fixtureReads(tab)).reads.map((entry) => JSON.stringify(entry))
    if (!reads.includes('{"ids":[39]}')) issues.push(`点分享应把它标为已读:${reads.join()}`)

    // 回到抽屉再点好友申请:到好友页的申请页签
    await openDrawer(tab)
    await tab.locator('[data-testid=notification-item][data-kind=friend_request] .kb-nr-main').first().click()
    await tab.waitForURL(/\/friends\?tab=requests/, { timeout: 4000 }).catch(() => issues.push(`点好友申请应到 /friends?tab=requests,实际 ${tab.url()}`))
    return issues
  },
}

const MARK_ALL = {
  route: '/home',
  ready: '[data-testid=topbar], [data-testid=tabbar]',
  fixture: { __live: true, __notifications: notifications() },
  assert: async (tab) => {
    const issues = []
    await openDrawer(tab)
    await tab.getByRole('button', { name: '全部标为已读' }).click()
    await tab.waitForTimeout(400)
    if (await tab.locator('[data-testid=bell-badge], [data-testid=tab-badge-notify]').count()) issues.push('全部已读后角标应消失')
    if (await tab.locator('[data-testid=notification-read]').count()) issues.push('全部已读后不该再有「标为已读」按钮')
    if (!(await tab.locator('[data-testid=notification-unread]').innerText()).includes('没有未读通知')) issues.push('应写「没有未读通知」')
    if ((await fixtureReads(tab)).reads.map((entry) => JSON.stringify(entry)).join() !== '{"all":true}') issues.push('应向服务端发 notification_read {all:true}')
    if (!(await tab.getByRole('button', { name: '全部标为已读' }).isDisabled())) issues.push('没有未读时「全部标为已读」应变灰')
    return issues
  },
}

const EMPTY = {
  route: '/home',
  ready: '[data-testid=topbar], [data-testid=tabbar]',
  fixture: { __notifications: [] },
  assert: async (tab) => {
    const issues = []
    await openDrawer(tab)
    const text = await tab.locator('[data-testid=notification-empty]').innerText().catch(() => '')
    if (!text.includes('还没有通知')) issues.push(`空状态应写「还没有通知」:${text}`)
    await tab.locator('[data-testid=notification-empty]').getByRole('button', { name: '去看看好友' }).click()
    await tab.waitForURL(/\/friends/, { timeout: 4000 }).catch(() => issues.push('「去看看好友」应到好友页'))
    if (await tab.locator('[data-testid=notification-drawer]').count()) issues.push('跳转后抽屉应关闭')
    return issues
  },
}

const ERROR = {
  // 取列表失败:抽屉里有说明 + 重新加载(角标请求失败是静默的);不是一片空白
  route: '/home',
  ready: '[data-testid=topbar], [data-testid=tabbar]',
  fixture: { __notificationsFail: 500 },
  expectConsole: /500/,
  assert: async (tab) => {
    const issues = []
    await openDrawer(tab)
    await tab.waitForSelector('[data-testid=notification-error]', { timeout: 3000 }).catch(() => issues.push('取列表失败应显示报错'))
    const text = await tab.locator('[data-testid=notification-error]').innerText().catch(() => '')
    if (!text.includes('没能加载通知') || !text.includes('重新加载')) issues.push(`报错应有说明和「重新加载」:${text}`)
    if (/sqlite|internal|HTTP/i.test(text)) issues.push(`报错里不该出现英文异常:${text}`)
    return issues
  },
}

const FILTER_EMPTY = {
  // 只有好友类通知时切到「评论」:这一类没有,给出说明和「查看全部」
  route: '/home',
  ready: '[data-testid=topbar], [data-testid=tabbar]',
  fixture: { __notifications: notifications().slice(0, 1) },
  assert: async (tab) => {
    const issues = []
    await openDrawer(tab)
    await tab.locator('[data-testid=notification-filter] [role=tab]').filter({ hasText: '评论' }).click()
    const text = await tab.locator('[data-testid=notification-empty-filter]').innerText().catch(() => '')
    if (!text.includes('评论类通知:目前没有')) issues.push(`这一类没有时应说明:${text}`)
    await tab.locator('[data-testid=notification-empty-filter]').getByRole('button', { name: '查看全部' }).click()
    if ((await titles(tab)).length !== 1) issues.push('点「查看全部」应回到全部')
    return issues
  },
}

const socialLog = (tab) => tab.evaluate(() => fetch('/api/v1/__fixture/social').then((r) => r.json())).then((body) => body.data.log)

const PREFS = {
  // 个人设置里的通知偏好:十种通知按分类列出,开关一拨就保存(只发这一类),刷新后还在;点文字也能切换
  route: '/me',
  ready: '[data-testid=np-friend_request]',
  fixture: { __social: {} },
  settle: 500,
  assert: async (tab, size) => {
    const issues = []
    const checked = (kind) => tab.locator(`[data-testid=np-${kind}]`).getAttribute('aria-checked')
    const card = await rect(tab, '[data-testid=notify-prefs]')
    if (card && (card.left < -1 || card.right > size.width + 1)) issues.push('通知偏好卡片超出了屏幕宽度')
    const heads = await tab.locator('[data-testid=notify-prefs] .kb-np-h').allInnerTexts()
    if (heads.join('|') !== '好友|分享|评论|系统') issues.push(`应按 好友|分享|评论|系统 分组,实际 ${heads.join('|')}`)
    if ((await tab.locator('[data-testid=notify-prefs] [role=switch]').count()) !== 10) issues.push('应有 10 个开关(十种通知)')
    // 默认值:需要马上回应的默认发邮件,噪声大的默认不发
    for (const [kind, want] of [['friend_request', 'true'], ['access_request', 'true'], ['comment_reply', 'false'], ['link_expiring', 'false']]) {
      if ((await checked(kind)) !== want) issues.push(`${kind} 默认应是 ${want}`)
    }
    if (await tab.locator('[data-testid=np-mail-off]').count()) issues.push('站点配好了发信时不该提醒「邮件暂不可用」')
    if (!(await tab.locator('[data-testid=notify-prefs]').innerText()).includes('最多每 10 分钟收到一封')) issues.push('应写明邮件合并规则')

    await tab.locator('[data-testid=np-comment_reply]').click()
    await tab.waitForTimeout(300)
    if ((await checked('comment_reply')) !== 'true') issues.push('拨开评论回复后应为开')
    await tab.locator('[data-testid=np-friend_request]').click()
    await tab.waitForTimeout(300)
    if ((await checked('friend_request')) !== 'false') issues.push('拨关好友申请后应为关')
    // 点文字也能切换;整行在触屏上 ≥ 44
    await tab.locator('[data-testid=np-announcement-text]').click()
    await tab.waitForTimeout(300)
    if ((await checked('announcement')) !== 'true') issues.push('点系统公告的文字应切换它的开关')
    if (size.touch) {
      const row = await rect(tab, '[data-testid=np-announcement-text]')
      if (row && row.height < 43.5) issues.push(`触屏上整行可点区域应 ≥ 44:${row.height}`)
    }
    const writes = (await socialLog(tab)).filter((entry) => entry.name === 'notification_prefs').map((entry) => JSON.stringify(entry.args.email))
    if (writes.join('|') !== '{"comment_reply":true}|{"friend_request":false}|{"announcement":true}') issues.push(`每次只应发改动的那一类:${writes.join('|')}`)

    await tab.reload({ waitUntil: 'networkidle' })
    await tab.waitForSelector('[data-testid=np-friend_request]', { timeout: 5000 })
    if ((await checked('comment_reply')) !== 'true' || (await checked('friend_request')) !== 'false') issues.push('刷新后设置应保持')
    return issues
  },
}

const PREFS_MAIL_OFF = {
  // 站点没配发信 + 邮箱没验证:两条提醒都要有,开关照样能改
  route: '/me',
  ready: '[data-testid=np-friend_request]',
  fixture: { __social: { mailAvailable: false }, __me: { local: false, user: adminMe(ALL_FEATURES, true) } },
  assert: async (tab) => {
    const issues = []
    const off = await tab.locator('[data-testid=np-mail-off]').innerText().catch(() => '')
    if (!off.includes('邮件暂不可用') || !off.includes('配置好以后生效')) issues.push(`应提醒站点没配好发信:${off}`)
    const note = await tab.locator('[data-testid=np-email-note]').innerText().catch(() => '')
    if (!note.includes('验证之前不会收到邮件')) issues.push(`邮箱没验证应提醒:${note}`)
    await tab.locator('[data-testid=np-mention]').click()
    await tab.waitForTimeout(300)
    if ((await tab.locator('[data-testid=np-mention]').getAttribute('aria-checked')) !== 'false') issues.push('提醒归提醒,开关照样能改')
    return issues
  },
}

const PREFS_FAIL = {
  route: '/me',
  ready: '[data-testid=np-friend_request]',
  fixture: { __social: { failPrefsSave: true } },
  expectConsole: /500/,
  assert: async (tab) => {
    const issues = []
    await tab.locator('[data-testid=np-friend_request]').click()
    await tab.waitForSelector('[data-testid=np-save-error]', { timeout: 3000 }).catch(() => issues.push('保存失败应给出原因'))
    if ((await tab.locator('[data-testid=np-friend_request]').getAttribute('aria-checked')) !== 'true') issues.push('保存失败后开关应退回原来的状态')
    const text = await tab.locator('[data-testid=np-save-error]').innerText().catch(() => '')
    if (!text.includes('没能保存') || /sqlite|internal/i.test(text)) issues.push(`失败原因应是人话:${text}`)
    return issues
  },
}

const PREFS_ERROR = {
  route: '/me',
  ready: '[data-testid=np-error]',
  fixture: { __social: { failPrefs: true } },
  expectConsole: /500/,
  assert: async (tab) => {
    const text = await tab.locator('[data-testid=np-error]').innerText()
    return text.includes('没能加载通知偏好') && text.includes('重新加载') ? [] : [`报错应有说明和「重新加载」:${text}`]
  },
}

export const NOTIFICATION_SCENARIOS = {
  'notify-drawer': DRAWER,
  'notify-drawer-light': light(DRAWER),
  'notify-mark-all': MARK_ALL,
  'notify-empty': EMPTY,
  'notify-error': ERROR,
  'notify-filter-empty': FILTER_EMPTY,
  'notify-prefs': PREFS,
  'notify-prefs-light': light(PREFS),
  'notify-prefs-mail-off': PREFS_MAIL_OFF,
  'notify-prefs-fail': PREFS_FAIL,
  'notify-prefs-error': PREFS_ERROR,
}
