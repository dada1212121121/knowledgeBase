// 设置页覆盖的配置段清单(只用于对账,页面的表单由 settingsFields.ts 的字段表驱动)。
//
// 后端新增一个配置段时,必须在这里二选一:
//   1) 字段表里有对应字段(设置页有表单 → 自动算进 `SETTINGS_SECTIONS`);或
//   2) 放进 `NOT_IN_THE_FORM`(有专门的页面 / 流程,或只展示不编辑)。
// 漏掉的后果是“页面看起来能改、其实永远不落盘”(阻塞项就是这么来的;
// `llm` 段曾经就是这样被丢下的)。`settingsSections.spec.ts` 会拿 `config.rs` 的 `Config` 顶层字段核对。

import { ALL_FIELDS } from './settingsFields'

/** 一个配置段在设置页里的表单定义。 */
export interface SettingsSection {
  /** 后端配置段名(`[server]` → `server`)。 */
  key: string
  /** 这段里设置页能改(或展示)的字段名。 */
  fields: string[]
}

/** 设置页覆盖的段:从字段表推出,新增字段自动算进来,不会出现“表里有、清单里漏了”。 */
export const SETTINGS_SECTIONS: SettingsSection[] = (() => {
  const byKey = new Map<string, string[]>()
  for (const field of ALL_FIELDS) {
    const [key, name] = field.path.split('.') as [string, string]
    byKey.set(key, [...(byKey.get(key) ?? []), name])
  }
  return [...byKey].map(([key, fields]) => ({ key, fields }))
})()

/** 不在表单里编辑的段(各有专门入口,或只展示)。 */
export const NOT_IN_THE_FORM: string[] = [
  'paths', // 由 KB_HOME 派生,改它会让数据目录搬家,只在 config.toml 里手改
  'network', // 只有「系统参数」页编辑其中的 crawl_allow_private;其余只在启动时生效(代理环境变量)
  'rerank', // 由「组件」页的默认重排器决定
  'accel', // 由「组件」页的 sidecar 安装 / 默认项决定
  'upload', // 上传上限走默认值,页面不暴露
  'retention', // 历史表清理周期由调度器执行,改 config.toml 后重启
  'skills', // 「Skills」分区只展示状态,规则写在 manifest 里
  'log', // 日志级别只在 config.toml 里改
  'mcp', // 「MCP 接入」分区只展示传输状态;传输开关改 config.toml 后重启
  'editor', // 编辑器扩展:打开后管理员的浏览器会运行扩展目录里的脚本,开关只在 config.toml 里改(见 docs/EDITOR_EXTENSIONS.md)
  // 下面这些段在「系统参数」页(utils/systemParams.ts 的字段表)编辑
  'ai',
  'accounts',
  'quota',
  'share',
  'site',
  'admin', // 管理员查看他人知识库的部署开关:默认开;关闭后入口消失、接口 403,只在 config.toml 里改
  'mail',
]
