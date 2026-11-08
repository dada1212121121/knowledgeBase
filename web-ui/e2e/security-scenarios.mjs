import { ALL_FEATURES, adminMe } from './fixture.mjs'

// F1 账号安全的 Playwright 场景:登录页的两步验证一步、个人设置里的两步验证与访问令牌、管理员重置两步验证、
// 站点强制开启时的全局拦截。由 viewer-shots.mjs 引入,在设备矩阵 × 引擎下跑(假接口见 fixture.mjs 的 __totp / __login 等)。

/** 登录:密码对了以后要验证码。挑战 chal-1 有效。 */
const NEEDS_CODE = () => ({ status: 200, body: { logged_in: false, totp_required: true, challenge: 'chal-1' } })

const noOverflow = async (tab, issues, what = '页面') => {
  if ((await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth)) > 1) issues.push(`${what}横向溢出`)
}

/** 夹具记录的两步验证请求。 */
export const totpCalls = (tab) => tab.evaluate(async () => (await (await fetch('/api/v1/__fixture/totp')).json()).data.calls)

/** 浏览器里所有本地存储的内容拼成一个字符串,用来断言「挑战 / 验证码没被存下来」。 */
const storageDump = (tab) =>
  tab.evaluate(() => {
    const parts = []
    for (const store of [localStorage, sessionStorage]) for (let i = 0; i < store.length; i += 1) parts.push(`${store.key(i)}=${store.getItem(store.key(i))}`)
    return parts.join('\n')
  })

async function toCodeStep(tab) {
  await tab.locator('#login-user').fill('alice')
  await tab.locator('#login-pass').fill('Correct-Horse-9')
  await tab.locator('#login-pass').press('Enter')
  await tab.waitForSelector('[data-testid=login-totp]')
}

export const SECURITY_SCENARIOS = {
  'login-totp': {
    // 密码对了 → 验证码一步:自动聚焦、数字键盘、粘贴规整、错误区分、恢复码切换、挑战和验证码不落地
    route: '/login',
    ready: '.auth-box',
    fixture: { __login: NEEDS_CODE },
    // 场景自己模拟的 401(验证码不对)和 429(限速),浏览器会打进控制台
    expectConsole: /status of (401|429)/,
    settle: 300,
    assert: async (tab, size) => {
      const issues = []
      await toCodeStep(tab)
      const text = await tab.evaluate(() => document.body.innerText)
      for (const word of ['两步验证', '6 位数字', '验证并登录', '使用恢复码', '返回,重新输入密码']) if (!text.includes(word)) issues.push(`缺少「${word}」`)
      if (await tab.locator('#login-pass').count()) issues.push('验证码一步不该还留着密码框')
      // 属性:数字键盘 + 一次性验证码自动填充;自动聚焦
      const attrs = await tab.evaluate(() => {
        const input = document.querySelector('.kb-otp-input')
        return { mode: input?.getAttribute('inputmode'), auto: input?.getAttribute('autocomplete'), label: input?.getAttribute('aria-label'), focused: document.activeElement === input }
      })
      if (attrs.mode !== 'numeric') issues.push(`验证码框应弹数字键盘:${attrs.mode}`)
      if (attrs.auto !== 'one-time-code') issues.push(`验证码框应是 one-time-code:${attrs.auto}`)
      if (!attrs.label) issues.push('验证码框缺 aria-label')
      if (!attrs.focused) issues.push('进入这一步后验证码框应自动聚焦')
      const submit = tab.locator('.auth-submit')
      if (!(await submit.isDisabled())) issues.push('没输满 6 位时「验证并登录」应禁用')
      // 六个格子都在可视范围内,够大
      const cells = await tab.locator('.kb-otp-cell').evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ l: r.left, r: r.right, w: r.width, h: r.height })))
      if (cells.length !== 6) issues.push(`应有 6 个格子,实际 ${cells.length}`)
      if (cells.some((cell) => cell.l < 0 || cell.r > size.width)) issues.push('格子超出屏幕')
      if (cells.some((cell) => cell.w < 36 || cell.h < 44)) issues.push(`格子太小:${JSON.stringify(cells[0])}`)
      // 逐个输入:没满之前不能提交;满了才能
      await tab.keyboard.type('12345')
      if (!(await submit.isDisabled())) issues.push('5 位时不该能提交')
      if ((await tab.locator('.kb-otp-cell.is-filled').count()) !== 5) issues.push('输入 5 位后应有 5 个格子填上')
      await tab.keyboard.type('6')
      if (await submit.isDisabled()) issues.push('输满 6 位后应能提交')
      // 非数字被挡掉
      await tab.locator('.kb-otp-input').fill('12ab34')
      if ((await tab.locator('.kb-otp-input').inputValue()) !== '1234') issues.push(`字母应被过滤:${await tab.locator('.kb-otp-input').inputValue()}`)
      // 粘贴:带空格的、全角的
      await tab.locator('.kb-otp-input').fill('481 039')
      if ((await tab.locator('.kb-otp-input').inputValue()) !== '481039') issues.push('粘贴 "481 039" 应规整成 481039')
      await tab.locator('.kb-otp-input').fill('４８１０３９')
      if ((await tab.locator('.kb-otp-input').inputValue()) !== '481039') issues.push('全角数字应规整成半角')
      // 错码:提示"验证码不对",输入清空并重新聚焦,仍停在这一步
      await tab.locator('.kb-otp-input').fill('000000')
      await submit.click()
      await tab.waitForSelector('.auth-error')
      const bad = await tab.locator('.auth-error').innerText()
      if (!bad.includes('验证码不对')) issues.push(`错码提示不对:${bad}`)
      if ((await tab.locator('.kb-otp-input').inputValue()) !== '') issues.push('输错后应清空输入')
      if (!(await tab.evaluate(() => document.activeElement === document.querySelector('.kb-otp-input')))) issues.push('输错后应重新聚焦输入框')
      if ((await tab.locator('[role=alert]').count()) < 1) issues.push('错误应是 role=alert')
      if (!(await tab.locator('.auth-submit').isDisabled())) issues.push('清空后提交按钮应再次禁用')
      // 429:限速话术(不建议换恢复码)
      await tab.locator('.kb-otp-input').fill('429429')
      await submit.click()
      await tab.waitForFunction(() => document.querySelector('.auth-error')?.textContent?.includes('15 分钟'))
      const limited = await tab.locator('.auth-error').innerText()
      if (limited.includes('恢复码')) issues.push(`限速提示不该建议换恢复码:${limited}`)
      if (!(await tab.locator('[data-testid=login-totp]').count())) issues.push('429 不该把人踢回密码页')
      // 对的码:请求体只在 body 里,地址和存储里都没有
      const req = tab.waitForRequest((r) => r.url().includes('/api/v1/auth/login/totp') && r.postData()?.includes('123456'), { timeout: 5000 }).catch(() => null)
      await tab.locator('.kb-otp-input').fill('123456')
      await tab.locator('.kb-otp-input').press('Enter')
      const sent = await req
      if (!sent) issues.push('回车没有提交验证码')
      else {
        const body = JSON.parse(sent.postData() ?? '{}')
        if (body.challenge !== 'chal-1' || body.code !== '123456') issues.push(`请求体不对:${JSON.stringify(body)}`)
        if (sent.headers()['x-kb-csrf'] !== '1') issues.push('缺 x-kb-csrf')
        if (/chal-1|123456/.test(sent.url())) issues.push(`挑战或验证码出现在地址里:${sent.url()}`)
      }
      await tab.waitForURL('**/home', { timeout: 8000 }).catch(() => issues.push(`登录成功后应去首页:${tab.url()}`))
      if (/chal-1|123456|000000/.test(tab.url())) issues.push(`地址里带了挑战 / 验证码:${tab.url()}`)
      const stored = await storageDump(tab)
      if (/chal-1|123456|000000|Correct-Horse/.test(stored)) issues.push('挑战 / 验证码 / 密码被写进了本地存储')
      return issues
    },
  },
  'login-totp-recovery': {
    // 改用恢复码:切换、大小写与空格规整、恢复码错 / 对、再切回验证码、返回重输密码
    route: '/login',
    ready: '.auth-box',
    sizes: ['390x844', '1440x900'],
    fixture: { __login: NEEDS_CODE },
    expectConsole: /status of 401/,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      await toCodeStep(tab)
      await tab.getByRole('button', { name: '使用恢复码' }).click()
      await tab.waitForSelector('#login-recovery')
      if (await tab.locator('.kb-otp').count()) issues.push('恢复码模式不该还显示六格输入')
      if (!(await tab.evaluate(() => document.activeElement?.id === 'login-recovery'))) issues.push('切换后恢复码框应聚焦')
      const text = await tab.evaluate(() => document.body.innerText)
      for (const word of ['恢复码', '只能用一次', '改用验证码']) if (!text.includes(word)) issues.push(`缺少「${word}」`)
      const submit = tab.locator('.auth-submit')
      if (!(await submit.isDisabled())) issues.push('恢复码没填时应禁用')
      await tab.locator('#login-recovery').fill(' abcd efgh j2t3 ')
      if ((await tab.locator('#login-recovery').inputValue()) !== 'ABCDEFGHJ2T3') issues.push(`恢复码应转大写去空格:${await tab.locator('#login-recovery').inputValue()}`)
      // 字母表之外的字符(0 / O / 1 / I / L):形状不对不能提交
      await tab.locator('#login-recovery').fill('ABCD-EFGH-J0T3')
      if (!(await submit.isDisabled())) issues.push('含 0 的恢复码形状不对,不该能提交')
      // 形状对但不是真的恢复码:提示恢复码不对
      await tab.locator('#login-recovery').fill('ZZZZ-ZZZZ-ZZZZ')
      await submit.click()
      await tab.waitForSelector('.auth-error')
      if (!(await tab.locator('.auth-error').innerText()).includes('恢复码不对')) issues.push(`恢复码错的提示不对:${await tab.locator('.auth-error').innerText()}`)
      // 切回验证码:清掉错误和内容
      await tab.getByRole('button', { name: '改用验证码' }).click()
      await tab.waitForSelector('.kb-otp')
      if (await tab.locator('.auth-error').count()) issues.push('切换模式后应清掉上一个错误')
      // 返回重输密码:挑战作废,密码框是空的
      await tab.getByRole('button', { name: '返回,重新输入密码' }).click()
      await tab.waitForSelector('#login-pass')
      if ((await tab.locator('#login-pass').inputValue()) !== '') issues.push('返回后密码框应是空的')
      if (await tab.locator('[data-testid=login-totp]').count()) issues.push('返回后不该还在验证码一步')
      // 再登一次,这回用恢复码成功
      await toCodeStep(tab)
      await tab.getByRole('button', { name: '使用恢复码' }).click()
      await tab.locator('#login-recovery').fill('abcd-efgh-j2t3')
      const req = tab.waitForRequest((r) => r.url().includes('/api/v1/auth/login/totp'), { timeout: 5000 }).catch(() => null)
      await submit.click()
      const sent = await req
      if (!sent) issues.push('没有提交恢复码')
      else if (JSON.parse(sent.postData() ?? '{}').code !== 'ABCD-EFGH-J2T3') issues.push(`恢复码请求体不对:${sent.postData()}`)
      await tab.waitForURL('**/home', { timeout: 8000 }).catch(() => issues.push('恢复码登录后应去首页'))
      return issues
    },
  },
  'login-totp-expired': {
    // 挑战过期(或输错太多次):回到密码一步,并说明怎么办;密码框是空的
    route: '/login',
    ready: '.auth-box',
    sizes: ['390x844', '1440x900'],
    fixture: { __login: () => ({ status: 200, body: { logged_in: false, totp_required: true, challenge: 'chal-expired' } }) },
    expectConsole: /status of 401/,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      await toCodeStep(tab)
      await tab.locator('.kb-otp-input').fill('123456')
      await tab.locator('.auth-submit').click()
      await tab.waitForSelector('#login-pass')
      const error = await tab.locator('.auth-error').innerText()
      if (!error.includes('重新输入密码')) issues.push(`过期提示应说明重新输入密码:${error}`)
      if ((await tab.locator('#login-pass').inputValue()) !== '') issues.push('回到密码一步时密码框应为空')
      await noOverflow(tab, issues)
      return issues
    },
  },
  'login-totp-light': {
    // 浅色主题下验证码一步:格子、焦点环、错误色都看得清(对比度由 lint 的 check-contrast 守;这里留一张图并断言没溢出)
    route: '/login',
    ready: '.auth-box',
    sizes: ['390x844', '1440x900'],
    fixture: { __login: NEEDS_CODE },
    init: `localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'light' }))`,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      await toCodeStep(tab)
      await tab.keyboard.type('481')
      const theme = await tab.evaluate(() => document.documentElement.getAttribute('data-theme'))
      if (theme !== 'light') issues.push(`应是浅色主题:${theme}`)
      await noOverflow(tab, issues)
      return issues
    },
  },
}

// ---------------------------------------------------------------- 个人设置:两步验证

/** 对话框(KbDialog 在手机上是贴底的 sheet,选择器一样)。 */
const flowDialog = (tab) => tab.locator('[data-testid=totp-flow]')
const totpCard = (tab) => tab.locator('[data-testid=totp-card]')

/** 在 OTP 输入框里填 6 位码(对话框里可能同时有别的 OTP,取可见的那个)。 */
const fillOtp = (tab, value) => tab.locator('[data-testid=totp-flow] .kb-otp-input').fill(value)

/** 断言对话框完整落在视口内、没有横向滚动。 */
async function dialogFits(tab, issues, what) {
  const box = await tab.locator('.kb-dialog').boundingBox()
  const view = tab.viewportSize()
  if (!box) return issues.push(`${what}:找不到对话框`)
  if (box.x < -1 || box.x + box.width > view.width + 1) issues.push(`${what}:对话框横向超出视口 ${JSON.stringify(box)}`)
  if (box.y < -1 || box.y + box.height > view.height + 1) issues.push(`${what}:对话框纵向超出视口 ${JSON.stringify(box)}`)
  const inner = await tab.locator('.kb-dialog').evaluate((el) => el.scrollWidth - el.clientWidth)
  if (inner > 1) issues.push(`${what}:对话框内部横向溢出 ${inner}px`)
}

SECURITY_SCENARIOS['me-totp-enable'] = {
  // 未开启 → 重新输密码 → 二维码 + 密钥 + 第一个码 → 恢复码只显示一次(不勾「已保存」关不掉)→ 已开启
  route: '/me',
  ready: '[data-testid=totp-enable]',
  fixture: { __totp: { enabled: false } },
  expectConsole: /status of (401|429)/,
  settle: 300,
  assert: async (tab, size) => {
    const issues = []
    const text = await totpCard(tab).innerText()
    for (const word of ['两步验证', '未开启', '开启两步验证']) if (!text.includes(word)) issues.push(`卡片缺「${word}」`)
    if (text.includes('暂未开放')) issues.push('不该再有「暂未开放」占位')
    await noOverflow(tab, issues, '个人设置')

    // ---- 第 1 步:密码
    await tab.locator('[data-testid=totp-enable]').click()
    await tab.waitForSelector('[data-testid=totp-flow][data-step=password]')
    if (!(await tab.evaluate(() => document.activeElement?.getAttribute('type') === 'password'))) issues.push('打开后密码框应聚焦')
    if (!(await tab.locator('[data-testid=totp-submit]').isDisabled())) issues.push('没填密码时「继续」应禁用')
    await tab.locator('[data-testid=totp-flow] input[type=password]').fill('wrong')
    await tab.locator('[data-testid=totp-submit]').click()
    await tab.waitForSelector('[data-testid=totp-flow] [role=alert]')
    if (!(await flowDialog(tab).innerText()).includes('密码不对')) issues.push(`密码错的提示不对:${await flowDialog(tab).innerText()}`)
    if ((await tab.locator('[data-testid=totp-flow] input[type=password]').inputValue()) !== '') issues.push('密码错之后密码框应清空')
    if (/\/login/.test(tab.url())) issues.push('输错密码不该被当成会话过期跳去登录页')
    await dialogFits(tab, issues, '第 1 步')
    await tab.locator('[data-testid=totp-flow] input[type=password]').fill('old-password-1')
    await tab.locator('[data-testid=totp-flow] input[type=password]').press('Enter')

    // ---- 第 2 步:二维码
    await tab.waitForSelector('[data-testid=totp-flow][data-step=scan] [data-testid=totp-qr] svg')
    const qr = await tab.evaluate(() => {
      const box = document.querySelector('[data-testid=totp-qr]')
      const svg = box?.querySelector('svg')
      const rect = svg?.getBoundingClientRect()
      return {
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
        bg: box ? getComputedStyle(box).backgroundColor : '',
        fill: svg?.querySelector('path') ? getComputedStyle(svg.querySelector('path')).fill : '',
        d: svg?.querySelector('path')?.getAttribute('d')?.length ?? 0,
        viewBox: svg?.getAttribute('viewBox') ?? '',
      }
    })
    if (qr.width < 150 || Math.abs(qr.width - qr.height) > 1) issues.push(`二维码太小或不是正方形:${qr.width}x${qr.height}`)
    if (qr.bg !== 'rgb(255, 255, 255)') issues.push(`二维码底色必须是白色(深色主题下也一样):${qr.bg}`)
    if (qr.fill !== 'rgb(0, 0, 0)') issues.push(`二维码必须是黑色:${qr.fill}`)
    if (qr.d < 500) issues.push('二维码路径太短,像是没画出来')
    // 把二维码单独截图留下来,事后用 zbarimg / OpenCV 扫一遍(见提交说明)
    await tab.locator('[data-testid=totp-qr]').screenshot({ path: `e2e/shots/viewer/totp-qr-${size.name}-${tab.context().browser().browserType().name()}.png` })
    const secret = await tab.locator('[data-testid=totp-secret]').innerText()
    if (secret.trim() !== 'JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP') issues.push(`密钥应四个一组:${secret}`)
    if (!(await flowDialog(tab).innerText()).includes('手动输入')) issues.push('应说明扫不了时可以手动输入')
    const link = await tab.locator('.kb-tf-applink').count()
    const visibleLink = link ? await tab.locator('.kb-tf-applink').isVisible() : false
    // 只在触屏设备上出现(同一台设备上扫不了自己屏幕上的二维码);按输入方式判断,不按宽度
    if (visibleLink !== !!size.touch) issues.push(`「在这台设备的验证器 App 里打开」在 ${size.name}(触屏=${!!size.touch})下${visibleLink ? '不该' : '应该'}显示`)
    if (link && !((await tab.locator('.kb-tf-applink').getAttribute('href')) ?? '').startsWith('otpauth://totp/')) issues.push('打开验证器的链接应是 otpauth://totp/…')
    if (!(await tab.evaluate(() => document.activeElement?.classList.contains('kb-otp-input')))) issues.push('进入第 2 步后验证码框应聚焦')
    await dialogFits(tab, issues, '第 2 步')
    // 错码
    await fillOtp(tab, '000000')
    await tab.locator('[data-testid=totp-submit]').click()
    await tab.waitForFunction(() => document.querySelector('[data-testid=totp-flow] [role=alert]')?.textContent?.includes('验证码不对'))
    if ((await tab.locator('[data-testid=totp-flow] .kb-otp-input').inputValue()) !== '') issues.push('验证码错之后应清空')
    if (!(await flowDialog(tab).innerText()).includes('手机时间')) issues.push('首次确认验证码错时应提示检查手机时间')
    // 对码
    await fillOtp(tab, '123456')
    await tab.locator('[data-testid=totp-submit]').click()

    // ---- 第 3 步:恢复码
    await tab.waitForSelector('[data-testid=totp-flow][data-step=codes] [data-testid=recovery-codes]')
    const shown = await tab.locator('.kb-rc-list code').allInnerTexts()
    if (shown.length !== 8) issues.push(`应显示 8 个恢复码,实际 ${shown.length}`)
    if (new Set(shown).size !== shown.length) issues.push('恢复码不该重复')
    if (!(await flowDialog(tab).innerText()).includes('只显示这一次')) issues.push('应写明「只显示这一次」')
    if (!(await tab.locator('[data-testid=rc-done]').isDisabled())) issues.push('没勾「我已保存」时「完成」应禁用')
    await dialogFits(tab, issues, '第 3 步')
    // 不勾就关不掉:Esc / 点遮罩 / 点右上角关闭 都不行
    await tab.keyboard.press('Escape')
    await tab.mouse.click(2, 2)
    await tab.locator('.kb-dialog-head .btn').click().catch(() => undefined)
    if (!(await tab.locator('[data-testid=totp-flow]').count())) issues.push('没勾「我已保存」时不该能关掉对话框')
    const hint = await flowDialog(tab).innerText()
    if (!hint.includes('请先保存恢复码')) issues.push(`尝试关闭时应提示先保存:${hint}`)
    // 想离开页面:被拦下,确认框在恢复码对话框之上而且点得到;选「回去保存」就留在原地
    await tab.evaluate(() => document.querySelector('a[href="/home"]')?.click())
    await tab.waitForSelector('[role=alertdialog]', { timeout: 3000 }).catch(() => issues.push('没勾「我已保存」就想离开页面,应弹出确认框'))
    if (await tab.locator('[role=alertdialog]').count()) {
      if (!(await tab.locator('[role=alertdialog]').innerText()).includes('恢复码还没保存')) issues.push('离开确认的标题不对')
      await tab.locator('[role=alertdialog] .kb-confirm-btn:not(.is-danger)').click({ timeout: 3000 }).catch(() => issues.push('离开确认框被恢复码对话框盖住了,点不到'))
      await tab.waitForSelector('[role=alertdialog]', { state: 'detached', timeout: 3000 }).catch(() => undefined)
    }
    if (new URL(tab.url()).pathname !== '/me') issues.push(`选了「回去保存」之后应还在个人设置:${tab.url()}`)
    if (!(await tab.locator('[data-testid=totp-flow][data-step=codes]').count())) issues.push('回去保存之后恢复码对话框应还在')
    // 下载:文件名、内容
    const download = tab.waitForEvent('download', { timeout: 5000 }).catch(() => null)
    await tab.locator('[data-testid=rc-download]').click()
    const file = await download
    if (!file) issues.push('点「下载为文本文件」没有触发下载')
    else {
      if (file.suggestedFilename() !== 'recovery-codes-admin.txt') issues.push(`下载文件名不对:${file.suggestedFilename()}`)
      const path = await file.path().catch(() => null)
      if (path) {
        const { readFile } = await import('node:fs/promises')
        const body = await readFile(path, 'utf8')
        for (const code of shown) if (!body.includes(code)) issues.push(`下载的文件里缺恢复码 ${code}`)
        if (!body.includes('只能用一次')) issues.push('下载文件里应写明用法')
      }
    }
    // 复制全部
    await tab.getByRole('button', { name: '复制全部' }).click()
    await tab.waitForFunction(() => document.querySelector('.kb-rc .kb-copy [role=status]')?.textContent?.includes('已复制'), null, { timeout: 4000 }).catch(() => issues.push('复制后应提示已复制'))
    // 勾选后才能完成
    await tab.locator('[data-testid=rc-saved]').check()
    if (await tab.locator('[data-testid=rc-done]').isDisabled()) issues.push('勾选后「完成」应可点')
    await tab.locator('[data-testid=rc-done]').click()
    await tab.waitForSelector('[data-testid=totp-flow]', { state: 'detached' })
    // 恢复码不留在页面上
    const body = await tab.evaluate(() => document.body.innerText)
    for (const code of shown) if (body.includes(code)) issues.push(`关闭后恢复码 ${code} 还留在页面上`)
    // 状态变成已开启
    await tab.waitForSelector('[data-testid=totp-on]')
    const after = await totpCard(tab).innerText()
    for (const word of ['已开启', '剩余恢复码 8 个', '重新生成恢复码', '关闭两步验证']) if (!after.includes(word)) issues.push(`开启后卡片缺「${word}」`)

    // ---- 请求:路径、请求体、CSRF;密码 / 密钥 / 恢复码不落地
    const calls = (await totpCalls(tab)).filter((call) => call.method === 'POST')
    const paths = calls.map((call) => call.path.replace('/api/v1/auth/totp/', ''))
    if (paths.join() !== 'setup,setup,confirm,confirm') issues.push(`请求顺序不对:${paths.join()}`)
    if (calls.some((call) => call.csrf !== '1')) issues.push('两步验证请求缺 x-kb-csrf')
    if (JSON.stringify(calls[1]?.body) !== JSON.stringify({ password: 'old-password-1' })) issues.push(`setup 请求体不对:${JSON.stringify(calls[1]?.body)}`)
    if (JSON.stringify(calls[3]?.body) !== JSON.stringify({ code: '123456' })) issues.push(`confirm 请求体不对:${JSON.stringify(calls[3]?.body)}`)
    const stored = await storageDump(tab)
    if (/old-password-1|JBSWY3DP|ABCD-EFGH/.test(stored)) issues.push('密码 / 密钥 / 恢复码被写进了本地存储')
    if (/old-password-1|JBSWY3DP|ABCD-EFGH|123456/.test(tab.url())) issues.push(`地址里带了敏感内容:${tab.url()}`)
    await noOverflow(tab, issues, '开启后')
    return issues
  },
}

SECURITY_SCENARIOS['me-totp-manage'] = {
  // 已开启:剩余恢复码提醒;重新生成(旧的作废)、关闭(密码 + 恢复码也行)
  route: '/me',
  ready: '[data-testid=totp-on]',
  sizes: ['390x844', '1440x900'],
  fixture: { __totp: { enabled: true, left: 2 } },
  expectConsole: /status of (401|429)/,
  settle: 300,
  assert: async (tab) => {
    const issues = []
    const text = await totpCard(tab).innerText()
    for (const word of ['已开启', '剩余恢复码 2 个', '快用完了', '重新生成恢复码', '关闭两步验证']) if (!text.includes(word)) issues.push(`卡片缺「${word}」`)

    // ---- 重新生成:缺密码 / 码错 / 对
    await tab.locator('[data-testid=totp-regenerate]').click()
    await tab.waitForSelector('[data-testid=totp-flow][data-step=verify]')
    const dialogText = await flowDialog(tab).innerText()
    if (!dialogText.includes('全部作废')) issues.push('应说明旧恢复码会全部作废')
    if (!(await tab.locator('[data-testid=totp-submit]').isDisabled())) issues.push('没填密码和验证码时应禁用')
    await tab.locator('[data-testid=totp-flow] input[type=password]').fill('old-password-1')
    await fillOtp(tab, '654321')
    await tab.locator('[data-testid=totp-submit]').click()
    await tab.waitForFunction(() => document.querySelector('[data-testid=totp-flow] [role=alert]')?.textContent?.includes('验证码不对'))
    if ((await tab.locator('[data-testid=totp-flow] .kb-otp-input').inputValue()) !== '') issues.push('验证码错之后应清空验证码')
    if ((await tab.locator('[data-testid=totp-flow] input[type=password]').inputValue()) !== 'old-password-1') issues.push('只是验证码错时应保留密码,不必重敲')
    await dialogFits(tab, issues, '重新生成')
    await fillOtp(tab, '123456')
    await tab.locator('[data-testid=totp-submit]').click()
    await tab.waitForSelector('[data-testid=totp-flow][data-step=codes]')
    const fresh = await tab.locator('.kb-rc-list code').allInnerTexts()
    if (fresh.length !== 8) issues.push(`新的恢复码应有 8 个,实际 ${fresh.length}`)
    await tab.locator('[data-testid=rc-saved]').check()
    await tab.locator('[data-testid=rc-done]').click()
    await tab.waitForSelector('[data-testid=totp-flow]', { state: 'detached' })
    await tab.waitForFunction(() => document.querySelector('[data-testid=totp-left]')?.textContent?.includes('剩余恢复码 8 个'))
    if ((await totpCard(tab).innerText()).includes('快用完了')) issues.push('重新生成后不该再提示快用完了')

    // ---- 关闭:密码错 → 码对密码对但用恢复码
    await tab.locator('[data-testid=totp-disable]').click()
    await tab.waitForSelector('[data-testid=totp-flow][data-step=verify]')
    if (!(await flowDialog(tab).innerText()).includes('知道你的密码就能登录')) issues.push('关闭前应说明后果')
    await tab.locator('[data-testid=totp-flow] input[type=password]').fill('nope')
    await fillOtp(tab, '123456')
    await tab.locator('[data-testid=totp-submit]').click()
    await tab.waitForFunction(() => document.querySelector('[data-testid=totp-flow] [role=alert]')?.textContent?.includes('密码不对'))
    if ((await tab.locator('[data-testid=totp-flow] input[type=password]').inputValue()) !== '') issues.push('密码错之后应清空密码框')
    await tab.locator('[data-testid=totp-flow] input[type=password]').fill('old-password-1')
    await tab.getByRole('button', { name: /改用恢复码/ }).click()
    await tab.waitForSelector('.kb-cf-recovery')
    if (!(await tab.evaluate(() => document.activeElement?.classList.contains('kb-cf-recovery')))) issues.push('切换后恢复码框应聚焦')
    // 新一批恢复码(第 1 代)的第一个
    await tab.locator('.kb-cf-recovery').fill(fresh[0].toLowerCase())
    await tab.locator('[data-testid=totp-submit]').click()
    await tab.waitForSelector('[data-testid=totp-flow]', { state: 'detached' })
    await tab.waitForSelector('[data-testid=totp-enable]')
    const off = await totpCard(tab).innerText()
    if (!off.includes('未开启')) issues.push(`关闭后应显示未开启:${off}`)
    const disable = (await totpCalls(tab)).filter((call) => call.path.endsWith('/disable') && call.body.password === 'old-password-1')
    if (disable.length !== 1 || disable[0].body.code.replace(/-/g, '') !== fresh[0].replace(/-/g, '')) issues.push(`关闭请求不对:${JSON.stringify(disable)}`)
    await noOverflow(tab, issues)
    return issues
  },
}

SECURITY_SCENARIOS['me-totp-required'] = {
  // 站点要求管理员开启、但还没开:解释原因、聚焦「开启」按钮;开启之后不能再关闭
  route: '/me?need=totp',
  ready: '[data-testid=totp-must]',
  sizes: ['390x844', '1440x900'],
  fixture: { __totp: { enabled: false, required: true } },
  settle: 400,
  assert: async (tab) => {
    const issues = []
    const text = await totpCard(tab).innerText()
    for (const word of ['必须开启', '站点要求管理员账号必须开启两步验证', '开启之前']) if (!text.includes(word)) issues.push(`缺「${word}」`)
    if (!(await tab.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'totp-enable'))) issues.push('被带过来时应聚焦「开启两步验证」')
    const box = await totpCard(tab).boundingBox()
    if (!box || box.y + box.height > tab.viewportSize().height + 1 || box.y < -1) issues.push(`两步验证卡片应滚到可视范围内:${JSON.stringify(box)}`)
    await noOverflow(tab, issues)
    return issues
  },
}

SECURITY_SCENARIOS['me-totp-required-on'] = {
  // 站点要求且已开启:没有「关闭」按钮,并说明原因
  route: '/me',
  ready: '[data-testid=totp-on]',
  sizes: ['390x844', '1440x900'],
  fixture: { __totp: { enabled: true, required: true } },
  settle: 300,
  assert: async (tab) => {
    const issues = []
    if (await tab.locator('[data-testid=totp-disable]').count()) issues.push('站点强制时不该有「关闭两步验证」按钮')
    if (!(await totpCard(tab).innerText()).includes('所以不能关闭')) issues.push('应说明为什么不能关闭')
    if (!(await tab.locator('[data-testid=totp-regenerate]').count())) issues.push('仍然可以重新生成恢复码')
    await noOverflow(tab, issues)
    return issues
  },
}

SECURITY_SCENARIOS['me-totp-error'] = {
  // 报错:给人话 + 可重试;重试会再请求一次
  route: '/me',
  ready: '[data-testid=totp-failure]',
  sizes: ['390x844', '1440x900'],
  fixture: { __totp: { status: 500 } },
  expectConsole: /status of 500/,
  settle: 300,
  assert: async (tab) => {
    const issues = []
    const text = await tab.locator('[data-testid=totp-failure]').innerText()
    if (!text.includes('请重试')) issues.push(`报错应说明怎么办:${text}`)
    if (/500|Failed/.test(text)) issues.push(`不该显示状态码或英文异常:${text}`)
    const before = (await totpCalls(tab)).length
    await tab.getByRole('button', { name: '重试' }).click()
    await tab.waitForFunction(async (n) => (await (await fetch('/api/v1/__fixture/totp')).json()).data.calls.length > n, before)
    if (await tab.locator('[data-testid=totp-enable]').count()) issues.push('服务还是报错时不该显示「开启」')
    await noOverflow(tab, issues)
    return issues
  },
}

SECURITY_SCENARIOS['me-totp-forbidden'] = {
  // 无权限(403):显示统一的「没有开通」话术,不给重试
  route: '/me',
  ready: '[data-testid=totp-failure]',
  sizes: ['390x844', '1440x900'],
  fixture: { __totp: { status: 403 } },
  expectConsole: /status of 403/,
  settle: 300,
  assert: async (tab) => {
    const issues = []
    const text = await tab.locator('[data-testid=totp-failure]').innerText()
    if (!text.includes('没有开通这个功能,请联系管理员')) issues.push(`无权限话术不对:${text}`)
    if (await tab.getByRole('button', { name: '重试' }).count()) issues.push('无权限不该有重试按钮')
    await noOverflow(tab, issues)
    return issues
  },
}

SECURITY_SCENARIOS['me-totp-light'] = {
  // 浅色主题:卡片、对话框的扫码一步、恢复码
  route: '/me',
  ready: '[data-testid=totp-enable]',
  sizes: ['390x844', '1440x900'],
  fixture: { __totp: { enabled: false } },
  init: `localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'light' }))`,
  settle: 300,
  assert: async (tab) => {
    const issues = []
    await tab.locator('[data-testid=totp-enable]').click()
    await tab.locator('[data-testid=totp-flow] input[type=password]').fill('old-password-1')
    await tab.locator('[data-testid=totp-submit]').click()
    await tab.waitForSelector('[data-testid=totp-qr] svg')
    await dialogFits(tab, issues, '浅色·扫码')
    if ((await tab.evaluate(() => document.documentElement.getAttribute('data-theme'))) !== 'light') issues.push('应是浅色主题')
    await noOverflow(tab, issues)
    return issues
  },
}

// ---------------------------------------------------------------- 站点强制开启:全局拦截

const blockedCount = async (tab) => (await totpCalls(tab)).filter((call) => call.blocked).length

SECURITY_SCENARIOS['totp-gate'] = {
  // 管理员还没开两步验证、站点要求必须开:随便打开哪个页面,第一个被拒绝的请求(403 totp_setup_required)
  // 就把人带到个人设置的两步验证区并解释原因;开启之前别的页面进不去;开启之后立刻恢复
  route: '/home',
  ready: '[data-testid=totp-must]',
  fixture: { __totp: { enabled: false, required: true }, __totpGate: true },
  expectConsole: /status of (403|401)/,
  settle: 400,
  assert: async (tab) => {
    const issues = []
    const where = new URL(tab.url())
    if (where.pathname !== '/me' || where.searchParams.get('need') !== 'totp') issues.push(`应被带到 /me?need=totp,实际 ${where.pathname}${where.search}`)
    const text = await totpCard(tab).innerText()
    for (const word of ['必须开启', '站点要求管理员账号必须开启两步验证', '开启之前']) if (!text.includes(word)) issues.push(`缺「${word}」`)
    if (!(await blockedCount(tab))) issues.push('夹具里应有被 403 拒绝的请求(否则这个场景没有测到拦截)')
    if (!(await tab.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'totp-enable'))) issues.push('应聚焦「开启两步验证」')
    // 不是只弹一个报错:页面上没有「加载失败」之类的满屏报错卡片
    const toasts = await tab.locator('.kb-toast, [role=status].kb-toast').count()
    if (toasts > 0) issues.push(`不该弹一堆报错提示条:${toasts}`)
    // 想去别的页面:被拦回来
    const jump = async (href) =>
      tab.evaluate((h) => {
        const link = document.querySelector(`a[href="${h}"]`)
        if (!link) return 'no-link'
        link.click()
        return 'clicked'
      }, href)
    const link = await jump('/kb')
    if (link === 'no-link') issues.push('找不到指向 /kb 的导航链接,没法验证「开启之前去不了别的页面」')
    await tab.waitForTimeout(500)
    if (new URL(tab.url()).pathname !== '/me') issues.push(`开启之前不该能去别的页面:${tab.url()}`)
    // 开启
    await tab.locator('[data-testid=totp-enable]').click()
    await tab.locator('[data-testid=totp-flow] input[type=password]').fill('old-password-1')
    await tab.locator('[data-testid=totp-submit]').click()
    await tab.waitForSelector('[data-testid=totp-qr] svg')
    await fillOtp(tab, '123456')
    await tab.locator('[data-testid=totp-submit]').click()
    await tab.waitForSelector('[data-step=codes]')
    await tab.locator('[data-testid=rc-saved]').check()
    await tab.locator('[data-testid=rc-done]').click()
    await tab.waitForSelector('[data-testid=totp-must]', { state: 'detached' })
    const badge = await tab.locator('[data-testid=totp-badge]').innerText()
    if (badge.trim() !== '已开启') issues.push(`开启后徽标应是「已开启」:${badge}`)
    // 放开:能去别的页面了,而且不再产生被拒绝的请求
    const before = await blockedCount(tab)
    await jump('/kb')
    await tab.waitForURL('**/kb**', { timeout: 8000 }).catch(() => issues.push(`开启后应能去知识库:${tab.url()}`))
    await tab.waitForTimeout(500)
    if ((await blockedCount(tab)) !== before) issues.push('开启后不该再有被拒绝的请求')
    return issues
  },
}

// ---------------------------------------------------------------- 个人设置:访问令牌

const tokenCard = (tab) => tab.locator('[data-testid=token-card]')
const tokenCalls = (tab) => tab.evaluate(async () => (await (await fetch('/api/v1/__fixture/tokens')).json()).data.calls)

SECURITY_SCENARIOS['me-tokens'] = {
  // 列表 → 新建(名称必填 / MCP 与 API / 「包含共享给我的内容」开关)→ 令牌只显示一次并可复制 → 撤销要确认
  route: '/me',
  ready: '[data-testid=token-card] [data-testid=rtable]',
  expectConsole: /status of 409/,
  fixture: { __tokenCreate: (body) => (body.name === 'dup' ? { status: 409, body: { code: 'exists', message: '已有同名令牌:dup' } } : undefined) },
  settle: 300,
  assert: async (tab, size) => {
    const issues = []
    const text = await tokenCard(tab).innerText()
    for (const word of ['访问令牌', 'kiro-demo', 'claude-code', '新建令牌', '只会在创建时显示一次']) if (!text.includes(word)) issues.push(`卡片缺「${word}」`)
    await noOverflow(tab, issues, '个人设置')

    // ---- 新建:名称必填
    await tab.locator('[data-testid=token-new]').click()
    await tab.waitForSelector('[data-testid=token-form]')
    if (!(await tab.locator('[data-testid=token-submit]').isDisabled())) issues.push('没填名称时「创建令牌」应禁用')
    const form = await tab.locator('[data-testid=token-form]').innerText()
    for (const word of ['MCP', 'API', '包含共享给我的内容', '对话上下文', '默认关闭']) if (!form.includes(word)) issues.push(`新建表单缺「${word}」`)
    const sw = tab.locator('[data-testid=token-shared]')
    if ((await sw.getAttribute('aria-checked')) !== 'false') issues.push('「包含共享给我的内容」默认必须是关闭的')
    // 重名:就地提示
    await tab.locator('[data-testid=token-name]').fill('dup')
    await tab.locator('[data-testid=token-submit]').click()
    await tab.waitForFunction(() => document.querySelector('[data-testid=token-form] [role=alert]')?.textContent?.includes('已经有一个叫「dup」'))
    if (!(await tab.locator('[data-testid=token-form]').count())) issues.push('重名失败后应留在表单里让人改名')
    // 开关:MCP 可开;切到 API 变灰并显示关闭;切回 MCP 恢复
    await tab.locator('[data-testid=token-name]').fill('e2e-kiro')
    await sw.click()
    if ((await sw.getAttribute('aria-checked')) !== 'true') issues.push('点开关后应为开启')
    await tab.locator('[data-testid=token-scope-api]').check()
    if ((await sw.getAttribute('aria-checked')) !== 'false' || (await sw.getAttribute('aria-disabled')) !== 'true') issues.push('选 API 后开关应显示关闭且不可点')
    if (!(await tab.locator('[data-testid=token-form]').innerText()).includes('API 令牌用不到')) issues.push('选 API 时应解释为什么用不了这个选项')
    await tab.locator('[data-testid=token-scope-mcp]').check()
    if ((await sw.getAttribute('aria-checked')) !== 'true') issues.push('切回 MCP 后应恢复刚才的选择')
    await dialogFits(tab, issues, '新建令牌')
    await tab.locator('[data-testid=token-submit]').click()

    // ---- 令牌只显示一次
    await tab.waitForSelector('[data-testid=token-done]')
    const secret = (await tab.locator('[data-testid=token-secret]').innerText()).trim()
    if (!/^kb_[0-9a-f]{40,}$/.test(secret)) issues.push(`令牌明文看起来不对:${secret}`)
    const done = await tab.locator('[data-testid=token-done]').innerText()
    for (const word of ['再也看不到', '复制令牌', 'e2e-kiro', 'MCP', '包含']) if (!done.includes(word)) issues.push(`完成页缺「${word}」`)
    await dialogFits(tab, issues, '令牌已创建')
    // 没复制就关:先提醒一次,再点才关
    await tab.locator('[data-testid=token-close]').click()
    if (!(await tab.locator('[data-testid=token-done]').count())) issues.push('没复制令牌就点完成,应先提醒而不是直接关掉')
    if (!(await tab.locator('[data-testid=token-done]').innerText()).includes('还没复制令牌吗')) issues.push('应提醒还没复制')
    await tab.getByRole('button', { name: '复制令牌' }).click()
    await tab.waitForFunction(() => document.querySelector('[data-testid=token-done] .kb-copy [role=status]')?.textContent?.includes('已复制'), null, { timeout: 4000 }).catch(() => issues.push('复制后应提示已复制'))
    await tab.locator('[data-testid=token-close]').click()
    await tab.waitForSelector('[data-testid=token-done]', { state: 'detached' })
    // 关闭后明文不留在页面上、也不在存储和地址里
    if ((await tab.evaluate(() => document.body.innerText)).includes(secret)) issues.push('关闭后令牌明文还留在页面上')
    if ((await storageDump(tab)).includes(secret) || tab.url().includes(secret)) issues.push('令牌明文被写进了存储或地址')
    // 列表里多了一行,标明包含共享内容
    await tab.waitForFunction(() => document.querySelector('[data-testid=token-card]')?.textContent?.includes('e2e-kiro'))
    const row = size.width < 600 ? tab.locator('[data-testid=token-card] [data-testid=rt-card]', { hasText: 'e2e-kiro' }) : tab.locator('[data-testid=token-card] [data-testid=rt-row]', { hasText: 'e2e-kiro' })
    if (!(await row.locator('[data-testid=token-shared-badge]').count())) issues.push('新令牌应标出「包含」共享内容')

    // ---- API 令牌:不带 include_shared
    await tab.locator('[data-testid=token-new]').click()
    await tab.locator('[data-testid=token-name]').fill('ci-script')
    await tab.locator('[data-testid=token-shared]').click()
    await tab.locator('[data-testid=token-scope-api]').check()
    await tab.locator('[data-testid=token-submit]').click()
    await tab.waitForSelector('[data-testid=token-done]')
    await tab.getByRole('button', { name: '复制令牌' }).click()
    await tab.locator('[data-testid=token-close]').click()
    await tab.waitForSelector('[data-testid=token-done]', { state: 'detached' })

    // ---- 撤销:要确认,说明后果
    await tab.waitForFunction(() => document.querySelector('[data-testid=token-card]')?.textContent?.includes('ci-script'))
    const target = size.width < 600 ? tab.locator('[data-testid=token-card] [data-testid=rt-card]', { hasText: 'ci-script' }) : tab.locator('[data-testid=token-card] [data-testid=rt-row]', { hasText: 'ci-script' })
    await target.locator('[data-testid=token-revoke]').click()
    await tab.waitForSelector('[role=alertdialog]')
    const ask = await tab.locator('[role=alertdialog]').innerText()
    if (!ask.includes('立刻失去访问权限')) issues.push(`撤销确认里应写明后果:${ask}`)
    await tab.locator('[role=alertdialog] .kb-confirm-btn.is-danger').click()
    await tab.waitForFunction(() => /已撤销/.test(document.querySelector('[data-testid=token-card]')?.textContent ?? ''), null, { timeout: 5000 })
    if (await target.locator('[data-testid=token-revoke]').count()) issues.push('撤销之后这一行不该再有「撤销」按钮')

    // ---- 请求:路径、请求体、CSRF
    const calls = await tokenCalls(tab)
    const posts = calls.filter((call) => call.method === 'POST')
    if (posts.map((call) => JSON.stringify(call.body)).join('|') !== [
      JSON.stringify({ name: 'dup', scope: 'mcp', include_shared: false }),
      JSON.stringify({ name: 'e2e-kiro', scope: 'mcp', include_shared: true }),
      JSON.stringify({ name: 'ci-script', scope: 'api', include_shared: false }),
    ].join('|')) issues.push(`创建请求体不对:${JSON.stringify(posts.map((call) => call.body))}`)
    if (calls.some((call) => call.csrf !== '1')) issues.push('令牌请求缺 x-kb-csrf')
    const del = calls.filter((call) => call.method === 'DELETE')
    if (del.length !== 1 || !del[0].id.startsWith('kbt_new')) issues.push(`撤销请求不对:${JSON.stringify(del)}`)
    await noOverflow(tab, issues, '撤销后')
    return issues
  },
}

SECURITY_SCENARIOS['me-tokens-empty'] = {
  // 空:一句说明 + 下一步按钮
  route: '/me',
  ready: '[data-testid=token-card] .kb-empty',
  sizes: ['390x844', '1440x900'],
  fixture: { __tokens: [] },
  settle: 300,
  assert: async (tab) => {
    const issues = []
    const text = await tokenCard(tab).innerText()
    if (!text.includes('还没有访问令牌')) issues.push('空状态应说明还没有令牌')
    if (!(await tokenCard(tab).locator('.kb-empty').getByRole('button', { name: '新建令牌' }).count())) issues.push('空状态应给「新建令牌」按钮')
    await tokenCard(tab).locator('.kb-empty').getByRole('button', { name: '新建令牌' }).click()
    await tab.waitForSelector('[data-testid=token-form]')
    await noOverflow(tab, issues)
    return issues
  },
}

SECURITY_SCENARIOS['me-tokens-error'] = {
  // 报错:人话 + 重试;不能悄悄显示成「还没有令牌」
  route: '/me',
  ready: '[data-testid=token-failure]',
  sizes: ['390x844', '1440x900'],
  fixture: { __tokensFail: true },
  expectConsole: /status of 500/,
  settle: 300,
  assert: async (tab) => {
    const issues = []
    const text = await tab.locator('[data-testid=token-failure]').innerText()
    if (!text.includes('令牌服务暂时不可用') || !text.includes('请稍后再试')) issues.push(`报错应带后端的话和下一步:${text}`)
    if ((await tokenCard(tab).innerText()).includes('还没有访问令牌')) issues.push('出错时不能显示成「还没有令牌」')
    if (!(await tab.locator('[data-testid=token-failure]').getByRole('button', { name: '重试' }).count())) issues.push('应有重试按钮')
    if (await tab.locator('[data-testid=token-new]').count()) issues.push('列表读不出来时不该给「新建令牌」')
    await noOverflow(tab, issues)
    return issues
  },
}

SECURITY_SCENARIOS['me-tokens-nofeature'] = {
  // 没开通「API 令牌与 MCP」功能点:整张卡片不出现(两步验证等别的卡片照常)
  route: '/me',
  ready: '[data-testid=totp-card]',
  sizes: ['390x844', '1440x900'],
  fixture: { __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => id !== 'api.tokens')) } },
  settle: 400,
  assert: async (tab) => {
    const issues = []
    if (await tokenCard(tab).count()) issues.push('没有 api.tokens 功能点时不该出现令牌卡片')
    if (!(await totpCard(tab).count())) issues.push('两步验证卡片不受影响')
    return issues
  },
}

// ---------------------------------------------------------------- 管理员:重置用户的两步验证

SECURITY_SCENARIOS['users-totp-reset'] = {
  // 用户详情里「重置两步验证」:二次确认并写明后果 → 请求参数是 user_id → 结果提示如实说
  route: '/admin/users',
  ready: '.kb-ut-tabs',
  fixture: { user_totp_reset: (args) => ({ id: args.user_id, was_enabled: true, sessions_revoked: 3 }) },
  settle: 300,
  assert: async (tab) => {
    const issues = []
    await tab.getByRole('tab', { name: '用户' }).click()
    await tab.locator('.kb-ut-row', { hasText: 'alice' }).click()
    await tab.waitForSelector('[data-testid=user-totp-reset]')
    // 对话框刚出现时还在进场,等它落定再量(WebKit 手机尺寸上刚出现的前一瞬位置偏低)
    await tab.waitForTimeout(400)
    await dialogFits(tab, issues, '用户详情')
    const requests = []
    tab.on('request', (req) => req.url().includes('/capabilities/user_totp_reset') && requests.push(req))
    await tab.locator('[data-testid=user-totp-reset]').scrollIntoViewIfNeeded()
    await tab.locator('[data-testid=user-totp-reset]').click()
    await tab.waitForSelector('[role=alertdialog]')
    const ask = await tab.locator('[role=alertdialog]').innerText()
    for (const word of ['重置「Alice」的两步验证', '所有设备上的登录立即失效', '重新开启', '记入审计']) if (!ask.includes(word)) issues.push(`确认框缺「${word}」:${ask}`)
    if (requests.length) issues.push('确认之前不该发出请求')
    // 取消:还是不发
    await tab.locator('[role=alertdialog] .kb-confirm-btn:not(.is-danger)').click()
    await tab.waitForSelector('[role=alertdialog]', { state: 'detached' })
    if (requests.length) issues.push('取消之后不该发出请求')
    // 确认
    await tab.locator('[data-testid=user-totp-reset]').click()
    await tab.waitForSelector('[role=alertdialog]')
    await tab.locator('[role=alertdialog] .kb-confirm-btn.is-danger').click()
    await tab.waitForFunction(() => /已关掉他的两步验证/.test(document.body.innerText), null, { timeout: 5000 }).catch(() => issues.push('确认后应提示已关掉他的两步验证'))
    if (requests.length !== 1) issues.push(`应发出 1 次请求,实际 ${requests.length}`)
    else {
      const body = JSON.parse(requests[0].postData() ?? '{}')
      if (JSON.stringify(body) !== JSON.stringify({ user_id: 'usr_alice' })) issues.push(`请求体应是 {user_id},实际 ${JSON.stringify(body)}`)
      if (requests[0].headers()['x-kb-csrf'] !== '1') issues.push('缺 x-kb-csrf')
    }
    if (!(await tab.evaluate(() => document.body.innerText)).includes('3 台设备')) issues.push('提示里应有退出的设备数')
    await noOverflow(tab, issues)
    return issues
  },
}

// ---------------------------------------------------------------- 个人设置:登录设备

SECURITY_SCENARIOS['me-devices-error'] = {
  // 登录设备读不出来:人话 + 重试(不是一个红色徽标),重试成功后列表出来;原有的退出场景见 viewer-shots.mjs 的 me-devices
  route: '/me',
  ready: '[data-testid=devices-failure]',
  sizes: ['390x844', '1440x900'],
  fixture: { __sessionsFail: 1 },
  expectConsole: /status of 500/,
  settle: 300,
  assert: async (tab) => {
    const issues = []
    const text = await tab.locator('[data-testid=devices-failure]').innerText()
    if (!text.includes('登录设备暂时读不出来。请重试。')) issues.push(`报错应是「出了什么事 + 怎么办」:${text}`)
    if (await tab.locator('.kb-me-devices').count()) issues.push('读取失败时不该显示设备列表')
    await tab.locator('[data-testid=devices-failure]').getByRole('button', { name: '重试' }).click()
    await tab.waitForSelector('.kb-me-devices li')
    if ((await tab.locator('.kb-me-devices li').count()) !== 3) issues.push('重试成功后应显示 3 台设备')
    if (await tab.locator('[data-testid=devices-failure]').count()) issues.push('重试成功后报错应消失')
    await noOverflow(tab, issues)
    return issues
  },
}

SECURITY_SCENARIOS['me-security-noai'] = {
  // 管理员关掉 AI 之后,界面任何位置都不出现「AI」字样(术语表):两步验证卡片、令牌卡片、新建令牌对话框、开启两步验证对话框都查一遍
  route: '/me',
  ready: '[data-testid=token-card] [data-testid=rtable]',
  sizes: ['390x844', '1440x900'],
  fixture: { __totp: { enabled: false }, __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => !id.startsWith('ai.') && id !== 'search.deep'), false) } },
  settle: 300,
  assert: async (tab) => {
    const issues = []
    const bad = (text) => /\bAI\b/i.test(text)
    if (bad(await totpCard(tab).innerText())) issues.push('两步验证卡片里不该出现「AI」')
    if (bad(await tokenCard(tab).innerText())) issues.push('令牌卡片里不该出现「AI」')
    await tab.locator('[data-testid=token-new]').click()
    await tab.waitForSelector('[data-testid=token-form]')
    if (bad(await tab.locator('.kb-dialog').innerText())) issues.push(`新建令牌对话框里不该出现「AI」:${await tab.locator('.kb-dialog').innerText()}`)
    await tab.locator('[data-testid=token-name]').fill('x')
    await tab.locator('[data-testid=token-submit]').click()
    await tab.waitForSelector('[data-testid=token-done]')
    if (bad(await tab.locator('.kb-dialog').innerText())) issues.push('令牌创建完成页里不该出现「AI」')
    await tab.getByRole('button', { name: '复制令牌' }).click()
    await tab.locator('[data-testid=token-close]').click()
    await tab.waitForSelector('[data-testid=token-done]', { state: 'detached' })
    await tab.locator('[data-testid=totp-enable]').click()
    await tab.locator('[data-testid=totp-flow] input[type=password]').fill('old-password-1')
    await tab.locator('[data-testid=totp-submit]').click()
    await tab.waitForSelector('[data-testid=totp-qr] svg')
    if (bad(await tab.locator('.kb-dialog').innerText())) issues.push('开启两步验证对话框里不该出现「AI」')
    return issues
  },
}
