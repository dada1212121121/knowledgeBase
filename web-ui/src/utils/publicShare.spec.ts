import { describe, expect, it } from 'vitest'
import { NICKNAME_MAX, isInAppBrowser, pageTitle, rootLabel, statusFromError, unlockErrorText, validateNickname } from './publicShare'

describe('statusFromError', () => {
  it('每种后端错误码有自己的状态页;失效类不给「重试」(重试没用),需要登录的给「登录」', () => {
    const view = (code: string, status = 410) => statusFromError({ code, status })
    expect(view('link_not_found', 404)).toMatchObject({ title: '这个链接不存在或已失效', action: null })
    expect(view('link_closed')).toMatchObject({ title: '所有者关闭了这个链接', action: null })
    expect(view('link_expired')).toMatchObject({ title: '这个链接已过期', action: null })
    expect(view('link_revoked')).toMatchObject({ title: '这个链接已被撤销', action: null })
    expect(view('link_unavailable')).toMatchObject({ title: '这个链接暂时不可用', action: null })
    expect(view('login_required', 401)).toMatchObject({ action: 'login' })
    expect(view('guests_disabled', 403)).toMatchObject({ action: 'login' })
    expect(view('no_access', 403)).toMatchObject({ action: null })
    expect(view('rate_limited', 429)).toMatchObject({ action: 'retry' })
    expect(statusFromError({ code: 'network', status: 0 })).toMatchObject({ action: 'retry', title: '连不上服务器' })
  })

  it('每条文案都是「发生了什么 + 怎么办」,不含英文异常和状态码', () => {
    for (const code of ['link_not_found', 'link_closed', 'link_expired', 'link_revoked', 'link_unavailable', 'login_required', 'guests_disabled', 'no_access', 'rate_limited', 'network', 'whatever']) {
      const { title, text } = statusFromError({ code, status: 500 })
      expect(`${title}${text}`).not.toMatch(/[A-Za-z]{3,}|\d{3}/)
      expect(text.length).toBeGreaterThan(8)
    }
  })

  it('认不出的错误码按状态码兜底;全都认不出给通用页并可重试', () => {
    expect(statusFromError({ code: 'x', status: 401 }).action).toBe('login')
    expect(statusFromError({ code: 'x', status: 403 }).title).toBe('你没有权限查看这个内容')
    expect(statusFromError({ code: 'x', status: 404 }).title).toBe('这个链接不存在或已失效')
    expect(statusFromError({ code: 'x', status: 410 }).title).toBe('这个链接不存在或已失效')
    expect(statusFromError({ code: 'x', status: 429 }).action).toBe('retry')
    expect(statusFromError({ code: 'x', status: 502 })).toMatchObject({ title: '这个页面没有打开', action: 'retry' })
    expect(statusFromError(null).action).toBe('retry')
  })

  it('保留后端错误码供排查', () => {
    expect(statusFromError({ code: 'link_expired', status: 410 }).code).toBe('link_expired')
  })
})

describe('unlockErrorText', () => {
  it('密码错和被锁是两种文案;被锁时原样用服务端的中文(分「这个来源」和「整条链接」两种)', () => {
    expect(unlockErrorText({ code: 'wrong_password', status: 401 })).toEqual({ text: '访问密码不对,请再试一次。注意区分大小写。', locked: false })
    expect(unlockErrorText({ code: 'locked', status: 429, message: '输错次数太多,请 10 分钟后再试' })).toEqual({ text: '输错次数太多,请 10 分钟后再试', locked: true })
    expect(unlockErrorText({ code: 'locked', status: 429, message: '这个链接被输错密码的次数太多,已暂时锁定,请 10 分钟后再试' }).text).toContain('这个链接被输错密码')
  })
  it('被锁但服务端话不是中文:换成人话;网络 / 其它错误也不露英文', () => {
    expect(unlockErrorText({ status: 429, message: 'Too Many Requests' })).toEqual({ text: '输错次数太多,已暂时锁定。请 10 分钟后再试。', locked: true })
    expect(unlockErrorText({ code: 'network', status: 0 }).text).toBe('连不上服务器。检查网络后重试。')
    expect(unlockErrorText({ status: 500, message: 'boom' }).text).toBe('没有解锁成功,请稍后再试。')
  })
})

describe('validateNickname', () => {
  it('1–20 个字,不含 < >;按字数不是字节数', () => {
    expect(validateNickname('小王')).toBeNull()
    expect(validateNickname('  小王  ')).toBeNull()
    expect(validateNickname('字'.repeat(NICKNAME_MAX))).toBeNull()
    expect(validateNickname('字'.repeat(NICKNAME_MAX + 1))).toContain('最多 20 个字')
    expect(validateNickname('')).toBe('昵称不能为空。')
    expect(validateNickname('   ')).toBe('昵称不能为空。')
    expect(validateNickname('<b>x</b>')).toContain('不能包含')
    expect(validateNickname('a>b')).toContain('不能包含')
    // emoji 占两个 UTF-16 单元,但算一个字
    expect(validateNickname('😀'.repeat(NICKNAME_MAX))).toBeNull()
  })
})

describe('其它', () => {
  it('内置浏览器识别:微信 / QQ / 钉钉 / 飞书;普通浏览器不算', () => {
    expect(isInAppBrowser('Mozilla/5.0 (iPhone) AppleWebKit/605 MicroMessenger/8.0.40')).toBe(true)
    expect(isInAppBrowser('Mozilla/5.0 (Linux; Android 13) MQQBrowser/6.2 QQ/8.9')).toBe(true)
    expect(isInAppBrowser('Mozilla/5.0 (Macintosh) Chrome/120 Safari/537.36')).toBe(false)
    expect(isInAppBrowser('')).toBe(false)
  })

  it('合集里一项的名字:笔记没拿到标题前不露 id', () => {
    expect(rootLabel({ kind: 'insight', id: 'ins_x1' }, {})).toBe('笔记')
    expect(rootLabel({ kind: 'insight', id: 'ins_x1' }, { ins_x1: '部署清单' })).toBe('部署清单')
    expect(rootLabel({ kind: 'file', path: 'docs/a.md' }, {})).toBe('a.md')
    expect(rootLabel({ kind: 'collection', collection: 'proj_x' }, {})).toBe('proj_x')
  })

  it('页面标题:有名字「名字 · 站点」,没有只用站点名', () => {
    expect(pageTitle({ title: '部署清单', site: { name: '团队知识库' } })).toBe('部署清单 · 团队知识库')
    expect(pageTitle({ title: null, site: { name: '团队知识库' } })).toBe('团队知识库')
    expect(pageTitle({ title: null, site: { name: '团队知识库' } }, '回退名')).toBe('回退名 · 团队知识库')
    expect(pageTitle(null)).toBe('知识库')
  })
})
