// 账号类页面(登录 / 注册 / 找回密码 / 个人设置)把失败翻成用户看得懂、知道下一步怎么做的话。
// 术语表(设计稿)的要求:每条报错两句话,先说发生了什么,再说可以怎么做;不直接显示英文异常和状态码。
//
// 之前这些页面都是 `err instanceof Error ? err.message : '登录失败'`:
//   - 断网 / 服务没起来时 fetch 抛 TypeError,message 是浏览器自己的英文(Chrome「Failed to fetch」、Safari「Load failed」),原样显示在表单上方;
//   - 服务端没给原因时 api/client 拼的是「请求失败(502)」,露出状态码,也没说怎么办。
// 服务端给的中文原因(「验证码不对,或者已经用过了」)本来就是写给人看的,照原样用。

const HAS_CJK = /[\u3400-\u9fff]/
/** 浏览器 fetch 断网时抛的 TypeError:Chrome「Failed to fetch」、Safari「Load failed」、Firefox「NetworkError when attempting to fetch resource」。 */
const NETWORK_ERROR = /fetch|network|load failed/i
/** api/client 在服务端没给原因时自己拼的那几句(「请求失败(502)」「登录失败」「验证失败」)——要么只有状态码,要么没有可做的事,不能原样给用户。 */
const BARE_STATUS = /^(请求失败[(（]\d+[)）]|登录失败|验证失败)$/

export const OFFLINE_TEXT = '连不上服务器。检查网络后再试一次。'

/**
 * @param fallback 完整的两句话(发生了什么 + 怎么办),服务端没给出可读原因时用它。
 */
export function accountErrorText(err: unknown, fallback: string): string {
  if (err instanceof TypeError && NETWORK_ERROR.test(err.message)) return OFFLINE_TEXT
  if (err instanceof Error) {
    const raw = err.message.trim()
    if (raw && HAS_CJK.test(raw) && !BARE_STATUS.test(raw)) return raw
  }
  return fallback
}
