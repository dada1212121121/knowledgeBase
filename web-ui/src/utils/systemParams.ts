import { isValidTimezone } from './time'
// 系统参数页的字段表(多用户设计说明)。
//
// 页面完全由这张表驱动:新增一个参数 = 加一行。`path` 是 `config.toml` 里的点号路径,
// 保存时只把**改过的**键按段打成合并补丁交给 `update_config`(后端是合并语义,没写的键不动)。

export type ParamKind = 'bool' | 'number' | 'text' | 'list' | 'role'

export interface ParamField {
  /** 点号路径,如 `quota.storage_gb`。 */
  path: string
  label: string
  hint?: string
  kind: ParamKind
  /** 数字框后面的单位。 */
  unit?: string
  /** 数字下限(含)。 */
  min?: number
  /** 数字上限(含):后端有硬上限的参数(例如批次内并发解析)在这里先挡一次,不用等保存后才报错。 */
  max?: number
  /** 是总开关的子项:总开关关了就置灰。 */
  dependsOn?: string
  /** 子项缩进显示。 */
  sub?: boolean
  /** 风险提示:打开时显示在字段下面。 */
  risk?: string
  /** 改了要重启服务才生效(后端热更新不覆盖这个键);页面上标出来,保存后单独提醒。 */
  restart?: boolean
}

export interface ParamSection {
  id: string
  title: string
  note?: string
  fields: ParamField[]
}

export const PARAM_SECTIONS: ParamSection[] = [
  {
    id: 'ai',
    title: 'AI',
    note: '关闭后,所有 AI 入口都会从界面中消失,后台的提炼、审核、整理也一起停止。本机运行的检索、重排、OCR、转写不受影响。下面的额度和并发是全站默认,角色和单个用户可以在「用户与权限」里覆盖(单个用户优先于角色,角色优先于这里)。',
    fields: [
      { path: 'ai.enabled', label: '启用 AI 功能(总开关)', kind: 'bool', hint: '调用大模型或编码代理的功能' },
      { path: 'ai.extract', label: '自动提炼与审核', kind: 'bool', dependsOn: 'ai.enabled', sub: true },
      { path: 'ai.deep_search', label: '深度检索与查询改写', kind: 'bool', dependsOn: 'ai.enabled', sub: true },
      { path: 'ai.organize', label: '整理(归纳、去重建议、质量报告)', kind: 'bool', dependsOn: 'ai.enabled', sub: true },
      { path: 'ai.assistant', label: 'AI 助手', kind: 'bool', dependsOn: 'ai.enabled', sub: true },
      { path: 'ai.acp', label: '编码代理(ACP)', kind: 'bool', dependsOn: 'ai.enabled', sub: true, hint: '共用已安装的代理;非管理员强制在沙箱里运行' },
      { path: 'ai.chunk_context', label: '用大模型给内容片段写上下文', kind: 'bool', dependsOn: 'ai.enabled', sub: true, hint: '关闭时按标题生成,不影响已建好的索引' },
      { path: 'quota.llm_tokens_per_day', label: '每人每天 AI 额度', kind: 'number', min: 0, dependsOn: 'ai.enabled', hint: '0 = 不限。用完后当天不能再用,站点时区的第二天 0 点恢复' },
    ],
  },
  {
    id: 'accounts',
    title: '注册',
    fields: [
      { path: 'accounts.registration_open', label: '开放注册', kind: 'bool', hint: '关闭后只能由管理员在后台建账号' },
      { path: 'accounts.require_invite', label: '注册需要邀请码', kind: 'bool', hint: '打开后注册页多一个必填的邀请码' },
      { path: 'accounts.default_role', label: '新用户的默认角色', kind: 'role', hint: '新注册的账号先拥有这个角色的功能;之后可以在「用户与权限」里改' },
      { path: 'accounts.email_domain_allowlist', label: '允许注册的邮箱域名', kind: 'list', hint: '留空表示不限制;多个用逗号分隔,如 qq.com, 163.com' },
      { path: 'accounts.block_disposable_email', label: '拦截一次性邮箱', kind: 'bool' },
      { path: 'accounts.deletion_cooling_off_days', label: '账号注销冷静期', kind: 'number', unit: '天', min: 1, hint: '用户申请注销后多少天才真正删除,期间可以撤销。1–365' },
      { path: 'accounts.invites_per_user', label: '普通用户能生成的邀请码数', kind: 'number', min: 0, hint: '0 = 只有管理员能生成' },
      {
        path: 'accounts.require_admin_totp',
        label: '管理员必须开启两步验证',
        kind: 'bool',
        hint: '能管理用户的账号没开两步验证时,只能去「个人设置」开启,其它操作(含用它创建的访问令牌)一律被拒绝',
        risk: '打开前先确认自己已经开启了两步验证,否则你自己也会被拦在个人设置里',
      },
    ],
  },
  {
    // 邮件的账号、授权码、测试发信不是简单的键值,由 components/MailSettings.vue 单独处理(没有走字段表)
    id: 'mail',
    title: '邮件',
    note: '注册验证码和找回密码都通过这里配置的邮箱发送。',
    fields: [],
  },
  {
    id: 'storage',
    title: '存储与上传',
    note: '配额分三层:这里是全站默认;角色可以覆盖一层;单个用户还可以再覆盖(在「用户与权限」里改)。越具体的越优先,没有覆盖的项沿用上一层。',
    fields: [
      { path: 'quota.storage_gb', label: '每人存储配额', kind: 'number', unit: 'GB', min: 1, hint: '只是上限,不会预先占用空间。角色和单个用户可以覆盖' },
      { path: 'quota.max_upload_mb', label: '单个文件上限', kind: 'number', unit: 'MB', min: 1 },
      { path: 'quota.disk_reserve_gb', label: '全站保留空间', kind: 'number', unit: 'GB', min: 0, hint: '磁盘剩余低于它时,全站暂停上传并告警' },
    ],
  },
  {
    id: 'indexing',
    title: '索引与网络',
    note: '批量导入很多文件时的并发,以及网页来源能不能访问内网。',
    fields: [
      {
        path: 'index.parallel_slices',
        label: '批量索引的全站并发',
        kind: 'number',
        min: 0,
        max: 8,
        unit: '个',
        hint: '0 = 自动(按 CPU 核数的 1/4,最少 1、最多 4)。它同时决定每个知识库的后台一次能做几个任务(以前是一库一次一个,一次导入几百个文件时机器大半时间在闲);编辑、保存笔记走单独的通道,不占名额',
      },
      {
        path: 'index.parallel_files',
        label: '一个批次内的并发解析',
        kind: 'number',
        min: 1,
        max: 8,
        unit: '个',
        hint: '同一批文件里同时处理几个(1 = 逐个处理)。PDF / Office 抽取和嵌入都很吃 CPU,批量导入很多文件时调到 2–4 更快;并发写索引撞上的提交冲突会自动重试,块的先后顺序不影响检索',
      },
      {
        path: 'network.crawl_allow_private',
        label: '允许网页来源访问内网和本机地址',
        kind: 'bool',
        restart: true,
        hint: '默认关闭。多用户下任何人都能添加网页来源,打开后他能让服务器去读内网服务和云主机的元数据凭据',
        risk: '风险很高:只有确实要抓公司内网文档站,并且信任所有能添加网页来源的人时才打开。改动需要重启服务才生效',
      },
    ],
  },
  {
    id: 'share',
    title: '分享与游客',
    fields: [
      { path: 'share.allow_guest_view', label: '允许游客查看', kind: 'bool', hint: '不登录就能打开分享链接' },
      { path: 'share.allow_guest_comment', label: '允许游客评论', kind: 'bool', dependsOn: 'share.allow_guest_view', sub: true },
      {
        path: 'share.allow_guest_edit',
        label: '允许游客编辑',
        kind: 'bool',
        dependsOn: 'share.allow_guest_view',
        sub: true,
        risk: '风险较高:所有修改记在「访客」名下,可在版本历史里回退',
      },
      { path: 'share.guest_link_gb_per_day', label: '每个游客链接每天的下载流量上限', kind: 'number', unit: 'GB', min: 1 },
      { path: 'share.room_max_users', label: '单个协作房间人数上限', kind: 'number', min: 2 },
      { path: 'quota.links_per_user', label: '每人分享链接数上限', kind: 'number', min: 0 },
      { path: 'quota.friends_per_user', label: '每人好友数上限', kind: 'number', min: 0 },
    ],
  },
  {
    id: 'site',
    title: '站点',
    fields: [
      { path: 'site.name', label: '站点名称', kind: 'text' },
      { path: 'site.tagline', label: '登录页标语', kind: 'text', hint: '登录页上的一句话,默认是「个人与团队知识库」' },
      { path: 'site.public_url', label: '对外地址', kind: 'text', hint: '分享链接和邮件里的链接都用它' },
      { path: 'site.timezone', label: '时区', kind: 'text', hint: 'IANA 时区名,默认 Asia/Shanghai。界面时间、每日额度、统计分桶和夜间任务都按它计算,改完立即生效' },
    ],
  },
]

type Json = Record<string, unknown>

/** 按点号路径取值。 */
export function readPath(config: Json, path: string): unknown {
  let current: unknown = config
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Json)[part]
  }
  return current
}

/** 表单里的草稿值(都是字符串 / 布尔,方便直接绑定输入框)。 */
export type Draft = Record<string, string | boolean>

/** 把配置里的值变成草稿。 */
export function toDraft(config: Json): Draft {
  const draft: Draft = {}
  for (const section of PARAM_SECTIONS) {
    for (const field of section.fields) {
      const value = readPath(config, field.path)
      if (field.kind === 'bool') draft[field.path] = value === true
      else if (field.kind === 'list') draft[field.path] = Array.isArray(value) ? value.join(', ') : ''
      else draft[field.path] = value === undefined || value === null ? '' : String(value)
    }
  }
  return draft
}

/** 草稿的值 → 配置里的真实类型;不合法返回错误文案。 */
export function parseValue(field: ParamField, raw: string | boolean): { value: unknown } | { error: string } {
  if (field.kind === 'bool') return { value: raw === true }
  const text = String(raw).trim()
  if (field.kind === 'number') {
    if (text === '' || !/^\d+$/.test(text)) return { error: `「${field.label}」要填整数` }
    const value = Number(text)
    if (field.min !== undefined && value < field.min) return { error: `「${field.label}」不能小于 ${field.min}` }
    if (field.max !== undefined && value > field.max) return { error: `「${field.label}」不能大于 ${field.max}` }
    return { value }
  }
  if (field.kind === 'role' && text === '') return { error: `请选择「${field.label}」` }
  if (field.kind === 'list') {
    return { value: text.split(/[,，\s]+/).map((item) => item.trim().toLowerCase()).filter(Boolean) }
  }
  if (text === '') return { error: `「${field.label}」不能为空` }
  if (field.path === 'site.public_url' && !/^https?:\/\/[^\s/]+/i.test(text)) return { error: '对外地址要以 http:// 或 https:// 开头' }
  // 必须是 IANA 名称:夏令时地区的偏移一年里会变,`+08:00` 这类固定偏移不能表达
  if (field.path === 'site.timezone' && !isValidTimezone(text)) return { error: `时区要填 IANA 名称,例如 Asia/Shanghai(不认 ${text})` }
  return { value: text }
}

/** 改过的字段 → 按段分组的合并补丁(`{ quota: { storage_gb: 50 } }`);有不合法的值返回 error。 */
export function buildPatch(config: Json, draft: Draft): { patch: Json; changed: string[] } | { error: string } {
  const patch: Json = {}
  const changed: string[] = []
  for (const section of PARAM_SECTIONS) {
    for (const field of section.fields) {
      const parsed = parseValue(field, draft[field.path] ?? '')
      if ('error' in parsed) return parsed
      const before = readPath(config, field.path)
      if (JSON.stringify(before) === JSON.stringify(parsed.value)) continue
      const [group, key] = field.path.split('.') as [string, string]
      const bucket = (patch[group] ??= {}) as Json
      bucket[key] = parsed.value
      changed.push(field.path)
    }
  }
  return { patch, changed }
}

/** 这次改动里哪些键要重启才生效(给保存后的提醒用)。 */
export function restartFields(changed: string[]): ParamField[] {
  const all = PARAM_SECTIONS.flatMap((section) => section.fields)
  return changed.map((path) => all.find((field) => field.path === path)).filter((field): field is ParamField => !!field?.restart)
}

/**
 * AI 总开关关着时页面上看到的分区:AI 分区整个换成中性写法,只留总开关一行(其余大模型设置和额度先收起),
 * 因为关掉后界面任何位置都不能出现「AI」二字,但管理员还得有地方把它重新打开。
 * 开着时就是完整的字段表。
 */
export function sectionsFor(aiOn: boolean): ParamSection[] {
  if (aiOn) return PARAM_SECTIONS
  return PARAM_SECTIONS.map((section) =>
    section.id !== 'ai'
      ? section
      : {
          id: 'ai',
          title: '大模型功能',
          note: '现在是关闭的:所有需要调用大模型或编码代理的入口都不显示,后台的自动整理也已停止。本机运行的检索、重排、OCR、转写不受影响。',
          fields: [{ path: 'ai.enabled', label: '启用大模型功能(总开关)', kind: 'bool', hint: '打开并保存后,这些功能会重新出现,相关的设置也会回到这里' }],
        },
  )
}
