// 好友页的 Playwright 场景:由 viewer-shots.mjs 引入,在设备矩阵 × 引擎下跑。
// 假后端是有状态的(e2e/fixture-social.mjs),写操作会记进 /api/v1/__fixture/social,场景据此断言「真的发给服务端了」。
import { ALL_FEATURES, NOW, adminMe } from './fixture.mjs'
import { profile } from './fixture-social.mjs'
import { rect } from './shell-scenarios.mjs'

const DAY = 86_400_000
const isPhone = (size) => size.width < 600

const friend = (username, name, extra = {}) => ({ ...profile(username, name), remark: null, group_name: null, since: NOW - 5 * DAY, ...extra })

/** 种子:三个好友(含备注 / 分组 / 汉字名)和几种「搜得到 / 搜不到」的人。 */
const seed = (extra = {}) => ({
  friends: [
    friend('bob', 'Bob', { remark: '产品部小林', group_name: '同事' }),
    friend('carol', 'Carol', { group_name: '家人', since: NOW - 40 * DAY }),
    friend('dave', '大卫'),
  ],
  directory: [
    { profile: profile('bob', 'Bob') },
    { profile: profile('erin', 'Erin'), email: 'erin@example.com' },
    { profile: profile('frank', 'Frank'), searchable: false }, // 不允许被搜到
    { profile: profile('grace', 'Grace'), blockedMe: true }, // 拉黑了我
    { profile: profile('heidi', 'Heidi'), rejectedRecently: true }, // 24 小时内被拒绝过
    { profile: profile('ivan', 'Ivan') },
    { profile: profile('zhaoliu', '赵六') }, // 已经向我发来申请
  ],
  ...extra,
})

/** 申请种子:三条收到的(最后一条其实已在别处处理过)和一条发出的。 */
const requestSeed = (extra = {}) =>
  seed({
    incoming: [
      { id: 'frq_zhao', from: profile('zhaoliu', '赵六'), message: '我是上周的同事,想把部署清单分享给你,方便一起改', created_at: NOW - 2 * 3_600_000, expires_at: NOW + 5 * DAY },
      { id: 'frq_qian', from: profile('qian', '钱七'), message: null, created_at: NOW - 30 * 60_000, expires_at: NOW + 6 * DAY },
      { id: 'frq_sun', from: profile('sun', '孙八'), message: null, created_at: NOW - DAY, expires_at: NOW + 3 * DAY, stale: true },
    ],
    outgoing: [{ id: 'frq_erin', to: profile('erin', 'Erin'), message: '你好', created_at: NOW - DAY, expires_at: NOW + 6 * DAY }],
    ...extra,
  })
const tabText = (tab) => tab.locator('[role=tab]').allInnerTexts().then((list) => list.map((item) => item.replace(/\s+/g, '')))

/** 后端收到的写操作(按顺序)。 */
const serverLog = (tab) => tab.evaluate(() => fetch('/api/v1/__fixture/social').then((r) => r.json())).then((body) => body.data.log)

/** 同一个场景换成浅色主题再跑一遍(外观偏好存在 localStorage)。 */
const light = (scenario) => ({
  ...scenario,
  init: () => localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'light' })),
})

/** 手机上列表是卡片,其余是表格。 */
const rowSelector = (size) => (isPhone(size) ? '[data-testid=rt-card]' : '[data-testid=rt-row]')
const rowNames = (tab, size) => tab.locator(`${rowSelector(size)} b`).allInnerTexts()
/** 面板(手机是底部弹层,其它是对话框)有没有在屏幕里、是不是对应的形态。 */
async function panelIssues(tab, size, label) {
  const issues = []
  const selector = isPhone(size) ? '[data-testid=sheet]' : '.kb-dialog'
  // 弹出有一小段动画(场景里关掉了过渡,但 Vue 的进场 class 要等下一帧才撤掉)
  await tab.waitForTimeout(150)
  const box = await rect(tab, selector)
  if (!box) return [`${label}:手机应是底部弹层、其它应是对话框,但没找到 ${selector}`]
  if (box.left < -1 || box.right > size.width + 1 || box.top < -1 || box.bottom > size.height + 1) issues.push(`${label}超出了屏幕:${JSON.stringify(box)}`)
  return issues
}
/** 按钮里的文字不能从按钮自己的框里漏出来(被 flex 挤窄时会这样,整页溢出检查看不到)。 */
async function buttonFitIssues(tab, label) {
  // 比较文字实际占的框和按钮自己的框(不用 scrollWidth:触屏上撑可点区域的伪元素也会让它变大)
  const bad = await tab.evaluate(() =>
    [...document.querySelectorAll('button.kb-btn, button.btn')]
      .filter((el) => el.offsetParent !== null)
      .filter((el) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        const text = range.getBoundingClientRect()
        const box = el.getBoundingClientRect()
        return text.width > 0 && (text.right > box.right + 1 || text.left < box.left - 1)
      })
      .map((el) => el.textContent.trim().slice(0, 12)),
  )
  return bad.length ? [`${label}:按钮文字超出了按钮自己的框 ${bad.join('、')}`] : []
}

/** 触屏上的按钮:视觉高度 ≥ 36(可点区域靠伪元素撑到 44),电脑不查。 */
async function tapIssues(tab, size, selector, label) {
  if (!size.touch) return []
  const issues = []
  for (const control of await tab.locator(selector).all()) {
    const box = await control.boundingBox()
    if (box && box.height < 35.5) issues.push(`${label}太矮(触屏可点区域不足):${box.height}`)
  }
  return issues
}

const MANAGE = {
    // 列表 / 搜索 / 点开详情改备注 / 删除(带确认)。手机是卡片 + 底部弹层,其它是表格 + 对话框
    route: '/friends',
    ready: '[data-testid=friend-count]',
    fixture: { __social: seed() },
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      // 排序:英文开头的在前,汉字按拼音;备注参与排序
      const names = await rowNames(tab, size)
      if (names.join('|') !== 'Carol|产品部小林|大卫') issues.push(`好友应按显示名排序,实际 ${names.join('|')}`)
      if (!(await tab.locator('[data-testid=friend-count]').innerText()).includes('共 3 位好友')) issues.push('应写「共 3 位好友」')
      const text = await tab.locator('[data-testid=friend-list]').innerText()
      for (const word of ['Bob(@bob)', '同事', '家人', '未分组']) if (!text.includes(word)) issues.push(`列表里缺「${word}」`)
      issues.push(...(await tapIssues(tab, size, '[data-testid=friend-manage-btn]', '「管理」按钮')))
      issues.push(...(await buttonFitIssues(tab, '好友列表')))
      const card = await rect(tab, '[data-testid=friend-list]')
      if (card && (card.left < -1 || card.right > size.width + 1)) issues.push('好友卡片超出了屏幕宽度')

      // 搜索
      await tab.locator('[data-testid=friend-filter]').fill('小林')
      if ((await rowNames(tab, size)).join('|') !== '产品部小林') issues.push('搜「小林」应只剩备注为产品部小林的那一位')
      await tab.locator('[data-testid=friend-filter]').fill('不存在的人')
      if (!(await tab.locator('[data-testid=friend-list]').innerText()).includes('没有符合「不存在的人」的好友')) issues.push('没有匹配时应给出说明')
      await tab.getByRole('button', { name: '清除搜索' }).click()
      if ((await rowNames(tab, size)).length !== 3) issues.push('清除搜索后应回到 3 位好友')

      // 点一行打开详情;改备注保存
      await tab.locator(rowSelector(size)).filter({ hasText: 'Carol' }).click()
      await tab.waitForSelector('[data-testid=friend-manage]', { timeout: 3000 }).catch(() => issues.push('点一行没有打开详情面板'))
      issues.push(...(await panelIssues(tab, size, '详情面板')))
      const inputs = tab.locator('[data-testid=friend-manage] input')
      if ((await inputs.nth(1).inputValue()) !== '家人') issues.push('详情里应带出当前分组「家人」')
      await inputs.nth(0).fill('阿卡')
      await tab.locator('[data-testid=friend-save]').click()
      await tab.waitForSelector('[data-testid=friend-manage]', { state: 'detached', timeout: 3000 }).catch(() => issues.push('保存后面板应关闭'))
      if (!(await rowNames(tab, size)).includes('阿卡')) issues.push('保存后列表里应显示新备注「阿卡」')
      const update = (await serverLog(tab)).find((entry) => entry.name === 'friend_update')
      if (JSON.stringify(update?.args) !== JSON.stringify({ friend_id: 'usr_carol', remark: '阿卡', group_name: '家人' })) issues.push(`没有向服务端发正确的 friend_update:${JSON.stringify(update)}`)

      // 删除:先确认;取消什么都不发生,确认后才真的删
      await tab.getByRole('button', { name: '管理好友:大卫' }).click()
      await tab.locator('[data-testid=friend-remove]').click()
      await tab.waitForSelector('.kb-confirm', { timeout: 3000 }).catch(() => issues.push('删除好友应先弹确认'))
      const confirmText = await tab.locator('.kb-confirm').innerText().catch(() => '')
      for (const word of ['删除好友「大卫」', '不会被收回']) if (!confirmText.includes(word)) issues.push(`确认弹窗里缺「${word}」`)
      // 在确认弹窗里按 Esc 只取消确认,不该连底下的详情面板一起关掉
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('.kb-confirm', { state: 'detached', timeout: 3000 }).catch(() => issues.push('确认弹窗里按 Esc 应取消确认'))
      if (!(await tab.locator('[data-testid=friend-manage]').count())) issues.push('确认弹窗里按 Esc 不该把底下的详情面板一起关掉')
      await tab.locator('[data-testid=friend-remove]').click()
      await tab.waitForSelector('.kb-confirm', { timeout: 3000 })
      await tab.locator('.kb-confirm .kb-confirm-btn').first().click() // 取消
      await tab.waitForSelector('.kb-confirm', { state: 'detached', timeout: 3000 }).catch(() => issues.push('点取消后确认弹窗应关闭'))
      if ((await rowNames(tab, size)).length !== 3) issues.push('取消删除后好友不应变少')
      if ((await serverLog(tab)).some((entry) => entry.name === 'friend_remove')) issues.push('取消删除后不该向服务端发 friend_remove')
      await tab.locator('[data-testid=friend-remove]').click()
      await tab.locator('.kb-confirm-actions .is-danger').click()
      await tab.waitForSelector('[data-testid=friend-manage]', { state: 'detached', timeout: 4000 }).catch(() => issues.push('删除成功后详情面板应关闭'))
      const left = await rowNames(tab, size)
      if (left.join('|') !== '阿卡|产品部小林') issues.push(`删除大卫后应剩 阿卡|产品部小林,实际 ${left.join('|')}`)
      const removed = (await serverLog(tab)).find((entry) => entry.name === 'friend_remove')
      if (removed?.args?.user_id !== 'usr_dave') issues.push(`没有向服务端发 friend_remove:${JSON.stringify(removed)}`)
      return issues
    },
}

const ADD = {
  // 添加好友:搜得到 / 搜不到 / 不允许被搜到 / 拉黑了我(后三者界面上完全一样)/ 已是好友 / 自己 / 发申请的各种结果
  route: '/friends',
  ready: '[data-testid=friend-add]',
  fixture: { __social: seed() },
  // 「24 小时内被拒绝过」那一步后端本来就返回 403,浏览器会把它打进控制台
  expectConsole: /403/,
  settle: 400,
  assert: async (tab, size) => {
    const issues = []
    const query = tab.locator('[data-testid=add-friend-query]')
    const search = async (text) => {
      await query.fill(text)
      await tab.locator('[data-testid=add-friend-search]').click()
      await tab.waitForSelector('[data-testid=add-friend-found], [data-testid=add-friend-notfound], [role=alert]', { timeout: 3000 }).catch(() => issues.push(`搜「${text}」没有出结果`))
    }
    await tab.locator('[data-testid=friend-add]').click()
    await tab.waitForSelector('[data-testid=add-friend]', { timeout: 3000 }).catch(() => issues.push('点「添加好友」没有打开对话框'))
    issues.push(...(await panelIssues(tab, size, '添加好友面板')))
    if (!(await tab.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'add-friend-query'))) issues.push('打开后焦点应在搜索框里')

    // 搜不到的三种情况,界面上一字不差
    const notFound = []
    for (const name of ['nobody', 'frank', 'grace']) {
      await search(name)
      notFound.push(await tab.locator('[data-testid=add-friend-notfound]').innerText().catch(() => `(没出现:${name})`))
    }
    if (new Set(notFound).size !== 1 || !notFound[0].includes('没有找到这个用户')) issues.push(`没这个人 / 不允许被搜到 / 拉黑了我 三种情况的提示应完全一样:${JSON.stringify(notFound)}`)
    if (/拉黑|屏蔽/.test(notFound[0])) issues.push('找不到的提示里不该出现「拉黑」')

    // 自己
    await search('admin')
    if (!(await tab.locator('[role=alert]').allInnerTexts()).join('').includes('这是你自己的账号')) issues.push('搜自己应有说明')
    // 已是好友:只说明情况
    await search('bob')
    if (!(await tab.locator('[data-testid=add-friend-state]').innerText().catch(() => '')).includes('已经是好友')) issues.push('搜到好友应写「已经是好友」')
    if (await tab.locator('[data-testid=add-friend-send]').count()) issues.push('已经是好友不该有「发送申请」按钮')

    // 搜到陌生人:只有头像、昵称、用户名
    await search('erin')
    const found = await tab.locator('[data-testid=add-friend-found]').innerText().catch(() => '')
    if (!found.includes('Erin') || !found.includes('@erin')) issues.push(`搜到的人应显示昵称和用户名:${found}`)
    if (found.includes('erin@example.com')) issues.push('搜索结果不该显示对方的邮箱')
    issues.push(...(await tapIssues(tab, size, '.kb-dialog button, [data-testid=sheet] button', '面板里的按钮')))
    await tab.locator('[data-testid=add-friend-note]').fill('我是上周的同事')
    await tab.locator('[data-testid=add-friend-send]').click()
    await tab.waitForSelector('[data-testid=add-friend-done]', { timeout: 3000 }).catch(() => issues.push('发出申请后应显示结果'))
    if (!(await tab.locator('[data-testid=add-friend-done]').innerText().catch(() => '')).includes('申请已发送')) issues.push('结果应写「申请已发送」')
    const sent = (await serverLog(tab)).find((entry) => entry.name === 'friend_request')
    if (JSON.stringify(sent?.args) !== JSON.stringify({ user_id: 'usr_erin', message: '我是上周的同事' })) issues.push(`没有向服务端发正确的 friend_request:${JSON.stringify(sent)}`)

    // 继续添加:再搜同一个人 = 已经发过申请
    await tab.getByRole('button', { name: '继续添加' }).click()
    await search('erin')
    if (!(await tab.locator('[data-testid=add-friend-state]').innerText().catch(() => '')).includes('已经向对方发过申请')) issues.push('再搜同一个人应写「已经发过申请」')

    // 24 小时内被拒绝过:后端原因显示在面板里,面板不关
    await search('heidi')
    await tab.locator('[data-testid=add-friend-send]').click()
    await tab.waitForTimeout(300)
    if (!(await tab.locator('[data-testid=add-friend-found]').innerText().catch(() => '')).includes('24 小时后再试')) issues.push('被拒绝过的人再申请,应显示「24 小时后再试」')
    if (await tab.locator('[data-testid=add-friend-done]').count()) issues.push('发送失败不该显示成功')

    // Esc 关闭
    await tab.keyboard.press('Escape')
    await tab.waitForSelector('[data-testid=add-friend]', { state: 'detached', timeout: 3000 }).catch(() => issues.push('Esc 应关闭添加好友面板'))
    return issues
  },
}

const EMPTY = {
  route: '/friends',
  ready: '[data-testid=friends-empty]',
  fixture: { __social: seed({ friends: [] }) },
  assert: async (tab) => {
    const issues = []
    const text = await tab.locator('[data-testid=friends-empty]').innerText()
    if (!text.includes('还没有好友')) issues.push('空状态应写「还没有好友」')
    await tab.locator('[data-testid=friends-empty]').getByRole('button', { name: '添加好友' }).click()
    await tab.waitForSelector('[data-testid=add-friend]', { timeout: 3000 }).catch(() => issues.push('空状态里的「添加好友」应打开添加对话框'))
    return issues
  },
}

const ERROR = {
  // 加载失败:说明 + 重新加载;点了会再请求
  route: '/friends',
  ready: '[data-testid=friends-error]',
  fixture: { __social: seed({ failList: true }) },
  expectConsole: /500/,
  assert: async (tab) => {
    const issues = []
    const text = await tab.locator('[data-testid=friends-error]').innerText()
    if (!text.includes('没能加载好友列表') || !text.includes('重新加载')) issues.push(`报错应有说明和「重新加载」:${text}`)
    if (/sqlite|internal|HTTP/i.test(text)) issues.push(`报错里不该出现英文异常:${text}`)
    if (await tab.locator('[data-testid=friend-add]').count() === 0) issues.push('加载失败时「添加好友」入口仍应在')
    return issues
  },
}

const LOADING = {
  // 加载中:先看到骨架屏(好友接口慢 1.5 秒),不是空状态也不是一片空白。
  // 从首页站内跳转过去:直接打开 /friends 的话,等页面「网络空闲」时数据已经到了
  route: '/home',
  ready: '[data-testid=topbar], [data-testid=tabbar]',
  fixture: { __social: seed({ delayMs: 1500 }) },
  settle: 300,
  assert: async (tab) => {
    const issues = []
    await tab.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push('/friends'))
    await tab.waitForSelector('[data-testid=friends]', { timeout: 3000 })
    if (!(await tab.locator('[data-testid=friend-list] .kb-skel').count())) issues.push('接口还没返回时应显示骨架屏')
    if (await tab.locator('[data-testid=friends-empty]').count()) issues.push('加载中不该先闪出「还没有好友」')
    await tab.waitForSelector('[data-testid=friend-count]', { timeout: 6000 }).catch(() => issues.push('接口返回后应显示好友列表'))
    if (await tab.locator('.kb-skel').count()) issues.push('列表出来以后骨架屏应消失')
    return issues
  },
}

const OFF = {
  // 没有 collab.friends:导航里没有「好友」,直接访问显示「没有开通」,不请求任何好友接口
  route: '/friends',
  ready: '[data-testid=friends-off]',
  fixture: { __social: seed(), __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => id !== 'collab.friends'), true) } },
  assert: async (tab) => {
    const issues = []
    const text = await tab.locator('[data-testid=friends-off]').innerText()
    if (!text.includes('你的账号没有开通这个功能') || !text.includes('联系管理员')) issues.push(`应写「你的账号没有开通这个功能,请联系管理员」:${text}`)
    if (await tab.locator('[data-testid=friend-add]').count()) issues.push('没开通时不该有「添加好友」')
    if (await tab.locator('[data-nav-id=friends], [data-tab=friends]').count()) issues.push('没开通时导航里不该有「好友」')
    if (await tab.locator('.kb-nav').count()) {
      if ((await tab.locator('.kb-nav').innerText()).includes('好友')) issues.push('没开通时侧栏里不该有「好友」')
    }
    return issues
  },
}

const NAV = {
  // 导航里有「好友」入口:电脑 / 平板在侧栏,手机在「我的」页;点它到 /friends
  route: '/home',
  ready: '[data-testid=topbar], [data-testid=tabbar]',
  fixture: { __social: seed() },
  settle: 400,
  assert: async (tab, size) => {
    const issues = []
    // 底部标签栏形态(手机、竖屏的折叠屏 / 小平板)没有侧栏,入口在「我的」页里
    if (await tab.locator('[data-testid=tabbar]').isVisible().catch(() => false)) {
      await tab.locator('[data-tab=mine]').click()
      await tab.waitForSelector('[data-testid=mine]', { timeout: 3000 })
      await tab.locator('[data-testid=mine] [data-nav-id=friends]').click().catch(() => issues.push('「我的」页里应有「好友」入口'))
    } else {
      const entry = tab.locator('.kb-nav [data-nav-id=friends], .kb-nav a[href="/friends"]').first()
      if (!(await entry.count())) return [...issues, '侧栏里应有「好友」入口']
      await entry.click()
    }
    await tab.waitForURL(/\/friends/, { timeout: 3000 }).catch(() => issues.push('点「好友」应到 /friends'))
    await tab.waitForSelector('[data-testid=friend-count]', { timeout: 3000 }).catch(() => issues.push('好友页没有渲染好友列表'))
    return issues
  },
}

const REQUESTS = {
  // 申请:页签数字 → 切到申请 → 通过 / 拒绝(带确认)/ 已在别处处理过(404)→ 发出的申请;
  // 再回到好友页签看到新朋友;最后在添加好友里验证「对方先申请过」的路径
  route: '/friends',
  ready: '[data-testid=friend-count]',
  fixture: { __social: requestSeed() },
  // 孙八那一步后端本来就返回 404(申请已在别处处理过),浏览器会把它打进控制台
  expectConsole: /404/,
  settle: 500,
  assert: async (tab, size) => {
    const issues = []
    const rows = (testid) => tab.locator(`[data-testid=${testid}]`).count()
    if ((await tabText(tab)).join('|') !== '好友3|申请3|已拉黑|隐私') issues.push(`页签上应是 好友3|申请3|已拉黑|隐私,实际 ${(await tabText(tab)).join('|')}`)

    await tab.getByRole('tab', { name: /申请/ }).click()
    await tab.waitForSelector('[data-testid=friend-requests]', { timeout: 3000 }).catch(() => issues.push('点「申请」页签没有切过去'))
    if (!tab.url().includes('tab=requests')) issues.push(`切到申请页签后地址里应带 tab=requests:${tab.url()}`)
    if ((await rows('request-in')) !== 3 || (await rows('request-out')) !== 1) issues.push('应有 3 条收到的、1 条发出的申请')
    const text = await tab.locator('[data-testid=friend-requests]').innerText()
    for (const word of ['赵六', '@zhaoliu', '我是上周的同事', '钱七', '等待对方处理', '拒绝会通知对方']) if (!text.includes(word)) issues.push(`申请页里缺「${word}」`)
    issues.push(...(await tapIssues(tab, size, '[data-testid=request-accept], [data-testid=request-reject], [data-testid=request-ignore]', '申请的操作按钮')))
    issues.push(...(await buttonFitIssues(tab, '申请页')))
    const panel = await rect(tab, '[data-testid=friend-requests]')
    if (panel && (panel.left < -1 || panel.right > size.width + 1)) issues.push('申请面板超出了屏幕宽度')

    // 通过赵六
    await tab.locator('[data-testid=request-in]').filter({ hasText: '赵六' }).getByRole('button', { name: '通过' }).click()
    await tab.waitForTimeout(400)
    if ((await rows('request-in')) !== 2) issues.push('通过后收到的申请应剩 2 条')
    // 拒绝钱七:先确认,取消不发,确认才发
    await tab.locator('[data-testid=request-in]').filter({ hasText: '钱七' }).getByRole('button', { name: '拒绝' }).click()
    await tab.waitForSelector('.kb-confirm', { timeout: 3000 }).catch(() => issues.push('拒绝应先弹确认'))
    const confirmText = await tab.locator('.kb-confirm').innerText().catch(() => '')
    if (!confirmText.includes('24 小时内不能再向你申请')) issues.push(`拒绝的确认里应写明后果:${confirmText}`)
    await tab.locator('.kb-confirm .kb-confirm-btn').first().click()
    await tab.waitForSelector('.kb-confirm', { state: 'detached', timeout: 3000 }).catch(() => undefined)
    if ((await serverLog(tab)).some((entry) => entry.name === 'friend_decide' && entry.args.decision === 'reject')) issues.push('取消拒绝后不该向服务端发 reject')
    await tab.locator('[data-testid=request-in]').filter({ hasText: '钱七' }).getByRole('button', { name: '拒绝' }).click()
    await tab.locator('.kb-confirm-actions .kb-confirm-btn').nth(1).click()
    await tab.waitForTimeout(1200)
    if ((await rows('request-in')) !== 1) issues.push('拒绝后收到的申请应剩 1 条')
    // 孙八的申请已在别处处理过:点忽略得到 404,提示 + 列表更新
    await tab.getByRole('button', { name: /忽略孙八/ }).click()
    await tab.waitForSelector('[data-testid=request-error]', { timeout: 3000 }).catch(() => issues.push('已在别处处理过的申请应给出提示'))
    if (!(await tab.locator('[data-testid=request-error]').innerText().catch(() => '')).includes('已经处理过或已过期')) issues.push('提示应写「这条申请已经处理过或已过期」')
    if ((await rows('request-in')) !== 0) issues.push('刷新后这条申请应消失')
    if ((await rows('request-out')) !== 1) issues.push('发出的申请不受影响')
    const log = (await serverLog(tab)).filter((entry) => entry.name === 'friend_decide').map((entry) => `${entry.args.id}:${entry.args.decision}`)
    if (log.join(',') !== 'frq_zhao:accept,frq_qian:reject,frq_sun:ignore') issues.push(`服务端收到的处理不对:${log.join(',')}`)

    // 通过的人出现在好友里
    await tab.getByRole('tab', { name: /好友/ }).click()
    await tab.waitForSelector('[data-testid=friend-count]', { timeout: 3000 })
    if (!(await tab.locator('[data-testid=friend-list]').innerText()).includes('赵六')) issues.push('通过后好友列表里应有赵六')
    return issues
  },
}

const REQUESTS_ADD = {
  // 添加好友 ↔ 申请的联动:发出的申请出现在「我发出的」;对方先申请过时发申请 = 直接成为好友
  route: '/friends?tab=requests',
  ready: '[data-testid=friend-requests]',
  fixture: { __social: requestSeed() },
  settle: 500,
  assert: async (tab) => {
    const issues = []
    const search = async (name) => {
      await tab.locator('[data-testid=add-friend-query]').fill(name)
      await tab.locator('[data-testid=add-friend-search]').click()
      await tab.waitForSelector('[data-testid=add-friend-found]', { timeout: 3000 }).catch(() => issues.push(`搜「${name}」没有找到`))
    }
    if ((await tab.getByRole('tab', { name: /申请/ }).getAttribute('aria-selected')) !== 'true') issues.push('带 tab=requests 打开应落在申请页签')
    // 发一条新的
    await tab.locator('[data-testid=friend-add]').click()
    await search('ivan')
    await tab.locator('[data-testid=add-friend-send]').click()
    await tab.waitForSelector('[data-testid=add-friend-done]', { timeout: 3000 })
    await tab.getByRole('button', { name: '继续添加' }).click()
    // 对方先申请过:按钮是「同意并加为好友」
    await search('zhaoliu')
    const label = await tab.locator('[data-testid=add-friend-send]').innerText().catch(() => '')
    if (!label.includes('同意并加为好友')) issues.push(`对方先申请过时按钮应是「同意并加为好友」,实际「${label}」`)
    await tab.locator('[data-testid=add-friend-send]').click()
    await tab.waitForSelector('[data-testid=add-friend-done]', { timeout: 3000 })
    await tab.getByRole('button', { name: '完成' }).click()
    await tab.waitForTimeout(500)
    const out = await tab.locator('[data-testid=request-out]').allInnerTexts()
    if (out.length !== 2 || !out.join('').includes('Ivan')) issues.push(`「我发出的」里应有 Erin 和 Ivan:${out.join(' / ')}`)
    const incomingNames = await tab.locator('[data-testid=request-in]').allInnerTexts()
    if (incomingNames.join('').includes('赵六')) issues.push('赵六先申请过、我已同意,他那条收到的申请应消失')
    await tab.getByRole('tab', { name: /好友/ }).click()
    await tab.waitForSelector('[data-testid=friend-count]', { timeout: 3000 })
    if (!(await tab.locator('[data-testid=friend-list]').innerText()).includes('赵六')) issues.push('同意后好友列表里应有赵六')
    return issues
  },
}

const REQUESTS_EMPTY = {
  route: '/friends?tab=requests',
  ready: '[data-testid=requests-empty]',
  fixture: { __social: seed() },
  assert: async (tab) => {
    const issues = []
    if (!(await tab.locator('[data-testid=requests-empty]').innerText()).includes('没有待处理的好友申请')) issues.push('空状态应写「没有待处理的好友申请」')
    await tab.locator('[data-testid=requests-empty]').getByRole('button', { name: '添加好友' }).click()
    await tab.waitForSelector('[data-testid=add-friend]', { timeout: 3000 }).catch(() => issues.push('空状态里的「添加好友」应打开添加对话框'))
    return issues
  },
}

const REQUESTS_ERROR = {
  route: '/friends?tab=requests',
  ready: '[data-testid=requests-error]',
  fixture: { __social: seed({ failRequests: true }) },
  expectConsole: /500/,
  assert: async (tab) => {
    const issues = []
    const text = await tab.locator('[data-testid=requests-error]').innerText()
    if (!text.includes('没能加载好友申请') || !text.includes('重新加载')) issues.push(`报错应有说明和「重新加载」:${text}`)
    if (/sqlite|internal|HTTP/i.test(text)) issues.push(`报错里不该出现英文异常:${text}`)
    // 好友页签不受影响
    await tab.getByRole('tab', { name: /好友/ }).click()
    await tab.waitForSelector('[data-testid=friend-count]', { timeout: 3000 }).catch(() => issues.push('申请加载失败不该影响好友列表'))
    return issues
  },
}

const BLOCKS = {
  // 拉黑:从好友详情拉黑(带确认)→ 好友少一个、已拉黑多一个、搜不到对方;从收到的申请拉黑;取消拉黑
  route: '/friends',
  ready: '[data-testid=friend-count]',
  fixture: { __social: requestSeed({ blocked: [{ user: profile('spam_account', '一个名字特别特别特别特别长的骚扰账号用来检查折行'), since: NOW - 3 * DAY }] }) },
  settle: 500,
  assert: async (tab, size) => {
    const issues = []
    const open = (name) => tab.getByRole('tab', { name: new RegExp(name) }).click()
    const rows = (testid) => tab.locator(`[data-testid=${testid}]`).count()

    await open('已拉黑')
    await tab.waitForSelector('[data-testid=block-list]', { timeout: 3000 }).catch(() => issues.push('点「已拉黑」没有切过去'))
    if (!tab.url().includes('tab=blocked')) issues.push(`地址里应带 tab=blocked:${tab.url()}`)
    const listBox = await rect(tab, '[data-testid=block-list]')
    if (listBox && (listBox.left < -1 || listBox.right > size.width + 1)) issues.push('拉黑名单超出了屏幕宽度')
    const first = await tab.locator('[data-testid=block-row]').first().innerText()
    if (!first.includes('@spam_account') || !first.includes('拉黑于')) issues.push(`拉黑名单每行应有用户名和拉黑时间:${first}`)
    issues.push(...(await tapIssues(tab, size, '[data-testid=block-undo]', '「取消拉黑」按钮')))
    issues.push(...(await buttonFitIssues(tab, '拉黑名单')))

    // 从好友详情拉黑 Bob
    await open('好友')
    await tab.getByRole('button', { name: /管理好友:产品部小林/ }).click()
    await tab.locator('[data-testid=friend-block]').click()
    await tab.waitForSelector('.kb-confirm', { timeout: 3000 }).catch(() => issues.push('拉黑应先弹确认'))
    const confirmText = await tab.locator('.kb-confirm').innerText().catch(() => '')
    for (const word of ['拉黑产品部小林?', '不再是好友', '对方不会收到任何通知']) if (!confirmText.includes(word)) issues.push(`拉黑确认里缺「${word}」`)
    const confirmBox = await rect(tab, '.kb-confirm')
    if (confirmBox && (confirmBox.left < -1 || confirmBox.right > size.width + 1 || confirmBox.bottom > size.height + 1)) issues.push('拉黑确认弹窗超出了屏幕')
    await tab.locator('.kb-confirm-actions .kb-confirm-btn').nth(1).click()
    await tab.waitForSelector('[data-testid=friend-manage]', { state: 'detached', timeout: 4000 }).catch(() => issues.push('拉黑成功后详情面板应关闭'))
    await tab.waitForTimeout(300)
    const names = await tab.locator(`${rowSelector(size)} b`).allInnerTexts()
    if (names.includes('产品部小林')) issues.push('拉黑后好友列表里不该再有他')
    // 搜不到对方(后端:拉黑过的人搜索结果为空)
    await tab.locator('[data-testid=friend-add]').click()
    await tab.locator('[data-testid=add-friend-query]').fill('bob')
    await tab.locator('[data-testid=add-friend-search]').click()
    await tab.waitForSelector('[data-testid=add-friend-notfound]', { timeout: 3000 }).catch(() => issues.push('拉黑后搜他应该搜不到'))
    await tab.keyboard.press('Escape')

    // 从收到的申请里拉黑钱七
    await open('申请')
    await tab.locator('[data-testid=request-in]').filter({ hasText: '钱七' }).getByRole('button', { name: /拉黑钱七/ }).click()
    await tab.waitForSelector('.kb-confirm', { timeout: 3000 })
    await tab.locator('.kb-confirm-actions .kb-confirm-btn').nth(1).click()
    await tab.waitForTimeout(1200)
    if ((await tab.locator('[data-testid=request-in]').filter({ hasText: '钱七' }).count()) !== 0) issues.push('拉黑后他的申请应消失')

    // 已拉黑里应有 3 个(原来 1 个 + Bob + 钱七),取消拉黑第一个
    await open('已拉黑')
    await tab.waitForSelector('[data-testid=block-row]', { timeout: 3000 })
    if ((await rows('block-row')) !== 3) issues.push(`已拉黑应有 3 位,实际 ${await rows('block-row')}`)
    await tab.locator('[data-testid=block-row]').filter({ hasText: '钱七' }).getByRole('button', { name: /取消拉黑/ }).click()
    await tab.waitForTimeout(400)
    if ((await rows('block-row')) !== 2) issues.push('取消拉黑后应剩 2 位')
    const log = (await serverLog(tab)).map((entry) => `${entry.name}:${entry.args.user_id}`)
    for (const expected of ['block:usr_bob', 'block:usr_qian', 'unblock:usr_qian']) if (!log.includes(expected)) issues.push(`服务端应收到 ${expected},实际 ${log.join(',')}`)
    // 取消拉黑不会恢复好友
    await open('好友')
    await tab.waitForSelector('[data-testid=friend-count]', { timeout: 3000 })
    if ((await tab.locator(`${rowSelector(size)} b`).allInnerTexts()).includes('产品部小林')) issues.push('取消拉黑不该恢复好友关系')
    return issues
  },
}

const BLOCKS_EMPTY = {
  route: '/friends?tab=blocked',
  ready: '[data-testid=blocks-empty]',
  fixture: { __social: seed() },
  assert: async (tab) => {
    const text = await tab.locator('[data-testid=blocks-empty]').innerText()
    return text.includes('没有拉黑任何人') && text.includes('他们不会知道') ? [] : [`空状态文案不对:${text}`]
  },
}

const BLOCKS_ERROR = {
  route: '/friends?tab=blocked',
  ready: '[data-testid=blocks-error]',
  fixture: { __social: seed({ failBlocks: true }) },
  expectConsole: /500/,
  assert: async (tab) => {
    const text = await tab.locator('[data-testid=blocks-error]').innerText()
    const issues = []
    if (!text.includes('没能加载拉黑名单') || !text.includes('重新加载')) issues.push(`报错应有说明和「重新加载」:${text}`)
    if (/sqlite|internal|HTTP/i.test(text)) issues.push(`报错里不该出现英文异常:${text}`)
    return issues
  },
}

const PRIVACY = {
  // 隐私:读出当前设置;拨开关 / 改分享范围立即保存(只发改动那一项);保存失败时退回并说明
  route: '/friends?tab=privacy',
  ready: '[data-testid=privacy-panel] [data-testid=pv-username]',
  fixture: { __social: seed() },
  settle: 400,
  assert: async (tab, size) => {
    const issues = []
    const checked = (id) => tab.locator(`[data-testid=${id}]`).getAttribute('aria-checked')
    if ((await checked('pv-username')) !== 'true' || (await checked('pv-email')) !== 'false') issues.push('默认:用户名可搜(开)、邮箱不可搜(关)')
    const box = await rect(tab, '[data-testid=privacy-panel]')
    if (box && (box.left < -1 || box.right > size.width + 1)) issues.push('隐私面板超出了屏幕宽度')
    // 开关有读屏名字
    for (const id of ['pv-username', 'pv-email']) {
      const labelledby = await tab.locator(`[data-testid=${id}]`).getAttribute('aria-labelledby')
      if (!labelledby || !(await tab.locator(`#${labelledby}`).innerText().catch(() => '')).includes('搜到我')) issues.push(`开关 ${id} 缺读屏名字`)
    }
    await tab.locator('[data-testid=pv-email]').click()
    await tab.waitForTimeout(300)
    if ((await checked('pv-email')) !== 'true') issues.push('点邮箱开关后应变为开')
    await tab.locator('[data-testid=pv-share] [role=tab]').filter({ hasText: '仅好友' }).click()
    await tab.waitForTimeout(300)
    if (!(await tab.locator('[data-testid=pv-share] .on').innerText()).includes('仅好友')) issues.push('选「仅好友」后应高亮仅好友')
    await tab.locator('[data-testid=pv-username]').click()
    await tab.waitForTimeout(300)
    if ((await checked('pv-username')) !== 'false') issues.push('点用户名开关后应变为关')
    const writes = (await serverLog(tab)).filter((entry) => entry.name === 'set_privacy').map((entry) => JSON.stringify(entry.args))
    const expected = ['{"searchable_by_email":true}', '{"share_from":"friends"}', '{"searchable_by_username":false}']
    if (writes.join('|') !== expected.join('|')) issues.push(`每次只应发改动的那一项:${writes.join('|')}`)
    // 刷新页面后设置还在(真的存到了服务端)
    await tab.reload({ waitUntil: 'networkidle' })
    await tab.waitForSelector('[data-testid=pv-username]', { timeout: 5000 })
    if ((await checked('pv-email')) !== 'true' || (await checked('pv-username')) !== 'false') issues.push('刷新后设置应保持')
    // 开关本身只有 28×16,触屏上点它左边的文字也要能切换;整行高度 ≥ 44
    await tab.locator('[data-testid=pv-email-text]').click()
    await tab.waitForTimeout(300)
    if ((await checked('pv-email')) !== 'false') issues.push('点开关左边的文字也应切换(邮箱开关应变回关)')
    if (size.touch) {
      const row = await rect(tab, '[data-testid=pv-email-text]')
      if (row && row.height < 43.5) issues.push(`触屏上整行可点区域应 ≥ 44:${row.height}`)
    }
    return issues
  },
}

const PRIVACY_FAIL = {
  route: '/friends?tab=privacy',
  ready: '[data-testid=pv-username]',
  fixture: { __social: seed({ failPrivacySave: true }), __me: { local: false, user: adminMe() } },
  expectConsole: /500/,
  assert: async (tab) => {
    const issues = []
    // adminMe 没有邮箱:提醒邮箱搜不到
    if (!(await tab.locator('[data-testid=pv-email-note]').innerText().catch(() => '')).includes('还没有验证')) issues.push('邮箱没验证时应提醒')
    await tab.locator('[data-testid=pv-username]').click()
    await tab.waitForSelector('[data-testid=privacy-save-error]', { timeout: 3000 }).catch(() => issues.push('保存失败应给出原因'))
    if ((await tab.locator('[data-testid=pv-username]').getAttribute('aria-checked')) !== 'true') issues.push('保存失败后开关应退回原来的状态')
    const text = await tab.locator('[data-testid=privacy-save-error]').innerText().catch(() => '')
    if (!text.includes('没能保存隐私设置') || /sqlite|internal/i.test(text)) issues.push(`失败原因应是人话:${text}`)
    return issues
  },
}

const PRIVACY_ERROR = {
  route: '/friends?tab=privacy',
  ready: '[data-testid=privacy-error]',
  fixture: { __social: seed({ failPrivacy: true }) },
  expectConsole: /500/,
  assert: async (tab) => {
    const text = await tab.locator('[data-testid=privacy-error]').innerText()
    return text.includes('没能加载隐私设置') && text.includes('重新加载') ? [] : [`报错应有说明和「重新加载」:${text}`]
  },
}

/** 注册页:用邀请码注册自动加邀请人为好友的提示(注册前的说明 + 注册后以好友列表为准的确认) */
function registerScenario({ autoFriend, expectHint, friends }) {
  return {
    route: '/register?invite=KB-7H2K-AAAA',
    ready: '#reg-invite',
    sizes: ['390x844', '1440x900'],
    fixture: {
      __status: { require_invite: true },
      __social: seed({ friends }),
      ...(autoFriend === undefined
        ? {}
        : { __account: (path) => (path.endsWith('/invite-check') ? { status: 200, body: { valid: true, code: 'KB-7H2K-AAAA', auto_friend: autoFriend } } : undefined) }),
    },
    settle: 700,
    assert: async (tab) => {
      const issues = []
      await tab.waitForSelector('text=邀请码有效', { timeout: 3000 }).catch(() => issues.push('预填的邀请码没有自动核对'))
      const hint = await tab.locator('[data-testid=invite-friend-hint]').innerText().catch(() => '')
      if (hint !== expectHint) issues.push(`好友提示应是「${expectHint}」,实际「${hint}」`)
      if (hint.includes('@')) issues.push('注册前不该透露邀请人是谁')
      await tab.locator('#reg-email').fill('user@example.com')
      await tab.locator('#reg-code').fill('481039')
      await tab.locator('#reg-user').fill('user_yi')
      await tab.locator('#reg-pass').fill('Correct-Horse-9')
      await tab.locator('.auth-submit').click()
      await tab.waitForURL(/\/home/, { timeout: 5000 }).catch(() => issues.push('注册成功后应到首页'))
      const toast = await tab.waitForSelector('text=已和林一成为好友', { timeout: 3000 }).then(() => true).catch(() => false)
      if (friends.length && !toast) issues.push('好友列表里有邀请人时,注册后应提示「已和林一成为好友」')
      if (!friends.length && (await tab.locator('text=成为好友').count())) issues.push('好友列表是空的时,不该提示已成为好友')
      return issues
    },
  }
}
const lin = friend('lin', '林一')

export const FRIENDS_SCENARIOS = {
  'friends-manage': MANAGE,
  'friends-manage-light': light(MANAGE),
  'friends-add': ADD,
  'friends-add-light': light(ADD),
  'friends-empty': EMPTY,
  'friends-error': ERROR,
  'friends-loading': LOADING,
  'friends-off': OFF,
  'friends-nav': NAV,
  'friends-requests': REQUESTS,
  'friends-requests-light': light(REQUESTS),
  'friends-requests-add': REQUESTS_ADD,
  'friends-requests-empty': REQUESTS_EMPTY,
  'friends-requests-error': REQUESTS_ERROR,
  'register-invite-friend': registerScenario({ expectHint: '如果邀请人开启了「自动加好友」,注册后你们会自动成为好友,之后可以在「好友」里改备注或删除。', friends: [lin] }),
  'register-invite-friend-known': registerScenario({ autoFriend: true, expectHint: '注册后你会自动和邀请人成为好友,之后可以在「好友」里改备注或删除。', friends: [lin] }),
  'register-invite-friend-off': registerScenario({ autoFriend: false, expectHint: '', friends: [] }),
  'friends-blocks': BLOCKS,
  'friends-blocks-light': light(BLOCKS),
  'friends-blocks-empty': BLOCKS_EMPTY,
  'friends-blocks-error': BLOCKS_ERROR,
  'friends-privacy': PRIVACY,
  'friends-privacy-light': light(PRIVACY),
  'friends-privacy-fail': PRIVACY_FAIL,
  'friends-privacy-error': PRIVACY_ERROR,
}
