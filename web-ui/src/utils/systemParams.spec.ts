import { describe, expect, it } from 'vitest'
import { PARAM_SECTIONS, buildPatch, parseValue, readPath, restartFields, sectionsFor, toDraft } from './systemParams'

const config = {
  ai: { enabled: true, extract: true, deep_search: true, organize: true, assistant: true, acp: true, chunk_context: false },
  accounts: { registration_open: true, require_admin_totp: false, require_invite: false, default_role: 'role_user', block_disposable_email: true, invites_per_user: 0, deletion_cooling_off_days: 7, email_domain_allowlist: [] },
  quota: { storage_gb: 100, max_upload_mb: 200, llm_tokens_per_day: 200000, acp_concurrency_total: 8, acp_concurrency_per_user: 1, acp_minutes: 30, disk_reserve_gb: 30, links_per_user: 1000, friends_per_user: 1000 },
  share: { allow_guest_view: true, allow_guest_comment: false, allow_guest_edit: false, guest_link_gb_per_day: 10, room_max_users: 30 },
  index: { parallel_slices: 0, parallel_files: 1 },
  network: { hf_cdn_direct: true, crawl_allow_private: false },
  site: { name: 'knowledgeBase', tagline: '个人与团队的知识库', public_url: 'https://kb.example.com', timezone: 'Asia/Shanghai' },
}

describe('system params', () => {
  it('every field in the table exists in a default config', () => {
    for (const section of PARAM_SECTIONS) {
      for (const field of section.fields) expect(readPath(config, field.path), field.path).not.toBeUndefined()
    }
  })

  it('dependsOn always points at another bool field in the table', () => {
    const all = PARAM_SECTIONS.flatMap((section) => section.fields)
    for (const field of all.filter((item) => item.dependsOn)) {
      const parent = all.find((item) => item.path === field.dependsOn)
      expect(parent?.kind, `${field.path} 依赖 ${field.dependsOn}`).toBe('bool')
    }
  })

  it('an untouched form produces an empty patch', () => {
    const result = buildPatch(config, toDraft(config))
    expect(result).toEqual({ patch: {}, changed: [] })
  })

  it('only changed keys end up in the patch, grouped by section', () => {
    const draft = toDraft(config)
    draft['quota.storage_gb'] = '500'
    draft['ai.enabled'] = false
    draft['accounts.email_domain_allowlist'] = 'QQ.com， 163.com'
    const result = buildPatch(config, draft)
    expect(result).toEqual({
      patch: { quota: { storage_gb: 500 }, ai: { enabled: false }, accounts: { email_domain_allowlist: ['qq.com', '163.com'] } },
      changed: ['ai.enabled', 'accounts.email_domain_allowlist', 'quota.storage_gb'],
    })
  })

  it('rejects bad numbers and bad urls instead of sending them', () => {
    const draft = toDraft(config)
    draft['quota.storage_gb'] = '0'
    expect(buildPatch(config, draft)).toHaveProperty('error')
    draft['quota.storage_gb'] = '12.5'
    expect(buildPatch(config, draft)).toHaveProperty('error')
    draft['quota.storage_gb'] = '100'
    draft['site.public_url'] = 'kb.example.com'
    expect(buildPatch(config, draft)).toEqual({ error: '对外地址要以 http:// 或 https:// 开头' })
    draft['site.public_url'] = 'https://kb.example.com'
    draft['site.name'] = '   '
    expect(buildPatch(config, draft)).toHaveProperty('error')
    draft['site.name'] = 'knowledgeBase'
    draft['site.timezone'] = '+08:00'
    expect(buildPatch(config, draft)).toEqual({ error: expect.stringContaining('IANA') })
    draft['site.timezone'] = 'Asia/Shanghai'
  })

  it('parses a list field and clears it when emptied', () => {
    const field = PARAM_SECTIONS.flatMap((s) => s.fields).find((f) => f.path === 'accounts.email_domain_allowlist')!
    expect(parseValue(field, '')).toEqual({ value: [] })
    expect(parseValue(field, 'a.com,b.com  c.com')).toEqual({ value: ['a.com', 'b.com', 'c.com'] })
  })

  it('新增的参数:批量索引并发、内网抓取(风险 + 需要重启)、管理员两步验证(风险提示)', () => {
    const all = PARAM_SECTIONS.flatMap((section) => section.fields)
    const slices = all.find((field) => field.path === 'index.parallel_slices')!
    expect(slices.kind).toBe('number')
    expect([slices.min, slices.max]).toEqual([0, 8])
    // 批次内并发解析:1 = 逐个处理,上限与 config.rs 的 MAX_PARALLEL_FILES 一致
    const files = all.find((field) => field.path === 'index.parallel_files')!
    expect(files.kind).toBe('number')
    expect([files.min, files.max]).toEqual([1, 8])
    const crawl = all.find((field) => field.path === 'network.crawl_allow_private')!
    expect(crawl.restart).toBe(true)
    expect(crawl.risk).toContain('风险')
    expect(all.find((field) => field.path === 'accounts.require_admin_totp')!.risk).toContain('两步验证')
  })

  it('改了内网抓取:补丁按 network 分组,并被识别为需要重启', () => {
    const draft = toDraft(config)
    draft['network.crawl_allow_private'] = true
    draft['index.parallel_slices'] = '2'
    const result = buildPatch(config, draft)
    expect(result).toEqual({ patch: { index: { parallel_slices: 2 }, network: { crawl_allow_private: true } }, changed: ['index.parallel_slices', 'network.crawl_allow_private'] })
    expect(restartFields('changed' in result ? result.changed : []).map((field) => field.path)).toEqual(['network.crawl_allow_private'])
  })

  it('并发填 0 合法(自动),填负数 / 小数不合法', () => {
    const field = PARAM_SECTIONS.flatMap((section) => section.fields).find((item) => item.path === 'index.parallel_slices')!
    expect(parseValue(field, '0')).toEqual({ value: 0 })
    expect(parseValue(field, '-1')).toHaveProperty('error')
    expect(parseValue(field, '1.5')).toHaveProperty('error')
  })

  it('全站并发也封顶 8:后台每个知识库就开这么多条循环', () => {
    const field = PARAM_SECTIONS.flatMap((section) => section.fields).find((item) => item.path === 'index.parallel_slices')!
    expect(parseValue(field, '8')).toEqual({ value: 8 })
    expect(parseValue(field, '9')).toEqual({ error: '「批量索引的全站并发」不能大于 8' })
  })

  it('批次内并发解析超过上限时就地报错,不用等保存', () => {
    const field = PARAM_SECTIONS.flatMap((section) => section.fields).find((item) => item.path === 'index.parallel_files')!
    expect(parseValue(field, '1')).toEqual({ value: 1 })
    expect(parseValue(field, '8')).toEqual({ value: 8 })
    // 上限 8 与 config.rs 的 IndexConfig::MAX_PARALLEL_FILES 一致,填 9 会更早被后端拒
    expect(parseValue(field, '9')).toEqual({ error: '「一个批次内的并发解析」不能大于 8' })
  })

  it('配额的三层覆盖在存储和 AI 两个分组的说明里都讲清了', () => {
    for (const id of ['storage', 'ai']) {
      const note = PARAM_SECTIONS.find((section) => section.id === id)!.note ?? ''
      expect(note, id).toContain('覆盖')
      expect(note, id).toContain('用户与权限')
    }
  })
})

describe('sectionsFor(AI 总开关)', () => {
  it('开着是完整字段表', () => {
    expect(sectionsFor(true)).toBe(PARAM_SECTIONS)
  })
  it('关着:AI 分区只剩总开关,文字里没有「AI」,其它分区原样', () => {
    const sections = sectionsFor(false)
    const ai = sections.find((section) => section.id === 'ai')!
    expect(ai.fields.map((field) => field.path)).toEqual(['ai.enabled'])
    expect(JSON.stringify(ai)).not.toMatch(/AI/)
    expect(sections.filter((section) => section.id !== 'ai')).toEqual(PARAM_SECTIONS.filter((section) => section.id !== 'ai'))
  })
  it('关着时整张表里没有任何字段文字含「AI」(站点标语的说明也不含)', () => {
    const texts = sectionsFor(false).flatMap((section) => [section.title, section.note ?? '', ...section.fields.flatMap((field) => [field.label, field.hint ?? '', field.risk ?? ''])])
    expect(texts.join('\n')).not.toMatch(/AI/)
  })
  it('页面上不出现 token / LLM / role_user 这类内部词', () => {
    const texts = PARAM_SECTIONS.flatMap((section) => [section.title, section.note ?? '', ...section.fields.flatMap((field) => [field.label, field.hint ?? '', field.risk ?? '', field.unit ?? ''])])
    expect(texts.join('\n')).not.toMatch(/token|LLM|role_user|用户管理|API 令牌/i)
  })
  it('默认角色是 role 类型,没选不能保存', () => {
    const field = PARAM_SECTIONS.flatMap((section) => section.fields).find((item) => item.path === 'accounts.default_role')!
    expect(field.kind).toBe('role')
    expect(parseValue(field, '')).toEqual({ error: '请选择「新用户的默认角色」' })
    expect(parseValue(field, 'role_team')).toEqual({ value: 'role_team' })
  })
})
