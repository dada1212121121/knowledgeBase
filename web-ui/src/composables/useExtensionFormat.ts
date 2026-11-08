/**
 * 文件浏览页 / 文件查看器问「编辑器扩展」认不认识这个格式（留下的入口缺口）
 *
 * 外壳（EditorHost）早就支持扩展注册 Codec 与内容面，但文件页按自己的规则挑查看器，遇到内置不认识的
 * 扩展名只会走「代码视图 / 嗅探 / 下载」，扩展格式实际打不开。这里补上入口：
 *
 * - 只有页面**自己不认得**的扩展名才问（`isBuiltinViewFormat`）：内置格式永远优先，扩展不能接管；
 * - 只有可能装了扩展的人才问：扩展只给管理员加载，已知没有「系统参数」功能点的用户
 *   不下载运行时、也不请求清单（后端对他们反正是 403）；
 * - 问之前先确保扩展已加载（每个页面只请求一次清单，和 EditorHost 共用同一份结果），
 *   之后跟着注册表的变化走：管理员改了 `[editor] extensions` 开关，扩展装上 / 卸载，结论立刻更新；
 * - 扩展运行时是按需动态加载的，不进文件页的静态依赖（文件页的阅读体积预算不能为它让路）。
 *
 * 保存仍然走和文本文件一样的通道与版本检查，Codec 的写回也仍受 `document.write` 权限闸门约束。
 */
import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { useSessionStore } from '@/stores/session'
import { isBuiltinViewFormat } from '@/utils/viewKind'
import type { EditorSource } from '@/editor/types'

export interface ExtensionFormat {
  /** 扩展名（小写、不带点），交给 EditorHost 当 `request.format` */
  ext: string
  /** 内容面类型：扩展自己的内容面（`ext:<贡献 id>`），或 Codec 指定的内置内容面 */
  kind: string
  /** 扩展带了 Codec：文件字节要先经 Codec 解码成可编辑文本，保存时再编码回去 */
  hasCodec: boolean
}

/** 路径 / 文件名里的扩展名（小写、不带点）；没有扩展名（Makefile、.gitignore）返回空串 */
export function extensionOfName(name: string | undefined): string {
  const base = (name ?? '').split('/').pop() ?? ''
  const at = base.lastIndexOf('.')
  return at > 0 && at < base.length - 1 ? base.slice(at + 1).toLowerCase() : ''
}

/** 已知不是管理员（没有「系统参数」功能点）。会话还没加载 / 没有 Pinia（独立挂载、测试）时不知道，按「可能是」处理 */
function knownNotAdmin(): boolean {
  try {
    return !useSessionStore().has('sys.settings')
  } catch {
    return false
  }
}

/**
 * 页面不认得、又可能有扩展认领的扩展名；否则返回空串。
 * 只看名字和身份，不碰网络：调用方据此决定要不要去问注册表。
 */
function candidateExtension(name: string | undefined): string {
  const ext = extensionOfName(name)
  if (!ext || isBuiltinViewFormat(ext)) return ''
  // 已知不是管理员：扩展清单对他们必然是 403，连运行时都不用下载
  return knownNotAdmin() ? '' : ext
}

export function useExtensionFormat(name: () => string | undefined): { format: Readonly<Ref<ExtensionFormat | null>>; pending: Readonly<Ref<boolean>> } {
  const format = ref<ExtensionFormat | null>(null)
  /** 正在问（运行时 / 清单还没回来）：调用方这时先别落到回退查看器，免得闪一下再换 */
  const pending = ref(false)
  let release: (() => void) | null = null

  watch(
    () => candidateExtension(name()),
    async (ext, _old, onCleanup) => {
      let stale = false
      onCleanup(() => {
        stale = true
        release?.()
        release = null
      })
      format.value = null
      pending.value = false
      if (!ext) return
      pending.value = true
      try {
        const runtime = await import('@/editor/extensions/runtime')
        if (stale) return
        // 热更新开着：管理员在页面打开期间改开关，扩展装上 / 撤掉，下面的订阅会重新判断
        const stopConfig = runtime.watchExtensionConfig()
        const registry = runtime.getExtensionRegistry()
        const decide = () => {
          const claimed = registry.surfaceFor(ext) ?? registry.codecFor(ext)
          const kind = claimed ? registry.resolveKind(ext) : null
          format.value = claimed && kind ? { ext, kind, hasCodec: registry.codecFor(ext) !== null } : null
        }
        const stopRegistry = registry.subscribe(decide)
        release = () => {
          stopConfig()
          stopRegistry()
        }
        if (stale) return release()
        // 清单接口出错、没权限都不会 reject（加载器永远 resolve），这里只管等它结束
        await runtime.ensureExtensionsLoaded(runtime.defaultExtensionGate)
        if (!stale) decide()
      } catch {
        // 运行时 chunk 拉不到等意外：当作没有扩展认领，页面回到原来的回退
        if (!stale) format.value = null
      } finally {
        if (!stale) pending.value = false
      }
    },
    { immediate: true },
  )
  onBeforeUnmount(() => {
    release?.()
    release = null
  })
  return { format, pending }
}

const encoder = new TextEncoder()

/**
 * 文件页拿到的文本（≤512 KB 的 UTF-8）→ 打开请求的来源。
 * 扩展带了 Codec 时给字节：外壳只对字节来源跑 Codec 的 decode，保存时再 encode 回去；
 * 没有 Codec 就直接给文本，内容面自己看到的就是文件原文。
 */
export function extensionSourceOf(text: string, name: string, hasCodec: boolean): EditorSource {
  return hasCodec ? { kind: 'bytes', bytes: encoder.encode(text), name } : { kind: 'text', text, name }
}

/**
 * 保存通道收到的内容 → 文件页的文本保存（`save_file` 只收 UTF-8 文本）。
 * Codec 编码出的字节必须是合法 UTF-8，否则拒绝并说明原因：宁可存不了，也不能把二进制当文本悄悄写坏文件。
 */
export function saveTextOf(source: EditorSource): { ok: true; text: string } | { ok: false; reason: string } {
  if (source.kind === 'text') return { ok: true, text: source.text }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(source.bytes) }
  } catch {
    return { ok: false, reason: '这个格式编码出来的内容不是 UTF-8 文本，文件页只能保存文本文件，已取消保存（原文件没有改动）' }
  }
}
