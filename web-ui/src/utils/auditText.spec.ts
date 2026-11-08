import { describe, expect, it } from 'vitest'
import { AUDIT_FILTERS, actorText, argsSummary, batchTitle, capabilityText, eventKindText, isAiCapability } from './auditText'

describe('capabilityText', () => {
  it('认得的能力名翻成中文', () => {
    expect(capabilityText('save_insight')).toBe('保存笔记')
    expect(capabilityText('revert_batch')).toBe('撤销批次')
    expect(capabilityText('user_totp_reset')).toBe('重置两步验证')
  })
  it('认不得的不露英文名', () => {
    expect(capabilityText('something_new')).toBe('其它操作')
  })
  it('任何译名都不含「AI」二字(AI 总开关关掉后历史记录仍要能读)', () => {
    for (const name of ['agent_send', 'acp_chat', 'review_draft', 'deep_search', 'llm_usage_overview', 'set_llm_key']) {
      expect(capabilityText(name)).not.toMatch(/AI/i)
    }
  })
  it('筛选下拉里每一项都有中文名,没有落到「其它操作」', () => {
    expect(AUDIT_FILTERS.length).toBeGreaterThan(5)
    for (const item of AUDIT_FILTERS) expect(item.label).not.toBe('其它操作')
  })
})

describe('isAiCapability', () => {
  it('助手、编码代理、审核草稿、深度检索算 AI;保存笔记不算', () => {
    expect(['agent_send', 'acp_chat', 'review_draft', 'deep_search'].every(isAiCapability)).toBe(true)
    expect(isAiCapability('save_insight')).toBe(false)
    expect(isAiCapability('search_knowledge')).toBe(false)
  })
})

describe('eventKindText', () => {
  it('进化事件种类翻成中文,认不得的写「其它事件」', () => {
    expect(eventKindText('git_commit')).toBe('提交了代码')
    expect(eventKindText('session_end')).toBe('一次对话结束')
    expect(eventKindText('quality_gate')).toBe('夜间质量门禁')
    expect(eventKindText('weird')).toBe('其它事件')
  })
})

describe('actorText', () => {
  it('本机、MCP 客户端', () => {
    expect(actorText('local')).toBe('本机')
    expect(actorText('user')).toBe('本机')
    expect(actorText('mcp:Claude Code')).toBe('MCP 客户端 Claude Code')
  })
  it('用户 id 只留末六位;查得到名字就用名字', () => {
    expect(actorText('usr_0123456789abcdef')).toBe('用户 …abcdef')
    expect(actorText('usr_0123456789abcdef', new Map([['usr_0123456789abcdef', '张三']]))).toBe('张三')
  })
  it('经分享链接的操作写明经过链接,且不露链接 id', () => {
    expect(actorText('usr_0123456789abcdef(经链接 lnk_99)')).toBe('用户 …abcdef(经分享链接)')
    expect(actorText('usr_0123456789abcdef(经链接 lnk_99)')).not.toContain('lnk_')
  })
  it('空值写 —', () => {
    expect(actorText('  ')).toBe('—')
  })
})

describe('argsSummary', () => {
  it('常见键翻成中文,查询带引号', () => {
    expect(argsSummary('{"query":"重试","collection":"proj/docs","took_ms":41}')).toBe('查询「重试」 · 集合 proj/docs · 耗时 41 毫秒')
  })
  it('认不得的键、对象和数组不写出来', () => {
    expect(argsSummary('{"embedder":"bge-m3","opts":{"a":1},"tags":["x"],"id":"ins_1"}')).toBe('编号 ins_1')
  })
  it('长值截断;坏 JSON 和空值返回空串', () => {
    expect(argsSummary(JSON.stringify({ title: 'x'.repeat(100) }))).toBe(`标题 ${'x'.repeat(40)}…`)
    expect(argsSummary('not json')).toBe('')
    expect(argsSummary(null)).toBe('')
    expect(argsSummary('[1,2]')).toBe('')
  })
})

describe('batchTitle', () => {
  it('默认说明「<能力名> 调用」换成中文', () => {
    expect(batchTitle('save_insight 调用')).toBe('保存笔记')
  })
  it('别的说明原样用', () => {
    expect(batchTitle('导入 12 个文件')).toBe('导入 12 个文件')
  })
})
