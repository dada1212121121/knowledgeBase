/**
 * 代码块里的语法高亮
 *
 * 旧编辑器（Crepe 的 CodeMirror 功能）每个代码块里是一个 CodeMirror 实例，自带高亮。新文本面的代码块是普通的
 * ProseMirror 文本节点（保存 / 协同房间格式不变，内容就是 code_block 的文字），所以高亮用「行内装饰」叠上去：
 * 不改文档、不进撤销栈、不影响协同；颜色与旧编辑器 / 文件浏览器同一组 `--code-*` 变量（见 tokens/browser.css 的 `.kb-tok`）。
 *
 * 这个文件是**静态加载的外壳**，只管「什么时候要高亮」；CodeMirror 语言表与 Lezer 解析（约 100 KB gzip）都在
 * `codeHighlightEngine.ts`，文档里第一次出现带语言的代码块时才动态加载（笔记编辑增量 ≤ 150 KB gzip，
 * 由 `editor-native --surface=text` 的构建期门禁把关）。引擎和语言包到位之前，代码块按纯文本显示；
 * 到位后只是叠上颜色（装饰重建），文字和版面都不动，所以不会跳版面。
 */
import { Plugin, PluginKey } from 'prosemirror-state'
import type { Node as PMNode } from 'prosemirror-model'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { HighlightBlock } from './codeHighlightEngine'

type Engine = typeof import('./codeHighlightEngine')

/** 不走语法高亮的块：流程图 / 公式有自己的预览；纯文本没有语法 */
const PLAIN = new Set(['', 'mermaid', 'latex', 'math', 'tex', 'text', 'txt', 'plain', 'plaintext'])

/** 围栏信息串 → 语言名（取第一个词、转小写；```js {1,3} 里后面的参数不算）。纯文本类返回 null */
export function fenceLanguage(info: string): string | null {
  const name = info.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  return PLAIN.has(name) ? null : name
}

const READY = 'kb-code-highlight-ready'

/** 引擎模块：加载好之前是 null；失败（chunk 拉不到）后不再重试，代码块就一直是纯文本 */
let engine: Engine | null = null
let engineLoading: Promise<Engine | null> | null = null
let engineFailed = false

/** 加载引擎（所有文本面实例共用同一个 Promise） */
function loadEngine(): Promise<Engine | null> {
  if (engine || engineFailed) return Promise.resolve(engine)
  engineLoading ??= import('./codeHighlightEngine')
    .then((loaded) => (engine = loaded))
    .catch(() => {
      engineFailed = true
      return null
    })
  return engineLoading
}

/** 文档里要上色的代码块（只看围栏名，不碰语言表：判断本身不该触发 100 KB 的下载） */
function highlightableBlocks(doc: PMNode): HighlightBlock[] {
  const out: HighlightBlock[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'code_block') return true
    const name = fenceLanguage(String(node.attrs.language ?? ''))
    if (name) out.push({ pos, code: node.textContent, name })
    return false
  })
  return out
}

const key = new PluginKey<DecorationSet>('kb-code-highlight')

function build(doc: PMNode): DecorationSet {
  // 引擎还没到：先不上色（代码块是纯文本）；引擎到位后会发 READY 事务重建
  if (!engine) return DecorationSet.empty
  const ranges = engine.highlightRanges(highlightableBlocks(doc))
  return DecorationSet.create(
    doc,
    ranges.map((range) => Decoration.inline(range.from, range.to, { class: range.classes })),
  )
}

/** 代码块语法高亮插件。装饰只在文档变化或引擎 / 语言包加载完时重建；其它事务保持原样（位置随文档变化时一定走 docChanged 分支） */
export function codeHighlightPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_config, state) => build(state.doc),
      apply: (tr, old, _before, after) => (tr.docChanged || tr.getMeta(READY) ? build(after.doc) : old),
    },
    props: {
      decorations: (state) => key.getState(state),
    },
    view(view) {
      const ready = () => {
        if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(READY, true))
      }
      // 引擎在等：期间文档再怎么变都只需要一次「到位后重建」
      let waiting = false
      // 语言包是异步加载的：文档里出现（或改成）一门还没加载的语言时去加载，完成后发 meta 事务让 apply 重建
      const request = (doc: PMNode) => {
        const blocks = highlightableBlocks(doc)
        if (blocks.length === 0) return
        if (engine) {
          engine.loadMissingLanguages(
            blocks.map((block) => block.name),
            ready,
          )
          return
        }
        if (waiting) return
        waiting = true
        void loadEngine().then((loaded) => {
          waiting = false
          if (!loaded || view.isDestroyed) return
          // 引擎刚到位：先按已缓存的语言重建一次，再去加载还缺的（期间文档可能又变了，取最新的）
          ready()
          loaded.loadMissingLanguages(
            highlightableBlocks(view.state.doc).map((block) => block.name),
            ready,
          )
        })
      }
      request(view.state.doc)
      return {
        update(next, prevState) {
          if (next.state.doc !== prevState.doc) request(next.state.doc)
        },
      }
    },
  })
}

/** 引擎的加载状态（idle = 没人要过，说明没有需要上色的代码块） */
export function highlightEngineState(): 'idle' | 'loading' | 'ready' | 'failed' {
  if (engine) return 'ready'
  if (engineFailed) return 'failed'
  return engineLoading ? 'loading' : 'idle'
}

/** 仅供测试：忘掉已加载的引擎，让下一个带语言的代码块重新走一遍「按需加载」 */
export function resetHighlightEngine(): void {
  engine = null
  engineLoading = null
  engineFailed = false
}
