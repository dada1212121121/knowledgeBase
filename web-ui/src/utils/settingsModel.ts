// 「模型」分区里和服务商目录、密钥、连接测试有关的纯逻辑(便于单测)。
// 目录来自能力 `llm_providers`(后端 `kb_service::llm_provider_catalog`)。

import type { ChoiceOption } from './settingsFields'

export interface LlmProvider {
  id: string
  name: string
  /** 这个服务商约定的环境变量名;没有保存密钥时会读它。本机模型(ollama)没有。 */
  env_var: string | null
  /** 这个服务商的默认接口地址。 */
  base_url: string
  configured: boolean
  current: boolean
  model: string | null
  /** 给人看的说明(例如「本机模型,不需要密钥」「不支持直连」)。 */
  note: string | null
  /** 本版本能不能直连。 */
  supported: boolean
}

export interface LlmCatalog {
  providers: LlmProvider[]
  current: string
  /** 密钥文件里有没有保存过密钥(只告诉有没有,永远不回显)。 */
  secret_present: boolean
}

/** 服务商下拉的选项:只列能直连的。当前配置里的值不在其中时由 SettingRows 补上,不会被悄悄改掉。 */
export function providerOptions(catalog: LlmCatalog | null): ChoiceOption[] {
  return (catalog?.providers ?? []).filter((provider) => provider.supported).map((provider) => ({ value: provider.id, label: provider.name }))
}

const trimSlash = (url: string) => url.trim().replace(/\/+$/, '')

/**
 * 换服务商后接口地址要不要跟着换。
 *
 * 只有「当前地址还是旧服务商的默认地址(或空)」才自动换成新服务商的默认地址;
 * 用户自己改过的地址(代理、私有部署)不动,免得悄悄覆盖。返回 null = 不用改。
 */
export function baseUrlAfterSwitch(catalog: LlmCatalog | null, from: string, to: string, currentUrl: string): string | null {
  const providers = catalog?.providers ?? []
  const next = providers.find((provider) => provider.id === to)
  if (!next?.base_url || from === to) return null
  const previous = providers.find((provider) => provider.id === from)
  const untouched = !currentUrl.trim() || (!!previous && trimSlash(currentUrl) === trimSlash(previous.base_url))
  return untouched && trimSlash(currentUrl) !== trimSlash(next.base_url) ? next.base_url : null
}

/** 密钥怎么来的说明:本机模型不需要;其余可以用页面保存的密钥,或这个服务商约定的环境变量。 */
export function keyHint(catalog: LlmCatalog | null, providerId: string): string {
  const provider = (catalog?.providers ?? []).find((item) => item.id === providerId)
  if (!provider) return ''
  const parts: string[] = []
  if (provider.note) parts.push(provider.note.replace(/[。.]$/, ''))
  if (provider.env_var) parts.push(`没有在这里保存密钥时,会读环境变量 ${provider.env_var}`)
  return parts.length ? `${parts.join('。')}。` : ''
}

const stripEnd = (text: string) => text.replace(/[。.]$/, '')
const HAS_CJK = /[\u4e00-\u9fff]/

/** 测试连接失败的两句话。服务端给的中文原因带上;断网、英文异常换成人话。 */
export function testFailureText(err: unknown): string {
  const raw = err instanceof Error ? err.message.trim() : ''
  const status = typeof err === 'object' && err !== null ? (err as { status?: unknown }).status : undefined
  if (status === 403) return '你的账号没有测试连接的权限。请联系管理员。'
  if (HAS_CJK.test(raw)) return `测试连接失败:${stripEnd(raw)}。请检查密钥、接口地址和模型名后重试。`
  if (err instanceof TypeError) return '测试连接失败:连不上服务器。请检查网络后重试。'
  return '测试连接失败:模型服务没有正常回应。请检查密钥、接口地址和模型名后重试。'
}

/** 测试连接成功的一句话:带上模型的回复,方便确认真的连上了。 */
export function testSuccessText(reply: string | undefined): string {
  const text = (reply ?? '').trim().replace(/\s+/g, ' ')
  return text ? `连接成功,模型回复:${text.length > 60 ? `${text.slice(0, 60)}…` : text}` : '连接成功。'
}
