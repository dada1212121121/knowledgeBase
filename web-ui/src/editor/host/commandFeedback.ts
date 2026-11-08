/**
 * 命令失败时给用户看什么。
 *
 * 工具栏命令的结果原来只用来刷新按钮高亮，`{ ok: false, reason }` 被整个丢掉：
 * 打印被浏览器拦截、导出失败、只读时点修订，用户点了没有任何反应也没有任何解释。
 *
 * 但 `reason` 里有两类东西：给人看的话（「这条评论已经不在了」「请先选中一张图片」）和机器代码
 * （`nothing_to_undo`、`unsupported_command:xxx`、`anchor_lost`）。把后者原样弹给用户比不显示更糟，
 * 所以只显示含汉字的——约定很简单：写给人看的原因用中文写，代码用英文标识符。
 */
import type { CommandResult } from '../types'

const HAS_CJK = /[\u3400-\u9fff]/

/** 这次命令结果该不该给用户一条提示；该则返回提示文字，不该返回空串（成功时也返回空串，用来清掉上一条） */
export function commandFeedback(result: CommandResult): string {
  if (result.ok) return ''
  const reason = result.reason?.trim()
  if (!reason || !HAS_CJK.test(reason)) return ''
  return reason
}

/**
 * 工具栏上点的这个命令，只读时能不能执行。
 *
 * 判据与工具栏「只读时显示哪些按钮」是同一个：声明里没标 `write` 的动作就是非写动作。
 * 原来两边各用一套——按钮可见性看 `action.write`，命令守卫看一份前缀白名单（`view.` / `nav.` / `search.`…）——
 * 结果「打印」「导出」在只读文档里按钮摆着，点下去却被拒绝「文档处于只读模式，无法执行修改命令」。
 * 用 `docx-compare` 打开一份被判为只读的真实文档才暴露出来（可编辑会话里的打印场景永远测不到）。
 *
 * 保守处理：同一个命令若同时被写动作和非写动作使用，当作写命令（宁可拦下，不能放行一个会改文档的操作）。
 */
export function isReadonlySafeToolbarCommand(
  toolbar: ReadonlyArray<{ actions: ReadonlyArray<{ command: string; write?: boolean }> }>,
  commandType: string,
): boolean {
  let found = false
  for (const group of toolbar) {
    for (const action of group.actions) {
      if (action.command !== commandType) continue
      if (action.write) return false
      found = true
    }
  }
  return found
}
