// 配额覆盖(角色 / 单个用户的 quota_json)的纯逻辑。
// 三层:全站默认(系统参数) → 角色覆盖 → 用户覆盖,越具体越优先;覆盖里没写的键沿用上一层。
// 后端只认 QuotaConfig 里已有的键、且值必须是非负整数,其余忽略(config.rs `with_overrides`)。

export interface QuotaField {
  key: string
  label: string
  unit?: string
  /** 允许的最小值;0 有特殊含义的才允许填 0 */
  min: number
  /** 填 0 的含义(只有 min 为 0 的字段有) */
  zero?: string
  /** 调用大模型 / 编码代理的项:AI 总开关关掉后编辑器里不列出(已有的覆盖值保留) */
  ai?: boolean
}

/**
 * 适合按人 / 按角色覆盖的项。全站同时会话数、保留空间是全站级的,不在这里。
 * 编码代理的三项(`acp_concurrency_total` / `acp_concurrency_per_user` / `acp_minutes`)后端能存、能合出来,但没有任何代码读它们:
 * 真正限流的是 acp.toml 的 max_agents / max_per_user / turn_timeout_secs。放在界面上会让管理员以为改了就生效,所以不列。
 * 想加回来,先让后端真的读,再改这里和 systemParams.ts。
 */
export const QUOTA_FIELDS: QuotaField[] = [
  { key: 'storage_gb', label: '存储配额', unit: 'GB', min: 0, zero: '0 = 不限' },
  { key: 'max_upload_mb', label: '单个文件上限', unit: 'MB', min: 1 },
  // 额度的单位是 token,但界面按术语表只说「额度」,不写 token
  { key: 'llm_tokens_per_day', label: '每天 AI 额度', min: 0, zero: '0 = 不限', ai: true },
  { key: 'links_per_user', label: '分享链接数上限', min: 0, zero: '0 = 不能创建' },
  { key: 'friends_per_user', label: '好友数上限', min: 0, zero: '0 = 不能加好友' },
]

export type QuotaDraft = Record<string, string>

/** 解析 quota_json;不是 JSON 对象就当没有覆盖。只留非负整数。 */
export function parseQuota(json: string | null | undefined): Record<string, number> {
  if (!json) return {}
  try {
    const value: unknown = JSON.parse(json)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    const out: Record<string, number> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === 'number' && Number.isInteger(item) && item >= 0) out[key] = item
    }
    return out
  } catch {
    return {}
  }
}

export function toQuotaDraft(json: string | null | undefined): QuotaDraft {
  const quota = parseQuota(json)
  const draft: QuotaDraft = {}
  for (const field of QUOTA_FIELDS) draft[field.key] = field.key in quota ? String(quota[field.key]) : ''
  return draft
}

/**
 * 草稿 → 要提交的覆盖对象:空 = 沿用上一层(不写这个键);编辑器不认识的键原样保留,免得保存时悄悄丢掉。
 * 不合法返回错误文案。
 */
export function buildQuota(draft: QuotaDraft, originalJson: string | null | undefined): { quota: Record<string, number> } | { error: string } {
  const known = new Set(QUOTA_FIELDS.map((field) => field.key))
  const quota: Record<string, number> = {}
  for (const [key, value] of Object.entries(parseQuota(originalJson))) if (!known.has(key)) quota[key] = value
  for (const field of QUOTA_FIELDS) {
    const text = (draft[field.key] ?? '').trim()
    if (text === '') continue
    if (!/^\d+$/.test(text)) return { error: `「${field.label}」要填整数,留空表示沿用默认` }
    const value = Number(text)
    if (!Number.isSafeInteger(value)) return { error: `「${field.label}」数字太大了` }
    if (value < field.min) return { error: `「${field.label}」不能小于 ${field.min}` }
    quota[field.key] = value
  }
  return { quota }
}

/** 草稿相对已保存的覆盖有没有改动(用于「保存」按钮可用与否)。 */
export function quotaChanged(draft: QuotaDraft, originalJson: string | null | undefined): boolean {
  const saved = toQuotaDraft(originalJson)
  return QUOTA_FIELDS.some((field) => (draft[field.key] ?? '').trim() !== saved[field.key])
}

/** 已设置的覆盖项数,给标题旁的小提示用。 */
/** 编辑器里能看到的项:AI 总开关关掉后不含 AI 项。 */
export const quotaFields = (aiEnabled: boolean): QuotaField[] => QUOTA_FIELDS.filter((field) => aiEnabled || !field.ai)

/** 只数看得到的项,免得标题写「已覆盖 3 项」而界面上只看得到 2 项。 */
export const overrideCount = (json: string | null | undefined, aiEnabled = true): number =>
  quotaFields(aiEnabled).filter((field) => field.key in parseQuota(json)).length
