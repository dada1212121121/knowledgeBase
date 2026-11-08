// 提示块(`> [!NOTE]`)的类型与判定。纯数据 + 纯函数,不依赖 ProseMirror,
// 所以编辑器外壳的工具栏数据可以直接引用(见 docPlugins.ts 的说明)。
export const CALLOUT_TYPES = {
  note: '说明',
  tip: '提示',
  important: '重要',
  warning: '注意',
  caution: '警告',
} as const
export type CalloutType = keyof typeof CALLOUT_TYPES

/** 引用块首行是不是 `[!NOTE]` 这类标记;是就返回类型和标记长度。 */
export function calloutType(firstLine: string): { type: CalloutType; length: number } | null {
  const match = /^\[!(note|tip|important|warning|caution)\]/i.exec(firstLine)
  return match ? { type: match[1]!.toLowerCase() as CalloutType, length: match[0].length } : null
}
