// 审计日志、批次、系统概览「最近事件」里把后端的内部名字换成人话。
//
// 后端写进审计的是能力名(`save_insight`)、操作者 id(`usr_…`)和原始参数 JSON;
// 这些是给程序用的标识,不是给管理员读的文字(GLOSSARY:不露英文键名)。
// 认得的翻成中文;认不得的写「其它操作」,原名只放进 title,出了问题查日志时还能对上。
// 译名里不带「AI」二字:AI 总开关关掉后,历史记录里的这些操作仍然要能读。

const CAPABILITY: Record<string, string> = {
  // 搜索与阅读
  search_knowledge: '搜索',
  search_code: '搜索代码',
  deep_search: '深度检索',
  get_item: '打开内容',
  list_items: '浏览内容',
  item_history: '查看历史版本',
  item_facets: '查看筛选项',
  list_collections: '查看集合',
  file_preview: '预览文件',
  file_raw: '下载原件',
  file_versions: '查看文件版本',
  list_annotations: '查看评论',
  kb_feedback: '评价搜索结果',
  // 写笔记与文件
  save_insight: '保存笔记',
  create_item: '新建内容',
  edit_item: '修改内容',
  delete_item: '删除内容',
  set_item_status: '修改内容状态',
  supersede_insight: '替换笔记',
  batch_tag: '批量打标签',
  save_file: '保存文件',
  csv_edit: '编辑表格',
  csv_read: '读取表格',
  restore_file_version: '恢复文件版本',
  convert_to_markdown: '转成 Markdown',
  add_annotation: '添加评论',
  resolve_annotation: '处理评论',
  delete_annotation: '删除评论',
  // 审核与整理
  list_drafts: '查看审核收件箱',
  review_draft: '审核候选笔记',
  dedup_insights: '查找重复笔记',
  consolidate_project: '归纳项目内容',
  quality_report: '生成质量报告',
  // 项目、来源、导入
  list_projects: '查看项目',
  add_project: '登记项目',
  update_project: '修改项目',
  remove_project: '移除项目',
  delete_collection: '删除集合',
  reindex_project: '重建索引',
  migrate_plan: '估算更换索引模型',
  migrate_model: '更换索引模型',
  list_sources: '查看数据来源',
  add_source: '添加数据来源',
  update_source: '修改数据来源',
  remove_source: '移除数据来源',
  sync_source: '同步数据来源',
  refresh_sources: '刷新数据来源',
  list_ingest: '查看导入记录',
  retry_ingest: '重试导入',
  release_quarantine: '解除隔离',
  pause_batch: '暂停导入批次',
  resume_batch: '继续导入批次',
  cancel_batch: '取消导入批次',
  retry_file_stage: '重试某一步解析',
  skip_file: '跳过文件',
  quarantine_file: '隔离文件',
  get_batch_progress: '查看导入进度',
  get_file_timeline: '查看文件解析过程',
  import_global: '导入全局规范',
  install_hooks: '安装提交钩子',
  uninstall_hooks: '卸载提交钩子',
  // 任务
  job_list: '查看任务',
  job_stats: '查看任务统计',
  job_files: '查看任务的改动文件',
  job_get: '查看任务详情',
  job_cancel: '取消任务',
  // 系统
  stats_overview: '查看系统概览',
  system_status: '查看系统状态',
  get_config: '查看系统参数',
  update_config: '修改系统参数',
  reload_config: '重新加载设置',
  reload_skills: '重新加载 Skills',
  get_skill: '查看 Skill 内容',
  save_skill: '保存 Skill',
  delete_skill: '删除 Skill',
  list_skills: '查看 Skills',
  set_llm_key: '保存模型密钥',
  test_llm: '测试模型连接',
  llm_providers: '查看模型服务商',
  tune_retrieval: '调整检索权重',
  eval_run: '运行评测',
  eval_history: '查看评测记录',
  audit_list: '查看审计日志',
  batch_list: '查看批次',
  revert_batch: '撤销批次',
  env_profile: '检测运行环境',
  recommend_providers: '查看推荐组件',
  provider_list: '查看组件',
  provider_install: '安装组件',
  provider_uninstall: '卸载组件',
  provider_set_default: '设置默认组件',
  ocr_status: '查看文字识别状态',
  set_ocr_backend: '切换文字识别引擎',
  ocr_install: '安装文字识别组件',
  // 备份
  backup_status: '查看备份状态',
  backup_state: '查看备份进度',
  backup_create: '立即备份',
  backup_verify: '校验备份',
  backup_delete: '删除备份',
  backup_prune: '清理旧备份',
  // 访问令牌
  create_token: '创建访问令牌',
  revoke_token: '撤销访问令牌',
  // 助手与编码代理(译名不带「AI」)
  agent_send: '助手对话',
  agent_confirm: '确认助手操作',
  agent_history: '查看助手对话',
  agent_sessions: '查看助手对话列表',
  agent_delete_session: '删除助手对话',
  agent_compress: '压缩助手对话',
  agent_rename_session: '重命名助手对话',
  agent_pin_session: '置顶助手对话',
  acp_chat: '编码代理对话',
  acp_cancel: '中断编码代理',
  acp_agents: '查看编码代理',
  acp_save_agent: '保存编码代理',
  acp_remove_agent: '移除编码代理',
  acp_set_permission: '设置编码代理权限',
  acp_install: '安装编码代理',
  acp_uninstall: '卸载编码代理',
  acp_set_default: '设置默认编码代理',
  acp_set_sandbox: '设置编码代理隔离',
  acp_test: '测试编码代理',
  // 账号与权限
  feature_catalog: '查看功能清单',
  role_list: '查看角色',
  role_create: '新建角色',
  role_update: '修改角色',
  role_delete: '删除角色',
  user_list: '查看用户',
  user_get: '查看用户详情',
  user_create: '新建账号',
  user_update: '修改账号',
  user_feature: '调整用户的功能',
  user_set_password: '重设用户密码',
  user_totp_reset: '重置两步验证',
  invite_list: '查看邀请码',
  invite_create: '生成邀请码',
  invite_revoke: '撤销邀请码',
  invite_uses: '查看邀请码使用记录',
  storage_overview: '查看存储用量',
  llm_usage_overview: '查看额度用量',
  usage_mine: '查看我的用量',
  share_admin_list: '查看全站分享链接',
  share_admin_revoke: '强制撤销分享链接',
}

/** 能力名 → 中文操作名;认不得的统一写「其它操作」。 */
export const capabilityText = (name: string): string => CAPABILITY[name] ?? '其它操作'

/** 要调用大模型或外部编码代理的能力:AI 总开关关掉后,系统概览的「最近事件」不再列它们。 */
export const isAiCapability = (name: string): boolean =>
  name.startsWith('agent_') || name.startsWith('acp_') || ['deep_search', 'review_draft', 'dedup_insights', 'consolidate_project', 'quality_report', 'test_llm', 'set_llm_key', 'llm_providers', 'list_drafts'].includes(name)

/** 审计日志「按操作筛选」下拉里列出的常用写操作(后端按能力名精确匹配)。 */
export const AUDIT_FILTERS: { value: string; label: string }[] = [
  'save_insight',
  'edit_item',
  'delete_item',
  'review_draft',
  'reindex_project',
  'migrate_model',
  'revert_batch',
  'update_config',
  'user_update',
  'user_set_password',
  'role_update',
  'invite_create',
  'create_token',
  'share_admin_revoke',
  'backup_create',
].map((value) => ({ value, label: capabilityText(value) }))

/** 进化事件的种类(EventKind);系统概览「最近事件」里会出现。 */
const EVENT_KIND: Record<string, string> = {
  git_commit: '提交了代码',
  git_merge: '合并了分支',
  git_checkout: '切换了分支',
  session_end: '一次对话结束',
  file_change: '文件有改动',
  manual: '手动触发',
  // 夜间质量门禁:命中率回退时写一条,和别的进化事件一起出现在概览的「最近事件」里
  quality_gate: '夜间质量门禁',
}
export const eventKindText = (kind: string): string => EVENT_KIND[kind] ?? '其它事件'

/**
 * 操作者:后端写的是用户 id(`usr_…`)、`mcp:<客户端名>`、`local`/`user`,
 * 通过分享链接操作的是 `usr_…(经链接 lnk_…)`。
 * `names` 能查到用户名就用名字(审计页在有「用户」功能时会查一次);查不到只留 id 的末六位,不露整串。
 */
export function actorText(actor: string, names?: ReadonlyMap<string, string>): string {
  const text = actor.trim()
  if (!text) return '—'
  if (text === 'local' || text === 'user') return '本机'
  if (text.startsWith('mcp:')) return `MCP 客户端 ${text.slice(4)}`
  const viaLink = /^(.+?)\(经链接 [^)]*\)$/.exec(text)
  const id = viaLink ? viaLink[1]! : text
  const who = names?.get(id) ?? (/^usr_/.test(id) ? `用户 …${id.slice(-6)}` : id)
  return viaLink ? `${who}(经分享链接)` : who
}

const ARG_LABEL: Record<string, string> = {
  query: '查询',
  collection: '集合',
  project: '项目',
  id: '编号',
  path: '路径',
  mode: '方式',
  title: '标题',
  name: '名称',
  status: '状态',
  kind: '类型',
  batch_id: '批次',
  job_id: '任务',
  user_id: '用户',
  role_id: '角色',
  feature: '功能',
  source: '来源',
  took_ms: '耗时',
}
const MAX_VALUE = 40

/**
 * 参数 JSON → 一行人话,例如 `查询「重试」· 集合 proj/docs`。
 * 只认得常见的键;认不得的键不写出来(英文键名对管理员没用),原文留给 title。
 * 对象 / 数组 / 空值跳过,长值截断;JSON 解析失败返回空串。
 */
export function argsSummary(argsJson: string | null | undefined): string {
  if (!argsJson) return ''
  let value: unknown
  try {
    value = JSON.parse(argsJson)
  } catch {
    return ''
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ''
  const parts: string[] = []
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const label = ARG_LABEL[key]
    if (!label || (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean')) continue
    let shown = String(raw)
    if (shown === '') continue
    if (shown.length > MAX_VALUE) shown = `${shown.slice(0, MAX_VALUE)}…`
    parts.push(key === 'query' ? `${label}「${shown}」` : key === 'took_ms' ? `${label} ${shown} 毫秒` : `${label} ${shown}`)
  }
  return parts.join(' · ')
}

/** 批次的说明:后端默认写成「<能力名> 调用」,把能力名换成中文;写了别的说明就原样用。 */
export function batchTitle(description: string): string {
  const match = /^([a-z][a-z0-9_]*) 调用$/.exec(description.trim())
  return match ? capabilityText(match[1]!) : description
}
