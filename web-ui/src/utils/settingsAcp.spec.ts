import { describe, expect, it } from 'vitest'
import { CapabilityError } from '@/api/client'
import { acpFailure, agentState, envEntries, envPayload, isSecretEnv, npmPackage, permissionConfirm, sandboxConfirm, splitArgs, uninstallMessage, validateAgentForm } from './settingsAcp'

const form = (extra: Partial<Parameters<typeof validateAgentForm>[0]> = {}) => ({ id: 'my-agent', name: '', command: 'my-agent', args: '', ...extra })

describe('validateAgentForm', () => {
  it('合法的表单没有报错', () => {
    expect(validateAgentForm(form())).toEqual({})
    expect(validateAgentForm(form({ command: '/opt/my-agent' }))).toEqual({})
    expect(validateAgentForm(form({ id: 'a.b_c-1' }))).toEqual({})
  })

  it('标识:不能空、只能用字母数字 - _ .、不能和已有的重复', () => {
    expect(validateAgentForm(form({ id: '  ' })).id).toBe('请填一个标识')
    expect(validateAgentForm(form({ id: 'my agent' })).id).toBe('只能用字母、数字、-、_、.')
    expect(validateAgentForm(form({ id: '代理' })).id).toBe('只能用字母、数字、-、_、.')
    expect(validateAgentForm(form({ id: 'claude' }), ['claude', 'codex']).id).toContain('已经有了')
  })

  it('启动命令:不能空;不能是解释器;带 / 的必须是绝对路径', () => {
    expect(validateAgentForm(form({ command: '' })).command).toBe('请填启动命令')
    for (const shell of ['sh', 'bash', 'env', '/bin/bash', '/usr/bin/env']) {
      expect(validateAgentForm(form({ command: shell })).command, shell).toContain('解释器')
    }
    expect(validateAgentForm(form({ command: './agent' })).command).toContain('绝对路径')
    expect(validateAgentForm(form({ command: 'bin/agent' })).command).toContain('绝对路径')
  })

  it('两处错误同时给', () => {
    expect(Object.keys(validateAgentForm(form({ id: '', command: '' }))).sort()).toEqual(['command', 'id'])
  })
})

describe('小工具', () => {
  it('参数按空白拆', () => {
    expect(splitArgs('  --acp   --verbose ')).toEqual(['--acp', '--verbose'])
    expect(splitArgs('')).toEqual([])
  })

  it('密钥类变量名', () => {
    expect(isSecretEnv('OPENAI_API_KEY')).toBe(true)
    expect(isSecretEnv('auth_token')).toBe(true)
    expect(isSecretEnv('OPENAI_BASE_URL')).toBe(false)
  })

  it('npm 规格 → 包名(与后端一致)', () => {
    expect(npmPackage('@anthropic/claude-acp@1.2.3')).toBe('@anthropic/claude-acp')
    expect(npmPackage('codex-acp')).toBe('codex-acp')
    expect(npmPackage('pkg@latest')).toBe('pkg')
  })

  it('卸载确认:只动知识库自己的 acp-tools,不是系统全局(以前写成“全局安装,其他工具也可能在用”)', () => {
    const text = uninstallMessage('pkg@latest')
    expect(text).toContain('acp-tools')
    expect(text).not.toContain('全局')
  })
})

describe('agentState', () => {
  it('已安装 / 未安装;被选为默认却没装好的标红', () => {
    expect(agentState({ id: 'a', available: true }, 'a')).toEqual({ label: '已安装', tone: 'success' })
    expect(agentState({ id: 'a', available: false }, '')).toEqual({ label: '未安装', tone: 'neutral' })
    expect(agentState({ id: 'a', available: false }, 'a')).toEqual({ label: '未安装 · 已选为默认', tone: 'danger' })
  })
})

describe('变量行', () => {
  it('内置代理约定的地址 / 密钥 / 模型变量先放好空行;已有的保持原样(密钥是 ••••)', () => {
    const entries = envEntries({ env: { OPENAI_API_KEY: '••••' }, env_hint: { base: 'OPENAI_BASE_URL', key: 'OPENAI_API_KEY', model: 'OPENAI_MODEL' } })
    expect(entries).toEqual([
      { key: 'OPENAI_API_KEY', value: '••••' },
      { key: 'OPENAI_BASE_URL', value: '' },
      { key: 'OPENAI_MODEL', value: '' },
    ])
  })

  it('自定义代理没有约定:只有已有的', () => {
    expect(envEntries({ env: { A: '1' }, env_hint: null })).toEqual([{ key: 'A', value: '1' }])
    expect(envEntries({ env: {}, env_hint: null })).toEqual([])
  })

  it('提交:丢掉没有名字的行、同名取后面的;••••(保持)和空串(删除)原样交给后端', () => {
    expect(envPayload([{ key: ' A ', value: '1' }, { key: '', value: 'x' }, { key: 'A', value: '2' }, { key: 'K', value: '••••' }, { key: 'E', value: '' }])).toEqual({ A: '2', K: '••••', E: '' })
  })
})

describe('确认文案', () => {
  it('全部自动放行:红色,说清代理能做什么', () => {
    const all = permissionConfirm('all')
    expect(all.danger).toBe(true)
    expect(all.message).toContain('写文件')
    expect(permissionConfirm('read').danger).toBe(false)
    expect(permissionConfirm('none').danger).toBe(false)
  })

  it('关沙箱:红色,说清后果;开沙箱:提醒旧会话要重开', () => {
    expect(sandboxConfirm(false)).toMatchObject({ danger: true, confirmText: '关闭沙箱' })
    expect(sandboxConfirm(false).message).toContain('同权')
    expect(sandboxConfirm(true).danger).toBe(false)
    expect(sandboxConfirm(true).message).toContain('重开')
  })

  it('确认文案里没有 none / all 这类配置值(以前写着“none 最严,all 会自动放行”)', () => {
    for (const value of ['none', 'read', 'all']) {
      const { title, message } = permissionConfirm(value)
      expect(`${title}${message}`).not.toMatch(/\b(none|all)\b/)
    }
  })
})

describe('acpFailure', () => {
  it('带上服务端的中文原因;英文标识符前后留空格', () => {
    expect(acpFailure('安装 codex', new CapabilityError('npm 超过 5 分钟没有结束', 'unavailable', 503))).toBe('安装 codex 失败:npm 超过 5 分钟没有结束。请稍后重试。')
  })

  it('英文异常换成人话;无权限单独说', () => {
    expect(acpFailure('保存', new CapabilityError('boom', 'internal', 500))).toBe('保存失败:服务没有正常回应。请稍后重试。')
    expect(acpFailure('保存', new CapabilityError('forbidden', 'forbidden', 403))).toBe('保存失败:你的账号没有这个权限。请联系管理员。')
  })

  it('可以自定义“怎么办”', () => {
    expect(acpFailure('测试 x', new Error('连不上'), '请检查命令是否装好')).toBe('测试 x 失败:连不上。请检查命令是否装好。')
  })
})
