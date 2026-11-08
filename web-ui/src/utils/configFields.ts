// 设置页配置表单的字段转换(纯函数,便于单测)。
//
// 页面里原先用 `Number(v) || v` 把输入框的字符串转成数字,`"0"` 会因为 0 是假值而原样
// 保留成字符串;而 `backup.keep_count = 0` / `keep_days = 0` 恰恰表示“不按这一维清理”,
// 写成字符串会被后端当成类型错误。这里单独判空与有限性。

/** 输入框字符串 → 写回配置的值:合法数字转成数字(含 0),其余原样保留交给后端校验。 */
export function numberFieldValue(value: string): number | string {
  const trimmed = value.trim()
  if (trimmed === '') return value
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : value
}
