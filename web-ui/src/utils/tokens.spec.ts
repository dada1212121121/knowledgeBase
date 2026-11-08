import { describe, expect, it } from 'vitest'
import { AccountError } from '@/api/client'
import { checkTokenName, explainTokenError, sharedApplies } from './tokens'

describe('checkTokenName', () => {
  it('空白名字不行,其余都交给后端判断重名', () => {
    expect(checkTokenName('')).toContain('起个名字')
    expect(checkTokenName('   ')).toContain('起个名字')
    expect(checkTokenName('kiro-笔记本')).toBeNull()
  })
})

describe('sharedApplies', () => {
  it('只有 MCP 令牌会搜到别人分享给我的内容', () => {
    expect(sharedApplies('mcp')).toBe(true)
    expect(sharedApplies('api')).toBe(false)
  })
})

describe('explainTokenError', () => {
  const err = (status: number, message = '后端的话') => new AccountError(message, status, 0, '')

  it('重名(409):点出名字并说怎么办', () => {
    const text = explainTokenError(err(409, '已有同名令牌:ci'), ' ci ')
    expect(text).toContain('「ci」')
    expect(text).toContain('先撤销旧的')
  })

  it('没开通(403)用统一话术', () => {
    expect(explainTokenError(err(403))).toContain('没有开通这个功能,请联系管理员')
  })

  it('已不存在(404)提示刷新', () => {
    expect(explainTokenError(err(404))).toContain('刷新列表')
  })

  it('网络错误不给英文异常;其它错误带后端的话', () => {
    expect(explainTokenError(new TypeError('Failed to fetch'))).toContain('连不上服务器')
    expect(explainTokenError(err(500, '数据库忙'))).toBe('数据库忙。请稍后再试。')
  })
})
