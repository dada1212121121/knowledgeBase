// 管理页(评测 / 系统状态 / 项目与集合)失败时给用户看的话。
//
// 在 loadState.failureOf 的基础上补两件事:
//   1) 后端把错误类别写在 message 前面(`invalid input: 读取黄金集 … 失败`),英文前缀对人没用,先去掉;
//   2) 「下一步怎么办」按页面不同:系统状态页自己就是看服务是否正常的地方,不能再叫人「到系统状态页看看」。
import { failureOf, type Failure } from './loadState'
import { stripErrorPrefix } from './share'

const HAS_CJK = /[\u4e00-\u9fff]/
const stripEnd = (text: string) => text.replace(/[。.]$/, '')

export interface FailureOptions {
  /** 接在第一句后面的「怎么办」;默认让人稍后重试、仍不行就联系管理员。 */
  next?: string
}

export const DEFAULT_NEXT = '请稍后重试,仍然不行请联系管理员。'

/** 把一次失败归类并写成「出了什么事 + 怎么办」。`doing` 是「正在做什么」,例如「读取评测记录」。 */
export function adminFailure(err: unknown, doing: string, options: FailureOptions = {}): Failure {
  const next = options.next ?? DEFAULT_NEXT
  const status = typeof err === 'object' && err !== null ? (err as { status?: unknown }).status : undefined
  const raw = err instanceof Error ? stripErrorPrefix(err.message) : ''
  // 无权限、登录过期、断网这几类 failureOf 已经写得很好,直接用
  if (err instanceof TypeError && !HAS_CJK.test(raw)) return failureOf(err, doing)
  if (status === 403 || status === 401) return failureOf(err instanceof Error ? Object.assign(new Error(raw), { status }) : err, doing)
  if (HAS_CJK.test(raw)) return { phase: 'error', message: `${doing}失败:${stripEnd(raw)}。${next}` }
  return { phase: 'error', message: `${doing}失败:出现了没有预料到的错误。${next}` }
}
