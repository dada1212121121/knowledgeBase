// 组件(OCR / 转写 / 嵌入 / 重排 …)的展示状态——仪表盘「模型与 sidecar」和设置「组件」共用这一份判定。
//
// 后端给的是三个互相独立的事实:
//   current   配置里选了它(默认后端)
//   installed 本机找得到它的命令 / 模型
//   ready     现在就能用
// 直接各画一个徽章会出现「当前」+「未安装」这种自相矛盾的画面。
// 这里把它们合成**一个**状态,并给出一句人话解释。

export interface ProviderFacts {
  installed: boolean
  ready: boolean
  current: boolean
  detail?: string | null
}

export type ProviderTone = 'success' | 'warning' | 'neutral'

export interface ProviderState {
  key: 'active' | 'broken' | 'available' | 'unready' | 'missing'
  label: string
  tone: ProviderTone
  /** 一句话解释(给 title / 说明行用) */
  hint: string
  /** 已选用但现在用不了——需要用户处理 */
  broken: boolean
}

export function providerState(provider: ProviderFacts): ProviderState {
  if (provider.current && provider.ready) {
    return { key: 'active', label: '使用中', tone: 'success', hint: '已设为默认,运行正常', broken: false }
  }
  if (provider.current) {
    return provider.installed
      ? { key: 'broken', label: '已选用 · 未就绪', tone: 'warning', hint: '已设为默认,但还没准备好,相关功能暂不可用', broken: true }
      : { key: 'broken', label: '已选用 · 缺运行时', tone: 'warning', hint: '已设为默认,但本机还没装好运行时,相关功能暂不可用', broken: true }
  }
  if (provider.ready) {
    return { key: 'available', label: '可用', tone: 'neutral', hint: '已就绪,可设为默认', broken: false }
  }
  return provider.installed
    ? { key: 'unready', label: '未就绪', tone: 'neutral', hint: '已安装但还没准备好', broken: false }
    : { key: 'missing', label: '未安装', tone: 'neutral', hint: '本机未安装,不影响当前使用', broken: false }
}

/** 一行里放不下整句诊断时,优先显示短状态;完整文案进 title。 */
export function shortNote(provider: ProviderFacts, limit = 14): string {
  const state = providerState(provider)
  const detail = (provider.detail ?? '').trim()
  return detail && detail.length <= limit ? detail : state.label
}

/** 「在线」只数正在使用的组件:没装的备选后端(例如 tesseract)不算故障。 */
export function onlineCount(providers: ProviderFacts[]): { ok: number; total: number } {
  const inUse = providers.filter((item) => item.current)
  return { ok: inUse.filter((item) => item.ready).length, total: inUse.length }
}
