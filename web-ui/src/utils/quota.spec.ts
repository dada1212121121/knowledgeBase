import { describe, expect, it } from 'vitest'
import { QUOTA_FIELDS, buildQuota, overrideCount, parseQuota, quotaChanged, quotaFields, toQuotaDraft } from './quota'

describe('配额覆盖', () => {
  it('解析 quota_json:不是对象 / 坏 JSON / 负数 / 小数 / 字符串都当没有', () => {
    expect(parseQuota('{"storage_gb":50,"links_per_user":0}')).toEqual({ storage_gb: 50, links_per_user: 0 })
    expect(parseQuota('')).toEqual({})
    expect(parseQuota(null)).toEqual({})
    expect(parseQuota('[1]')).toEqual({})
    expect(parseQuota('not json')).toEqual({})
    expect(parseQuota('{"storage_gb":-1,"max_upload_mb":1.5,"acp_minutes":"30"}')).toEqual({})
  })

  it('草稿:有覆盖的项填数字,没有的留空', () => {
    const draft = toQuotaDraft('{"storage_gb":500}')
    expect(draft.storage_gb).toBe('500')
    expect(draft.max_upload_mb).toBe('')
  })

  it('空 = 沿用默认,不写进覆盖;填了才写', () => {
    const draft = toQuotaDraft('')
    draft.storage_gb = '300'
    draft.links_per_user = ' 20 '
    expect(buildQuota(draft, '')).toEqual({ quota: { storage_gb: 300, links_per_user: 20 } })
    expect(buildQuota(toQuotaDraft(''), '')).toEqual({ quota: {} })
  })

  it('清空一项 = 取消这项覆盖', () => {
    const draft = toQuotaDraft('{"storage_gb":500,"acp_minutes":10}')
    draft.storage_gb = ''
    expect(buildQuota(draft, '{"storage_gb":500,"acp_minutes":10}')).toEqual({ quota: { acp_minutes: 10 } })
  })

  it('编辑器不认识的键(手写进去的)保存时原样保留', () => {
    const original = '{"acp_concurrency_total":99,"storage_gb":10}'
    const draft = toQuotaDraft(original)
    draft.storage_gb = '20'
    expect(buildQuota(draft, original)).toEqual({ quota: { acp_concurrency_total: 99, storage_gb: 20 } })
  })

  it('0 只在有特殊含义的项里合法:存储和 AI 额度 0 = 不限,单文件上限不能是 0', () => {
    const ok = toQuotaDraft('')
    ok.storage_gb = '0'
    ok.llm_tokens_per_day = '0'
    expect(buildQuota(ok, '')).toEqual({ quota: { storage_gb: 0, llm_tokens_per_day: 0 } })
    for (const key of ['max_upload_mb']) {
      const bad = toQuotaDraft('')
      bad[key] = '0'
      expect(buildQuota(bad, ''), key).toHaveProperty('error')
    }
  })

  it('小数、负数、非数字、过大的数都不合法,不发请求', () => {
    for (const text of ['1.5', '-3', 'abc', '１２', '99999999999999999999']) {
      const draft = toQuotaDraft('')
      draft.storage_gb = text
      expect(buildQuota(draft, ''), text).toHaveProperty('error')
    }
  })

  it('改动检测:空白差异不算改动', () => {
    const original = '{"storage_gb":100}'
    expect(quotaChanged(toQuotaDraft(original), original)).toBe(false)
    const draft = toQuotaDraft(original)
    draft.storage_gb = ' 100 '
    expect(quotaChanged(draft, original)).toBe(false)
    draft.storage_gb = '101'
    expect(quotaChanged(draft, original)).toBe(true)
  })

  it('覆盖项数只数编辑器认识的键', () => {
    expect(overrideCount('{"storage_gb":1,"acp_concurrency_total":3}')).toBe(1)
    expect(overrideCount('')).toBe(0)
  })

  it('编码代理的三项后端没有读取,不在字段表里(想加回来先让后端真的读)', () => {
    const keys = QUOTA_FIELDS.map((field) => field.key)
    for (const key of ['acp_concurrency_total', 'acp_concurrency_per_user', 'acp_minutes']) expect(keys, key).not.toContain(key)
  })
  it('字段表的键都在后端 QuotaConfig 里(拼错了后端会静默忽略)', () => {
    const backend = ['storage_gb', 'max_upload_mb', 'llm_tokens_per_day', 'acp_concurrency_total', 'acp_concurrency_per_user', 'acp_minutes', 'disk_reserve_gb', 'links_per_user', 'friends_per_user']
    for (const field of QUOTA_FIELDS) expect(backend, field.key).toContain(field.key)
  })
})

describe('AI 总开关关掉后的配额项', () => {
  it('AI 额度和编码代理的三项标成 ai,关掉后编辑器里不列', () => {
    expect(quotaFields(true).map((field) => field.key)).toContain('llm_tokens_per_day')
    expect(quotaFields(false).map((field) => field.key)).toEqual(['storage_gb', 'max_upload_mb', 'links_per_user', 'friends_per_user'])
  })
  it('标题里的「已覆盖 N 项」只数看得到的项', () => {
    const json = JSON.stringify({ storage_gb: 5, llm_tokens_per_day: 1000 })
    expect(overrideCount(json)).toBe(2)
    expect(overrideCount(json, false)).toBe(1)
  })
  it('看不到的项:已有的覆盖值照样保留,保存时不丢', () => {
    const json = JSON.stringify({ storage_gb: 5, llm_tokens_per_day: 1000 })
    const draft = toQuotaDraft(json)
    draft.storage_gb = '8'
    expect(buildQuota(draft, json)).toEqual({ quota: { storage_gb: 8, llm_tokens_per_day: 1000 } })
  })
  it('额度的单位不在界面上写 token', () => {
    expect(QUOTA_FIELDS.map((field) => `${field.label}${field.unit ?? ''}`).join('')).not.toMatch(/token/i)
  })
})
