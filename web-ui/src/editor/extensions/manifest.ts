/**
 * 扩展清单解析与校验
 *
 * 输入是后端从 `manifest.toml` 解析出来的 JSON（键名保持 TOML 里的 snake_case），
 * 输出是前端使用的规范化清单（camelCase）。规则与后端 `crates/kb-web/src/editor_ext.rs` 的
 * `validate_manifest` 逐条一致，两边共用 `crates/kb-web/tests/fixtures/editor-manifest-cases.json`
 * 里的用例，改一边不改另一边测试会变红。
 *
 * 为什么前端还要再校验一遍：清单也可能来自别处（内置扩展、测试、将来的其它安装渠道），
 * 校验函数是「清单进入注册表」的唯一门槛，不能假设一定经过后端。
 */
import { EDITOR_API_VERSION, PERMISSIONS, type ExtensionManifest, type ManifestContributes, type Permission } from './api'
import { isPermission } from './permissions'

export type ManifestParseResult = { ok: true; manifest: ExtensionManifest } | { ok: false; errors: string[] }

type Table = Record<string, unknown>

const ID_PATTERN = /^[a-z0-9]+([.-][a-z0-9]+)*$/
const SUFFIX_PATTERN = /^[A-Za-z0-9]+([._-][A-Za-z0-9]+)*$/
/** semver 2.0 官方正则（semver.org 给的那条）。 */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/
const EXTENSION_PATTERN = /^[a-z0-9]{1,16}$/
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/

export function isValidExtensionId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= 64 && ID_PATTERN.test(id)
}

export function isValidSemver(version: unknown): version is string {
  return typeof version === 'string' && version.length <= 64 && SEMVER_PATTERN.test(version)
}

/** 扩展目录内的相对路径：每段只含 `[A-Za-z0-9._-]`、不以 `.` 开头，总长 ≤ 128。 */
export function isSafeRelativePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 128 &&
    path.split('/').every((segment) => segment.length > 0 && !segment.startsWith('.') && SEGMENT_PATTERN.test(segment))
  )
}

function isTable(value: unknown): value is Table {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 按 Unicode 字符数（与 Rust 的 `chars.count` 一致）。 */
function charLength(text: string): number {
  return [...text].length
}

function titleOf(item: Table, where: string, errors: string[]): string | null {
  const title = typeof item.title === 'string' ? item.title.trim() : ''
  if (title && charLength(title) <= 80) return title
  errors.push(`${where}.title 必须是 1 到 80 个字符的字符串`)
  return null
}

function contributionId(item: Table, where: string, extensionId: string, seen: Set<string>, errors: string[]): string | null {
  const id = item.id
  if (typeof id !== 'string') {
    errors.push(`${where}.id 缺失（字符串）`)
    return null
  }
  const prefix = `${extensionId}.`
  const suffixOk = id.startsWith(prefix) && SUFFIX_PATTERN.test(id.slice(prefix.length))
  // 扩展 id 本身不合法时已经报过错，这里不重复指责前缀
  if (extensionId && (!suffixOk || id.length > 128)) {
    errors.push(
      `${where}.id「${id}」必须以「${prefix}」开头，后面只含字母、数字、\`.\`、\`_\`、\`-\`（带上扩展 id 前缀才不会和内置功能或别的扩展重名）`,
    )
    return null
  }
  if (seen.has(id)) {
    errors.push(`${where}.id「${id}」重复`)
    return null
  }
  seen.add(id)
  return id
}

function extensionList(item: Table, where: string, errors: string[]): string[] {
  const out: string[] = []
  const list = item.extensions
  if (!Array.isArray(list) || list.length === 0 || list.length > 8) {
    errors.push(`${where}.extensions 必须是 1 到 8 个扩展名的数组`)
    return out
  }
  list.forEach((value, index) => {
    if (typeof value === 'string' && EXTENSION_PATTERN.test(value)) {
      if (!out.includes(value)) out.push(value)
    } else {
      errors.push(`${where}.extensions[${index}] 必须是小写字母数字组成的扩展名（不带点，最长 16 个字符）`)
    }
  })
  return out
}

/** 取 `contributes.<key>` 数组，并把每一项当成表；不合格的记错并跳过。 */
function tables(section: Table, key: string, errors: string[]): { where: string; item: Table }[] {
  const raw = section[key]
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    errors.push(`contributes.${key} 必须是数组（用 [[contributes.${key}]] 书写）`)
    return []
  }
  const out: { where: string; item: Table }[] = []
  raw.forEach((item, index) => {
    const where = `contributes.${key}[${index}]`
    if (isTable(item)) out.push({ where, item })
    else errors.push(`${where} 必须是一个表`)
  })
  return out
}

function parseContributes(section: Table, extensionId: string, errors: string[]): ManifestContributes {
  const commands: { id: string; title: string }[] = []
  const aiTools: { id: string; title: string }[] = []
  for (const [key, target] of [
    ['commands', commands],
    ['ai_tools', aiTools],
  ] as const) {
    const seen = new Set<string>()
    for (const { where, item } of tables(section, key, errors)) {
      const id = contributionId(item, where, extensionId, seen, errors)
      const title = titleOf(item, where, errors)
      if (id !== null && title !== null) target.push({ id, title })
    }
  }

  const toolbar: { id: string }[] = []
  const slash: { id: string }[] = []
  for (const [key, target] of [
    ['toolbar', toolbar],
    ['slash', slash],
  ] as const) {
    const seen = new Set<string>()
    for (const { where, item } of tables(section, key, errors)) {
      const id = contributionId(item, where, extensionId, seen, errors)
      if (id !== null) target.push({ id })
    }
  }

  const panels: { id: string; title: string; icon?: string }[] = []
  {
    const seen = new Set<string>()
    for (const { where, item } of tables(section, 'panels', errors)) {
      const id = contributionId(item, where, extensionId, seen, errors)
      const title = titleOf(item, where, errors)
      let icon: string | undefined
      if (item.icon !== undefined && item.icon !== null) {
        if (typeof item.icon === 'string' && item.icon.length > 0 && charLength(item.icon) <= 8) icon = item.icon
        else errors.push(`${where}.icon 必须是不超过 8 个字符的字符串`)
      }
      if (id !== null && title !== null) panels.push(icon === undefined ? { id, title } : { id, title, icon })
    }
  }

  const codecs: { id: string; extensions: string[] }[] = []
  const surfaces: { id: string; extensions: string[] }[] = []
  for (const [key, target] of [
    ['codecs', codecs],
    ['surfaces', surfaces],
  ] as const) {
    const seen = new Set<string>()
    for (const { where, item } of tables(section, key, errors)) {
      const id = contributionId(item, where, extensionId, seen, errors)
      const extensions = extensionList(item, where, errors)
      if (id !== null && extensions.length > 0) target.push({ id, extensions })
    }
  }
  return { commands, toolbar, slash, panels, codecs, surfaces, aiTools }
}

/**
 * 校验并规范化清单。一次报出所有问题；未识别的键一律忽略
 * （`api_version` 不变的前提下允许新增可选字段，旧宿主不能因此拒绝新清单）。
 */
export function parseManifest(raw: unknown): ManifestParseResult {
  const errors: string[] = []
  if (!isTable(raw)) return { ok: false, errors: ['清单必须是一个键值表'] }

  let id = ''
  if (typeof raw.id !== 'string') errors.push('缺少 id（字符串）')
  else if (!isValidExtensionId(raw.id)) {
    errors.push(`id「${raw.id}」不合法：只能用小写字母、数字、\`.\` 和 \`-\`，不能以分隔符开头或结尾，最长 64 个字符`)
  } else id = raw.id

  let name = ''
  if (typeof raw.name !== 'string') errors.push('缺少 name（字符串）')
  else if (raw.name.trim() && charLength(raw.name.trim()) <= 80) name = raw.name.trim()
  else errors.push('name 不能为空，且不超过 80 个字符')

  let version = ''
  if (typeof raw.version !== 'string') errors.push('缺少 version（semver 字符串）')
  else if (isValidSemver(raw.version)) version = raw.version
  else errors.push(`version「${raw.version}」不是 semver（形如 1.2.3、1.0.0-beta.1）`)

  if (raw.api_version === undefined) {
    errors.push(`缺少 api_version（当前为 ${EDITOR_API_VERSION}）`)
  } else if (typeof raw.api_version !== 'number' || !Number.isInteger(raw.api_version) || raw.api_version < 1) {
    errors.push(`api_version 必须是整数 ${EDITOR_API_VERSION}`)
  } else if (raw.api_version > EDITOR_API_VERSION) {
    errors.push(
      `api_version = ${raw.api_version} 需要更新版本的编辑器扩展 API（这个编辑器支持 ${EDITOR_API_VERSION}），请升级编辑器，或使用面向 ${EDITOR_API_VERSION} 的扩展版本`,
    )
  }

  let description: string | undefined
  if (raw.description !== undefined && raw.description !== null) {
    if (typeof raw.description === 'string' && charLength(raw.description) <= 500) description = raw.description
    else errors.push('description 必须是不超过 500 个字符的字符串')
  }

  let entry = 'index.js'
  if (raw.entry !== undefined && raw.entry !== null) {
    if (isSafeRelativePath(raw.entry) && raw.entry.endsWith('.js')) entry = raw.entry
    else errors.push('entry 必须是扩展目录内的 .js 文件（相对路径，每段只含字母、数字、`.`、`_`、`-`，不能以 `.` 开头）')
  }

  const permissions: Permission[] = []
  if (raw.permissions !== undefined && raw.permissions !== null) {
    if (!Array.isArray(raw.permissions)) errors.push('permissions 必须是字符串数组')
    else {
      raw.permissions.forEach((item, index) => {
        if (typeof item !== 'string') errors.push(`permissions[${index}] 必须是字符串`)
        else if (!isPermission(item)) errors.push(`permissions[${index}] 是未知权限「${item}」（可用：${PERMISSIONS.join('、')}）`)
        else if (!permissions.includes(item)) permissions.push(item)
      })
    }
  }

  let contributes: ManifestContributes = { commands: [], toolbar: [], slash: [], panels: [], codecs: [], surfaces: [], aiTools: [] }
  if (raw.contributes !== undefined && raw.contributes !== null) {
    if (isTable(raw.contributes)) contributes = parseContributes(raw.contributes, id, errors)
    else errors.push('contributes 必须是一个表')
  }

  if (errors.length > 0) return { ok: false, errors }
  const manifest: ExtensionManifest = {
    id,
    name,
    version,
    apiVersion: EDITOR_API_VERSION,
    ...(description === undefined ? {} : { description }),
    entry,
    permissions,
    contributes,
  }
  return { ok: true, manifest }
}
