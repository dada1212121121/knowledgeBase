// 功能点的显示文字。名字和说明来自后端的功能目录(kb-core features.rs),前端不能改后端,
// 但有两处要在显示时处理:
//   1. 「API 令牌与 MCP」:术语表里叫「访问令牌」,界面不再说 API 令牌;
//   2. 没标成 AI 功能、说明里却写了「AI 工具」的(访问令牌那条):AI 总开关关掉后整个界面不能出现「AI」,
//      显示时把这个词拿掉。
import type { FeatureDef } from '@/utils/adminApi'

const LABEL: Record<string, string> = { 'api.tokens': '访问令牌与 MCP' }

/** 去掉文字里的「AI」:「接入 AI 工具」→「接入外部工具」,其余直接删。 */
export function stripAi(text: string): string {
  return text
    .replace(/\s*AI\s*工具/g, '外部工具')
    .replace(/AI\s*/g, '')
    .trim()
}

export function featureLabel(def: Pick<FeatureDef, 'id' | 'label'>, aiOn: boolean): string {
  const label = LABEL[def.id] ?? def.label
  return aiOn ? label : stripAi(label)
}

export function featureHint(def: Pick<FeatureDef, 'hint'>, aiOn: boolean): string {
  return aiOn ? def.hint : stripAi(def.hint)
}

/** AI 总开关关掉后,AI 功能点不列出来(它们的勾选都还保留在角色里,打开后再出现)。 */
export function visibleFeatures<T extends Pick<FeatureDef, 'ai'>>(list: T[], aiOn: boolean): T[] {
  return aiOn ? list : list.filter((def) => !def.ai)
}
