// 管理页统一的「加载 / 空 / 报错 / 无权限」四种状态里,报错和无权限的判定与文案。
//
// 后端对没开通的功能点返回 403「你的账号没有开通这个功能」(AI 被关掉时是「AI 功能已关闭」);
// 其余失败按 GLOSSARY.md 的写法给两句话:发生了什么 + 可以怎么做,不直接露英文异常和状态码。

export type LoadPhase = 'loading' | 'ready' | 'error' | 'forbidden'

export interface Failure {
  phase: 'error' | 'forbidden'
  message: string
}

/** 没开通某个功能时的默认说明(与后端 403 的文案一致,直接访问页面时显示)。 */
export const NO_ACCESS_TEXT = '你的账号没有开通这个功能,请联系管理员。'

const HAS_CJK = /[\u4e00-\u9fff]/
/** 浏览器 fetch 在断网 / 服务没起来时抛的 TypeError:Chrome「Failed to fetch」,Safari「Load failed」,Firefox「NetworkError…」。 */
const NETWORK_ERROR = /fetch|network|load failed/i
const stripEnd = (text: string) => text.replace(/[。.]$/, '')
/**
 * 服务端错误的原话带英文类别前缀(kb-core 的 Error 展示:`internal: …`、`forbidden: …`、`not found: …`、`invalid input: …`),
 * 后面才是给人看的中文。前缀是程序用的,界面上不露(GLOSSARY:不直接显示英文异常)。
 */
const SERVER_PREFIX = /^(?:not found|invalid input|forbidden|unavailable|upstream|internal|already exists|version conflict)\s*[:：]\s*/i

/**
 * 把一次失败的调用归类。
 * - 403:无权限(页面显示未开通的说明,不给「重试」,重试也不会变);
 * - 其它:报错,可重试。服务端给的是中文就带上它(它通常已经说清了原因),否则换成自己的话。
 * `doing` 是「正在做什么」,例如「读取存储用量」,用来拼出第一句。
 */
export function failureOf(err: unknown, doing: string): Failure {
  const status = typeof err === 'object' && err !== null ? (err as { status?: unknown }).status : undefined
  const raw = err instanceof Error ? err.message.trim().replace(SERVER_PREFIX, '') : ''
  if (status === 403) {
    // AI 总开关关了时服务端说的是「AI 功能已关闭」,比泛泛的「没有开通」更有用
    return { phase: 'forbidden', message: HAS_CJK.test(raw) ? `${stripEnd(raw)},请联系管理员。` : NO_ACCESS_TEXT }
  }
  if (status === 401) return { phase: 'error', message: '登录已经过期。请重新登录后再试。' }
  if (HAS_CJK.test(raw)) {
    return { phase: 'error', message: `${doing}失败:${stripEnd(raw)}。请稍后重试,仍然不行请到系统状态页看看服务是否正常。` }
  }
  if (err instanceof TypeError && NETWORK_ERROR.test(raw)) {
    return { phase: 'error', message: `${doing}失败:连不上服务器。请检查网络后重试。` }
  }
  return { phase: 'error', message: `${doing}失败:出现了没有预料到的错误。请刷新页面重试,仍然不行请联系管理员。` }
}

/**
 * 给确认框的 action 用:确认框会把异常的 message 原样显示在框里,
 * 这里先换成「发生了什么 + 可以怎么做」,免得露出后端的英文或状态码。
 */
export async function friendly<T>(promise: Promise<T>, doing: string): Promise<T> {
  try {
    return await promise
  } catch (err) {
    throw new Error(failureOf(err, doing).message)
  }
}
