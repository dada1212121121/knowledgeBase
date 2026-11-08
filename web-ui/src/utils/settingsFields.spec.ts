import { describe, expect, it } from 'vitest'
import { CapabilityError } from '@/api/client'
// 之后 `config.rs` 按数据域拆成了 `config/` 目录:这里把整个目录拼回一份文本来对账,
// 免得每次搬文件都要改这条 import(少一个文件 = 对账静默失真)。
const CONFIG_SOURCES = import.meta.glob('../../../crates/kb-core/src/config/*.rs', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const CONFIG_RS = Object.keys(CONFIG_SOURCES)
  .sort()
  .map((key) => CONFIG_SOURCES[key])
  .join('\n')
import SEARCH_RS from '../../../crates/kb-service/src/search/mod.rs?raw'
import {
  ALL_FIELDS,
  FIELD_GROUPS,
  HOT_KEYS,
  HOT_PREFIXES,
  buildSettingsPatch,
  changeScope,
  defaultText,
  fieldOf,
  groupDigits,
  groupsOf,
  needsRestart,
  parseField,
  parseListen,
  rangeText,
  readPath,
  restartFields,
  riskOf,
  saveFailureText,
  saveSummary,
  splitList,
  toDraft,
  type Draft,
  type SettingField,
} from './settingsFields'

// ---------------------------------------------------------------- 与 config.rs 对账
// 界面上写的默认值 / 取值范围 / 生效方式必须和后端一致:这里直接读 Rust 源码核对,
// 后端改了而字段表没跟上(或反过来)这些用例会变红,而不是等用户在页面上撞见。
// (用 `?raw` 把 Rust 源码当字符串读进来:vue-tsc 的类型里没有 node:fs。)

/** 从 `start` 之后第一个 `{` 开始,取到与它配对的 `}` 之间的文本。 */
function braceBody(source: string, start: number): string {
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  throw new Error('括号不配对')
}

/** 按最外层的逗号拆分(括号、引号里的逗号不算)。 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quoted = false
  let last = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '"' && text[i - 1] !== '\\') quoted = !quoted
    if (quoted) continue
    if ('([{'.includes(ch!)) depth += 1
    else if (')]}'.includes(ch!)) depth -= 1
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(last, i))
      last = i + 1
    }
  }
  parts.push(text.slice(last))
  return parts.map((part) => part.trim()).filter(Boolean)
}

/** 把 Rust 的字面量表达式读成 JS 值;读不了的原样返回字符串。 */
function rustLiteral(expression: string): unknown {
  const text = expression.trim()
  const call = /^default_(\w+)\(\)$/.exec(text)
  if (call) {
    const at = CONFIG_RS.indexOf(`fn default_${call[1]}()`)
    if (at < 0) throw new Error(`找不到 default_${call[1]}`)
    return rustLiteral(braceBody(CONFIG_RS, at).trim())
  }
  const str = /^"(.*)"\.to_owned\(\)$/.exec(text)
  if (str) return str[1]
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^[0-9_]+$/.test(text)) return Number(text.replace(/_/g, ''))
  if (/^[0-9_]+\.[0-9]+$/.test(text)) return Number(text.replace(/_/g, ''))
  if (text === 'Vec::new()') return []
  if (text === 'String::new()') return ''
  return text
}

/** 某个配置结构的 `Default` 实现里写的各字段默认值。 */
function rustDefaults(struct: string): Record<string, unknown> {
  const at = CONFIG_RS.indexOf(`impl Default for ${struct} {`)
  if (at < 0) throw new Error(`config.rs 里没有 impl Default for ${struct}`)
  const impl = braceBody(CONFIG_RS, at)
  // 函数签名 `-> Self {` 里也有 `Self {`:要的是后面那个结构体字面量
  const fields = braceBody(impl, impl.lastIndexOf('Self {'))
  const out: Record<string, unknown> = {}
  for (const entry of splitTopLevel(fields)) {
    const colon = entry.indexOf(':')
    out[entry.slice(0, colon).trim()] = rustLiteral(entry.slice(colon + 1))
  }
  return out
}

const STRUCT_OF: Record<string, string> = {
  server: 'ServerConfig',
  embed: 'EmbedConfig',
  index: 'IndexConfig',
  meta: 'MetaConfig',
  search: 'SearchConfig',
  schedule: 'ScheduleConfig',
  llm: 'LlmConfig',
  evolution: 'EvolutionConfig',
  extract: 'ExtractConfig',
  backup: 'BackupConfig',
  convert: 'ConvertConfig',
  office: 'OfficeConfig',
  web_extract: 'WebExtractConfig',
}

/**
 * 三层路径的子表 → Rust 结构(`extract.ocr.slots` 读的是 `OcrConfig`)。
 *
 * 两层是绝大多数配置段(段 → 结构),三层只有子表这一种,单独登记一行比让 `STRUCT_OF` 支持两种深度更好读。
 */
const NESTED_STRUCT_OF: Record<string, string> = {
  'extract.ocr': 'OcrConfig',
}

/** 字段路径 → [Rust 结构名, 结构里的字段名]。 */
function locateField(path: string): { struct: string; key: string } {
  const parts = path.split('.')
  if (parts.length > 2) {
    const parent = parts.slice(0, -1).join('.')
    const struct = NESTED_STRUCT_OF[parent]
    if (!struct) throw new Error(`${path}:子表 ${parent} 没有登记对应的 Rust 结构`)
    return { struct, key: parts.at(-1)! }
  }
  const [section, key] = parts as [string, string]
  return { struct: STRUCT_OF[section]!, key }
}

/** 读取 `const NAME: std::ops::RangeInclusive<_> = a..=b;` 这样的闭区间常量。 */
function constantRange(name: string): [number, number] {
  const found = new RegExp(`const ${name}: std::ops::RangeInclusive<\\w+> = ([0-9_]+)\\.\\.=([0-9_]+);`).exec(CONFIG_RS)
  if (!found) throw new Error(`config.rs 里没有闭区间常量 ${name}`)
  return [Number(found[1]!.replace(/_/g, '')), Number(found[2]!.replace(/_/g, ''))]
}

const constant = (name: string) => {
  const found = new RegExp(`const ${name}: \\w+ = ([0-9_]+);`).exec(CONFIG_RS)
  if (!found) throw new Error(`config.rs 里没有常量 ${name}`)
  return Number(found[1]!.replace(/_/g, ''))
}

describe('字段表与 config.rs 对账', () => {
  it('每个写了默认值的字段都和 Default 实现一致', () => {
    const mismatches: string[] = []
    for (const field of ALL_FIELDS) {
      if (field.def === undefined) continue
      const { struct, key } = locateField(field.path)
      if (!struct) {
        mismatches.push(`${field.path}:字段表里的段 ${field.path.split('.')[0]} 没有登记对应的 Rust 结构`)
        continue
      }
      const rust = rustDefaults(struct)[key]
      if (JSON.stringify(rust) !== JSON.stringify(field.def)) {
        mismatches.push(`${field.path}:字段表 ${JSON.stringify(field.def)},config.rs ${JSON.stringify(rust)}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('config.rs 里 validate() 写明的取值范围(a..=b)都已体现在字段表', () => {
    // 形如 `(1..=64).contains(&self.embed.batch_size)` / `(10..=86_400).contains(&self.extract.max_media_seconds)`
    const ranges = [...CONFIG_RS.matchAll(/\((\d[\d_]*)\.\.=(\d[\d_]*)\)\s*\.contains\(&self\.(\w+)\.(\w+)\)/g)]
    expect(ranges.length).toBeGreaterThanOrEqual(2)
    for (const [, low, high, section, key] of ranges) {
      const field = fieldOf(`${section}.${key}`)
      if (!field) continue // 这个键不在设置页里(例如 upload.*)
      expect([field.path, field.min, field.max]).toEqual([field.path, Number(low!.replace(/_/g, '')), Number(high!.replace(/_/g, ''))])
    }
    // 至少核对到这两项,免得正则悄悄匹配不到而空转
    expect(ranges.map(([, , , section, key]) => `${section}.${key}`)).toEqual(expect.arrayContaining(['embed.batch_size', 'extract.max_media_seconds']))
  })

  it('OCR 资源参数的范围来自 config.rs 的常量(B4 的 [extract.ocr] 子表)', () => {
    // 这三个值搬进配置前是 pdf.rs 里的常量;范围写在 OcrConfig 的常量上,这里逐项对账
    expect([fieldOf('extract.ocr.slots')!.min, fieldOf('extract.ocr.slots')!.max]).toEqual([0, constant('MAX_SLOTS')])
    expect([fieldOf('extract.ocr.budget_secs')!.min, fieldOf('extract.ocr.budget_secs')!.max]).toEqual(constantRange('BUDGET_RANGE'))
    expect([fieldOf('extract.ocr.max_pages')!.min, fieldOf('extract.ocr.max_pages')!.max]).toEqual([1, constant('MAX_PAGES')])
  })

  it('备份与数据库的取值范围来自 config.rs 的常量', () => {
    const interval = fieldOf('backup.interval_hours')!
    expect([interval.min, interval.max]).toEqual([constant('MIN_INTERVAL_HOURS'), constant('MAX_INTERVAL_HOURS')])
    expect([fieldOf('backup.keep_count')!.min, fieldOf('backup.keep_count')!.max]).toEqual([0, constant('MAX_KEEP_COUNT')])
    expect([fieldOf('backup.keep_days')!.min, fieldOf('backup.keep_days')!.max]).toEqual([0, constant('MAX_KEEP_DAYS')])
    expect(fieldOf('backup.mirror_dirs')!.max).toBe(constant('MAX_MIRROR_DIRS'))
    const pool = fieldOf('meta.read_pool')!
    expect([pool.min, pool.max]).toEqual([1, constant('MAX_READ_POOL')])
  })

  it('旧格式转换的取值范围来自 config.rs 的常量', () => {
    const timeout = fieldOf('convert.timeout_secs')!
    expect([timeout.min, timeout.max]).toEqual([1, constant('MAX_TIMEOUT_SECS')])
    const concurrent = fieldOf('convert.max_concurrent')!
    expect([concurrent.min, concurrent.max]).toEqual([1, constant('MAX_CONCURRENT')])
  })

  it('旧版本份数的上限来自 config.rs 的常量', () => {
    const field = fieldOf('office.keep_versions')!
    expect([field.min, field.max]).toEqual([0, constant('MAX_KEEP_VERSIONS')])
  })

  it('默认返回条数的范围是搜索服务实际会钳制到的范围', () => {
    const clamp = /request\.k\.unwrap_or\(self\.options\.k\)\.clamp\((\d+), (\d+)\)/.exec(SEARCH_RS)
    expect(clamp).not.toBeNull()
    const field = fieldOf('search.k')!
    expect([field.min, field.max]).toEqual([Number(clamp![1]), Number(clamp![2])])
  })

  it('立即生效的键与 classify_change 的热更新白名单逐项一致', () => {
    const body = braceBody(CONFIG_RS, CONFIG_RS.indexOf('pub fn classify_change'))
    const prefixes = [...body.matchAll(/key\.starts_with\("([^"]+)"\)/g)].map((m) => m[1]!).filter((p) => p !== 'embed.')
    const keys = [...body.matchAll(/key == "([^"]+)"/g)].map((m) => m[1]!).filter((k) => k !== 'embed')
    expect([...HOT_PREFIXES].sort()).toEqual([...prefixes].sort())
    expect([...HOT_KEYS].sort()).toEqual([...keys].sort())
  })

  it('字段表里的键都是 config.rs 里真有的键', () => {
    for (const field of ALL_FIELDS) {
      const { struct, key } = locateField(field.path)
      expect(struct, `${field.path} 的段`).toBeTruthy()
      const at = CONFIG_RS.indexOf(`pub struct ${struct} {`)
      expect(braceBody(CONFIG_RS, at), `${field.path} 不在 ${struct} 里`).toMatch(new RegExp(`pub ${key}:`))
    }
  })
})

// ---------------------------------------------------------------- 生效方式

describe('changeScope', () => {
  it.each([
    ['search.k', 'hot'],
    ['backup.interval_hours', 'hot'],
    ['schedule.nightly_at', 'hot'],
    ['llm.provider', 'hot'],
    ['llm.daily_token_budget', 'hot'],
    ['log.level', 'hot'],
    ['server.listen', 'restart'],
    ['index.max_file_bytes', 'restart'],
    ['meta.read_pool', 'restart'],
    ['extract.ocr_enabled', 'restart'],
    ['evolution.dedup_similarity', 'restart'],
    ['embed.model', 'migration'],
    ['embed.batch_size', 'migration'],
    // 只在启动时读一次、不改变向量内容:提示重启即可,不能让整份配置都不生效(H4,与 config.rs 一致)
    ['embed.preload', 'restart'],
    ['embed.threads', 'restart'],
    ['embed.idle_unload_minutes', 'restart'],
  ] as const)('%s → %s', (path, scope) => {
    expect(changeScope(path)).toBe(scope)
  })

  it('只有 restart 算「需要重启」,迁移另说', () => {
    expect(needsRestart('server.listen')).toBe(true)
    expect(needsRestart('search.k')).toBe(false)
    expect(needsRestart('embed.model')).toBe(false)
  })
})

// ---------------------------------------------------------------- 字段表自身

const textsOf = (field: SettingField) => [field.label, field.hint, field.riskOn ?? '', field.riskValue?.text ?? '', field.placeholder ?? '', ...(field.options ?? []).map((o) => o.label)]

describe('字段表的文案规范', () => {
  it('路径不重复,每项都有中文标签和帮助文字', () => {
    const paths = ALL_FIELDS.map((field) => field.path)
    expect(new Set(paths).size).toBe(paths.length)
    for (const field of ALL_FIELDS) {
      expect(field.label, field.path).toMatch(/[\u4e00-\u9fff]/)
      // 键名当标签是这次要消灭的写法
      expect(field.label, field.path).not.toMatch(/[._]/)
      expect(field.hint.length, field.path).toBeGreaterThan(8)
      expect(field.hint, field.path).toMatch(/[。)]$/)
    }
  })

  it('界面上不出现术语表禁用的英文词', () => {
    const banned = /\b(token|tokens|top-?k|rerank|explain|collection|insight|insights|job|jobs)\b/i
    for (const group of FIELD_GROUPS) {
      for (const text of [group.title, group.note ?? '', ...group.fields.flatMap(textsOf)]) {
        expect(text, `${group.id}:${text}`).not.toMatch(banned)
      }
    }
  })

  it('不属于 AI 的分组里任何位置都没有「AI」字样(AI 总开关关闭时页面要干净)', () => {
    for (const group of FIELD_GROUPS.filter((item) => !item.ai)) {
      for (const text of [group.title, group.note ?? '', ...group.fields.flatMap(textsOf)]) {
        expect(text, `${group.id}:${text}`).not.toMatch(/AI/)
      }
    }
  })

  it('同一个分区里的分组标题不重复(以前有两张同名的「常规配置」)', () => {
    const seen = new Set<string>()
    for (const group of FIELD_GROUPS) {
      const key = `${group.section}/${group.title}`
      expect(seen.has(key), key).toBe(false)
      seen.add(key)
    }
  })

  it('嵌入段整组只读;其余字段都能在页面上改', () => {
    expect(FIELD_GROUPS.find((group) => group.id === 'embed')!.fields.every((field) => field.readonly)).toBe(true)
    expect(ALL_FIELDS.filter((field) => field.readonly).every((field) => field.path.startsWith('embed.'))).toBe(true)
  })

  it('每个字段都有默认值,取值范围里的默认值不越界', () => {
    for (const field of ALL_FIELDS) {
      expect(field.def, field.path).not.toBeUndefined()
      if (typeof field.def === 'number') {
        if (field.min !== undefined) expect(field.def, field.path).toBeGreaterThanOrEqual(field.min)
        if (field.max !== undefined) expect(field.def, field.path).toBeLessThanOrEqual(field.max)
      }
    }
  })
})

describe('groupsOf', () => {
  it('AI 总开关关闭时模型分区没有任何分组', () => {
    expect(groupsOf('model', false)).toEqual([])
    expect(groupsOf('model', true).map((group) => group.id)).toEqual(['llm', 'cost', 'web_extract', 'evolution'])
  })

  it('非 AI 分区不受影响', () => {
    expect(groupsOf('backup', false).map((group) => group.id)).toEqual(['backup', 'mirror'])
    expect(groupsOf('storage', false).map((group) => group.id)).toEqual(['index', 'meta', 'convert', 'office', 'schedule'])
  })

  it('调度与维护并进了存储与索引(它和备份毫无关系)', () => {
    expect(groupsOf('backup', true).flatMap((group) => group.fields.map((f) => f.path))).not.toContain('schedule.nightly_at')
    expect(groupsOf('storage', true).flatMap((group) => group.fields.map((f) => f.path))).toContain('schedule.nightly_at')
  })
})

// ---------------------------------------------------------------- 文案生成

describe('rangeText / defaultText', () => {
  it('范围和默认值都从字段表来', () => {
    expect(rangeText(fieldOf('backup.interval_hours')!)).toBe('取值 1–720 小时,默认 24 小时')
    expect(rangeText(fieldOf('search.k')!)).toBe('取值 1–100 条,默认 8 条')
    expect(rangeText(fieldOf('extract.max_media_seconds')!)).toBe('取值 10–86,400 秒,默认 1,800 秒')
  })

  it('0 本身是合法值时不写「不小于 0」', () => {
    expect(rangeText(fieldOf('backup.keep_days')!)).toBe('取值 0–3,650 天,默认 0 天')
    expect(rangeText(fieldOf('llm.max_calls_per_hour')!)).toBe('默认 60 次')
  })

  it('开关、时间、列表、单选', () => {
    expect(rangeText(fieldOf('backup.enabled')!)).toBe('默认 开启')
    expect(rangeText(fieldOf('schedule.nightly_at')!)).toBe('格式 HH:MM(24 小时制),默认 03:00')
    expect(rangeText(fieldOf('backup.mirror_dirs')!)).toBe('最多 4 个,默认 不复制')
    expect(defaultText(fieldOf('extract.ocr_model_size')!)).toBe('小(更快)')
  })

  it('千位用逗号', () => {
    expect(groupDigits(2000000)).toBe('2,000,000')
    expect(groupDigits(512)).toBe('512')
  })
})

describe('riskOf', () => {
  it('开关打开才提醒', () => {
    const field = fieldOf('server.allow_remote')!
    expect(riskOf(field, true)).toContain('对外暴露')
    expect(riskOf(field, false)).toBe('')
  })

  it('费用上限填 0(不限)才提醒', () => {
    const field = fieldOf('llm.daily_token_budget')!
    expect(riskOf(field, '0')).toContain('费用')
    expect(riskOf(field, ' 0 ')).toContain('费用')
    expect(riskOf(field, '2000000')).toBe('')
  })
})

// ---------------------------------------------------------------- 校验

const f = (path: string) => fieldOf(path)!
const parse = (path: string, raw: string | boolean, draft: Draft = {}) => parseField(f(path), raw, draft)

describe('parseField', () => {
  it('整数:0 是合法值,不能退化成字符串', () => {
    expect(parse('backup.keep_count', '0')).toEqual({ value: 0 })
    expect(parse('backup.keep_count', ' 7 ')).toEqual({ value: 7 })
  })

  it('整数:带小数、负数、空串、文字都报错并带标签', () => {
    expect(parse('backup.interval_hours', '1.5')).toEqual({ error: '「备份间隔」要填 1–720 之间的整数' })
    expect(parse('backup.interval_hours', '-3')).toEqual({ error: '「备份间隔」要填 1–720 之间的整数' })
    expect(parse('backup.interval_hours', '')).toHaveProperty('error')
    expect(parse('backup.interval_hours', 'abc')).toHaveProperty('error')
  })

  it('整数:越界给「不能小于 / 不能大于」', () => {
    expect(parse('backup.interval_hours', '0')).toEqual({ error: '「备份间隔」不能小于 1' })
    expect(parse('backup.interval_hours', '721')).toEqual({ error: '「备份间隔」不能大于 720' })
    expect(parse('backup.interval_hours', '720')).toEqual({ value: 720 })
    expect(parse('backup.interval_hours', '1')).toEqual({ value: 1 })
    expect(parse('meta.read_pool', '9')).toEqual({ error: '「数据库读连接数」不能大于 8' })
    expect(parse('search.k', '101')).toEqual({ error: '「默认返回条数」不能大于 100' })
  })

  it('小数', () => {
    expect(parse('search.global_weight', '0.8')).toEqual({ value: 0.8 })
    expect(parse('search.global_weight', '.5')).toEqual({ value: 0.5 })
    expect(parse('search.global_weight', 'x')).toEqual({ error: '「公共集合的权重」要填数字' })
    expect(parse('evolution.dedup_similarity', '1.01')).toEqual({ error: '「重复判定的相似度」不能大于 1' })
    expect(parse('evolution.dedup_similarity', '0')).toEqual({ value: 0 })
  })

  it('时间:HH:MM,24 小时制', () => {
    expect(parse('schedule.nightly_at', '03:00')).toEqual({ value: '03:00' })
    expect(parse('schedule.nightly_at', '23:59')).toEqual({ value: '23:59' })
    for (const bad of ['24:00', '3:00', '03:60', '0300', '', '03:00:00']) {
      expect(parse('schedule.nightly_at', bad), bad).toEqual({ error: '「夜间全量校验时间」要写成 HH:MM,例如 03:00' })
    }
  })

  it('单选:有选项时必须在选项里', () => {
    expect(parse('extract.ocr_model_size', 'medium')).toEqual({ value: 'medium' })
    expect(parse('extract.ocr_model_size', 'huge')).toHaveProperty('error')
    expect(parse('llm.provider', 'openai')).toEqual({ value: 'openai' })
    expect(parse('llm.provider', '')).toEqual({ error: '「服务商」请选一项' })
  })

  it('文本:不能为空;接口地址要以 http(s):// 开头', () => {
    expect(parse('llm.extract_model', '  ')).toEqual({ error: '「提炼用模型」不能为空' })
    expect(parse('llm.base_url', 'api.deepseek.com')).toEqual({ error: '「接口地址」要以 http:// 或 https:// 开头' })
    expect(parse('llm.base_url', ' https://api.deepseek.com ')).toEqual({ value: 'https://api.deepseek.com' })
  })

  it('开关', () => {
    expect(parse('index.watch', true)).toEqual({ value: true })
    expect(parse('index.watch', false)).toEqual({ value: false })
  })

  it('异地目录:空串是合法的「不复制」;不能超过 4 个;不能含 ..', () => {
    expect(parse('backup.mirror_dirs', '')).toEqual({ value: [] })
    expect(parse('backup.mirror_dirs', '/mnt/a, /mnt/b\n/mnt/c')).toEqual({ value: ['/mnt/a', '/mnt/b', '/mnt/c'] })
    expect(parse('backup.mirror_dirs', '/a,/b,/c,/d,/e')).toEqual({ error: '「异地备份目录」最多 4 个目录,现在写了 5 个' })
    expect(parse('backup.mirror_dirs', '/mnt/../etc')).toEqual({ error: '「异地备份目录」不能用「..」,请写绝对路径:/mnt/../etc' })
    expect(parse('backup.mirror_dirs', '/mnt/a..b')).toEqual({ value: ['/mnt/a..b'] })
  })
})

describe('监听地址', () => {
  it('parseListen:IP:端口,不收主机名', () => {
    expect(parseListen('127.0.0.1:7878')).toEqual({ loopback: true })
    expect(parseListen('127.8.9.1:80')).toEqual({ loopback: true })
    expect(parseListen('0.0.0.0:7878')).toEqual({ loopback: false })
    expect(parseListen('192.168.1.5:7878')).toEqual({ loopback: false })
    expect(parseListen('[::1]:7878')).toEqual({ loopback: true })
    expect(parseListen('[::]:7878')).toEqual({ loopback: false })
    for (const bad of ['localhost:7878', '127.0.0.1', '127.0.0.1:99999', '300.1.1.1:80', '::1:7878', '', ':7878']) {
      expect(parseListen(bad), bad).toBeNull()
    }
  })

  it('非本机地址必须同时打开「允许远程访问」(后端 validate 会拒绝)', () => {
    expect(parse('server.listen', '0.0.0.0:7878', { 'server.allow_remote': false })).toEqual({
      error: '「监听地址」这不是本机地址,需要同时打开下面的「允许远程访问」,否则服务启动不了',
    })
    expect(parse('server.listen', '0.0.0.0:7878', { 'server.allow_remote': true })).toEqual({ value: '0.0.0.0:7878' })
    expect(parse('server.listen', '127.0.0.1:9000', { 'server.allow_remote': false })).toEqual({ value: '127.0.0.1:9000' })
  })
})

// ---------------------------------------------------------------- 补丁

const CONFIG = {
  server: { listen: '127.0.0.1:7878', allow_remote: false },
  index: { watch: true, debounce_ms: 2000, max_file_bytes: 204800 },
  meta: { read_pool: 4 },
  schedule: { nightly_at: '03:00', optimize_interval_minutes: 60 },
  search: { k: 8, global_weight: 0.8, rrf_k: 60, window_context_lines: 8, collection_weights: { proj_a: 1.2 } },
  backup: { enabled: true, interval_hours: 24, keep_count: 7, keep_days: 0, include_sources: false, mirror_dirs: ['/mnt/usb', '/mnt/nas'] },
  llm: { provider: 'deepseek', base_url: 'https://api.deepseek.com', extract_model: 'm1', review_model: 'm2', agent_model: 'm3', daily_token_budget: 2000000, max_calls_per_hour: 60 },
  evolution: { extract_enabled_default: false, dedup_similarity: 0.92 },
  extract: { ocr_enabled: false, ocr_model_size: 'small', ocr_language: 'chi_sim+eng', transcribe_enabled: false, max_media_seconds: 1800 },
  embed: { backend: 'fastembed', model: 'bge-m3-int8', max_tokens: 512, batch_size: 8, preload: true },
}

describe('toDraft / readPath', () => {
  it('配置值 → 草稿值', () => {
    const draft = toDraft(CONFIG)
    expect(draft['backup.keep_count']).toBe('7')
    expect(draft['backup.enabled']).toBe(true)
    // 列表一行一项
    expect(draft['backup.mirror_dirs']).toBe('/mnt/usb\n/mnt/nas')
    expect(draft['search.global_weight']).toBe('0.8')
  })

  it('配置里缺这个键时草稿是空串,不是 "undefined"', () => {
    expect(toDraft({})['backup.keep_count']).toBe('')
    expect(readPath({ a: { b: 1 } }, 'a.b')).toBe(1)
    expect(readPath({ a: 1 }, 'a.b')).toBeUndefined()
  })
})

describe('buildSettingsPatch', () => {
  it('三层的子表路径写成嵌套对象(extract.ocr.slots)', () => {
    // 以前只按两段切:`patch[group][key]` 会把 `extract.ocr.slots` 写成 `{ extract: { ocr: 4 } }`,
    // 后端收到的是“extract.ocr 应当是个对象”,整个保存被拒。
    const result = buildSettingsPatch(CONFIG, edited({ 'extract.ocr.slots': '4' }))
    expect(result.errors).toEqual({})
    expect(result.patch).toEqual({ extract: { ocr: { slots: 4 } } })
    expect(result.changed).toEqual(['extract.ocr.slots'])
  })

  const edited = (changes: Draft) => ({ ...toDraft(CONFIG), ...changes })

  it('没改动就是空补丁(不会拿整份配置去覆盖)', () => {
    expect(buildSettingsPatch(CONFIG, toDraft(CONFIG))).toEqual({ patch: {}, changed: [], errors: {} })
  })

  it('只带改过的键,不带整段', () => {
    const result = buildSettingsPatch(CONFIG, edited({ 'backup.keep_count': '0' }))
    expect(result.patch).toEqual({ backup: { keep_count: 0 } })
    expect(result.changed).toEqual(['backup.keep_count'])
  })

  it('改 search.k 不会把页面开着期间别处写入的 collection_weights 盖回去', () => {
    // 回归守卫:旧实现按整段提交 search,会带上陈旧的 collection_weights
    const result = buildSettingsPatch(CONFIG, edited({ 'search.k': '9' }))
    expect(result.patch).toEqual({ search: { k: 9 } })
    expect(JSON.stringify(result.patch)).not.toContain('collection_weights')
  })

  it('0 与 false 这类假值也要进补丁', () => {
    const result = buildSettingsPatch(CONFIG, edited({ 'backup.enabled': false, 'backup.keep_count': '0', 'llm.max_calls_per_hour': '0' }))
    expect(result.patch).toEqual({ backup: { enabled: false, keep_count: 0 }, llm: { max_calls_per_hour: 0 } })
  })

  it('同时改多段:按段分组', () => {
    const result = buildSettingsPatch(CONFIG, edited({ 'search.k': '9', 'backup.interval_hours': '12', 'schedule.nightly_at': '04:30' }))
    expect(Object.keys(result.patch).sort()).toEqual(['backup', 'schedule', 'search'])
    expect(result.changed.sort()).toEqual(['backup.interval_hours', 'schedule.nightly_at', 'search.k'])
  })

  it('llm 段能进补丁(以前它在「不进表单」里,页面写着会保存其实永远不落盘)', () => {
    const result = buildSettingsPatch(CONFIG, edited({ 'llm.extract_model': 'deepseek-chat', 'llm.provider': 'openai' }))
    expect(result.patch).toEqual({ llm: { extract_model: 'deepseek-chat', provider: 'openai' } })
  })

  it('不合法的值进 errors,不进补丁;别的合法改动照常', () => {
    const result = buildSettingsPatch(CONFIG, edited({ 'backup.interval_hours': '0', 'search.k': '9' }))
    expect(result.errors).toEqual({ 'backup.interval_hours': '「备份间隔」不能小于 1' })
    expect(result.patch).toEqual({ search: { k: 9 } })
  })

  it('没碰过的字段不校验:配置文件里的怪值不会一打开页面就满屏标红', () => {
    const odd = { ...CONFIG, backup: { ...CONFIG.backup, interval_hours: 100000 } }
    expect(buildSettingsPatch(odd, toDraft(odd))).toEqual({ patch: {}, changed: [], errors: {} })
  })

  it('改回原值就不算改动', () => {
    const draft = edited({ 'backup.keep_count': '9' })
    draft['backup.keep_count'] = '7'
    expect(buildSettingsPatch(CONFIG, draft).changed).toEqual([])
  })

  it('异地目录:改成数组;清空是 [](不复制),不是空串', () => {
    expect(buildSettingsPatch(CONFIG, edited({ 'backup.mirror_dirs': '/mnt/a, /mnt/b' })).patch).toEqual({ backup: { mirror_dirs: ['/mnt/a', '/mnt/b'] } })
    expect(buildSettingsPatch(CONFIG, edited({ 'backup.mirror_dirs': '' })).patch).toEqual({ backup: { mirror_dirs: [] } })
  })

  it('写法不同但值一样不算改动(“ 7 ”和 7、逗号分隔和换行分隔的同一组目录)', () => {
    expect(buildSettingsPatch(CONFIG, edited({ 'backup.keep_count': ' 7 ', 'backup.mirror_dirs': '/mnt/usb, /mnt/nas' }))).toEqual({ patch: {}, changed: [], errors: {} })
  })

  it('只关掉「允许远程访问」而没碰监听地址:监听地址也要报错(后端会拒绝)', () => {
    const remote = { ...CONFIG, server: { listen: '0.0.0.0:7878', allow_remote: true } }
    const result = buildSettingsPatch(remote, { ...toDraft(remote), 'server.allow_remote': false })
    expect(result.errors['server.listen']).toContain('允许远程访问')
    expect(result.patch).toEqual({ server: { allow_remote: false } })
  })

  it('字段表之外的段即使草稿里有也不会被提交(没登记的配置段不会被页面悄悄改掉)', () => {
    const draft = { ...toDraft(CONFIG), 'network.hf_cdn_direct': false, 'paths.models_dir': '/x' } as Draft
    expect(buildSettingsPatch({ ...CONFIG, network: { hf_cdn_direct: true } }, draft)).toEqual({ patch: {}, changed: [], errors: {} })
  })

  it('只读的嵌入段即使草稿被改了也不进补丁', () => {
    const result = buildSettingsPatch(CONFIG, edited({ 'embed.model': 'other', 'embed.batch_size': '99' }))
    expect(result).toEqual({ patch: {}, changed: [], errors: {} })
  })
})

describe('restartFields', () => {
  it('挑出要重启才生效的字段', () => {
    expect(restartFields(['search.k', 'server.listen', 'index.watch', 'backup.enabled']).map((field) => field.label)).toEqual(['监听地址', '监视文件变化'])
  })

  it('认不出的键被忽略', () => {
    expect(restartFields(['nope.nothing'])).toEqual([])
  })
})

describe('splitList', () => {
  it('逗号(半角 / 全角)和换行都能分隔,空项丢掉', () => {
    expect(splitList('a, b，c\n\n d ,')).toEqual(['a', 'b', 'c', 'd'])
    expect(splitList('')).toEqual([])
  })
})

describe('saveSummary', () => {
  it('全是热更新:成功色,立即生效', () => {
    expect(saveSummary(['search.k', 'backup.enabled'], [])).toEqual({ text: '已保存 2 项,立即生效。', tone: 'success' })
  })

  it('有要重启的:警告色,点名哪些项要重启,其余已生效', () => {
    expect(saveSummary(['search.k', 'server.listen'], ['监听地址'])).toEqual({
      text: '已保存 2 项。「监听地址」要重启服务后才生效,其余已立即生效。',
      tone: 'warning',
    })
  })

  it('全部都要重启:不说「其余已生效」', () => {
    expect(saveSummary(['server.listen', 'index.watch'], ['监听地址', '监视文件变化'])).toEqual({
      text: '已保存 2 项。「监听地址、监视文件变化」要重启服务后才生效。',
      tone: 'warning',
    })
  })
})

describe('saveFailureText', () => {
  it('无权限:说清是权限问题,不让人重试', () => {
    expect(saveFailureText(new CapabilityError('forbidden', 'forbidden', 403))).toBe('你的账号没有修改系统设置的权限。请联系管理员。')
  })

  it('服务端校验没通过(400):带上它给的中文原因', () => {
    expect(saveFailureText(new CapabilityError('配置补丁不合法: backup.interval_hours 必须在 1..=720 之间', 'invalid_input', 400))).toBe(
      '保存设置失败:配置补丁不合法: backup.interval_hours 必须在 1..=720 之间。请检查填写的值后重试。',
    )
  })

  it('断网:提示检查网络', () => {
    expect(saveFailureText(new TypeError('Failed to fetch'))).toBe('保存设置失败:连不上服务器。请检查网络后重试。')
  })

  it('认不出的错误:不露英文异常', () => {
    expect(saveFailureText(new CapabilityError('boom', 'internal', 500))).toContain('出现了没有预料到的错误')
    expect(saveFailureText(new CapabilityError('boom', 'internal', 500))).not.toContain('boom')
  })
})
