import { describe, expect, it } from 'vitest'
import { CapabilityError } from '@/api/client'
import { baseUrlAfterSwitch, keyHint, providerOptions, testFailureText, testSuccessText, type LlmCatalog } from './settingsModel'

const CATALOG: LlmCatalog = {
  current: 'deepseek',
  secret_present: true,
  providers: [
    { id: 'deepseek', name: 'DeepSeek', env_var: 'DEEPSEEK_API_KEY', base_url: 'https://api.deepseek.com', configured: true, current: true, model: 'deepseek-chat', note: null, supported: true },
    { id: 'openai', name: 'OpenAI', env_var: 'OPENAI_API_KEY', base_url: 'https://api.openai.com/v1', configured: false, current: false, model: null, note: null, supported: true },
    { id: 'anthropic', name: 'Anthropic', env_var: 'ANTHROPIC_API_KEY', base_url: 'https://api.anthropic.com', configured: false, current: false, model: null, note: 'Anthropic 不是 OpenAI 兼容接口,本版本不支持直连', supported: false },
    { id: 'ollama', name: '本地 Ollama', env_var: null, base_url: 'http://127.0.0.1:11434', configured: false, current: false, model: null, note: '本机模型,不需要密钥', supported: true },
  ],
}

describe('providerOptions', () => {
  it('只列能直连的服务商', () => {
    expect(providerOptions(CATALOG)).toEqual([
      { value: 'deepseek', label: 'DeepSeek' },
      { value: 'openai', label: 'OpenAI' },
      { value: 'ollama', label: '本地 Ollama' },
    ])
  })

  it('目录还没读到:没有选项(页面退回文本框)', () => {
    expect(providerOptions(null)).toEqual([])
  })
})

describe('baseUrlAfterSwitch', () => {
  it('地址还是旧服务商的默认地址:跟着换成新服务商的默认地址', () => {
    expect(baseUrlAfterSwitch(CATALOG, 'deepseek', 'openai', 'https://api.deepseek.com')).toBe('https://api.openai.com/v1')
    expect(baseUrlAfterSwitch(CATALOG, 'deepseek', 'openai', 'https://api.deepseek.com/ ')).toBe('https://api.openai.com/v1')
  })

  it('用户自己改过的地址(代理、私有部署)不动', () => {
    expect(baseUrlAfterSwitch(CATALOG, 'deepseek', 'openai', 'https://proxy.example.com/v1')).toBeNull()
  })

  it('地址是空的:填上新服务商的默认地址', () => {
    expect(baseUrlAfterSwitch(CATALOG, 'deepseek', 'ollama', '  ')).toBe('http://127.0.0.1:11434')
  })

  it('没换服务商 / 目录里没有新服务商:不动', () => {
    expect(baseUrlAfterSwitch(CATALOG, 'deepseek', 'deepseek', '')).toBeNull()
    expect(baseUrlAfterSwitch(CATALOG, 'deepseek', 'mystery', 'https://api.deepseek.com')).toBeNull()
    expect(baseUrlAfterSwitch(null, 'deepseek', 'openai', '')).toBeNull()
  })

  it('旧服务商不在目录里(手写的服务商名):只有地址为空才填', () => {
    expect(baseUrlAfterSwitch(CATALOG, 'custom', 'openai', 'https://x.example.com')).toBeNull()
    expect(baseUrlAfterSwitch(CATALOG, 'custom', 'openai', '')).toBe('https://api.openai.com/v1')
  })
})

describe('keyHint', () => {
  it('有环境变量:说明没保存密钥时读它', () => {
    expect(keyHint(CATALOG, 'deepseek')).toBe('没有在这里保存密钥时,会读环境变量 DEEPSEEK_API_KEY。')
  })

  it('本机模型:不需要密钥', () => {
    expect(keyHint(CATALOG, 'ollama')).toBe('本机模型,不需要密钥。')
  })

  it('不支持直连的服务商带上说明', () => {
    expect(keyHint(CATALOG, 'anthropic')).toContain('不支持直连')
  })

  it('不认识的服务商 / 没有目录:什么都不说,不编', () => {
    expect(keyHint(CATALOG, 'mystery')).toBe('')
    expect(keyHint(null, 'deepseek')).toBe('')
  })
})

describe('测试连接的文案', () => {
  it('失败:服务端给的中文原因带上,再说怎么办', () => {
    expect(testFailureText(new CapabilityError('当前服务商没有 API key:先保存密钥,或设置对应的环境变量', 'invalid_input', 400))).toBe(
      '测试连接失败:当前服务商没有 API key:先保存密钥,或设置对应的环境变量。请检查密钥、接口地址和模型名后重试。',
    )
  })

  it('失败:英文异常不露出来', () => {
    const text = testFailureText(new CapabilityError('upstream 502 Bad Gateway', 'unavailable', 502))
    expect(text).not.toContain('502')
    expect(text).toContain('请检查密钥')
  })

  it('失败:断网 / 无权限', () => {
    expect(testFailureText(new TypeError('Failed to fetch'))).toBe('测试连接失败:连不上服务器。请检查网络后重试。')
    expect(testFailureText(new CapabilityError('forbidden', 'forbidden', 403))).toBe('你的账号没有测试连接的权限。请联系管理员。')
  })

  it('成功:带上模型的回复,太长截断,没回复也算成功', () => {
    expect(testSuccessText('你好!')).toBe('连接成功,模型回复:你好!')
    expect(testSuccessText('a'.repeat(80))).toBe(`连接成功,模型回复:${'a'.repeat(60)}…`)
    expect(testSuccessText('  \n')).toBe('连接成功。')
    expect(testSuccessText(undefined)).toBe('连接成功。')
  })
})
