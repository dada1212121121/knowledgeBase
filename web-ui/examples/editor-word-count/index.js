// 字数统计:编辑器扩展示例。纯 ES 模块,不依赖任何构建,直接复制到扩展目录就能用。
//
// 演示三件事:
//   1. 命令(registerCommand)+ 工具栏按钮(registerToolbarItem):点按钮弹出一条提示;
//   2. 面板(registerPanel):用原生 DOM 画,订阅 document.onChange 随输入实时更新,关闭面板时清理订阅;
//   3. 权限:清单只申请了 document.read 和 ui,所以这里只读文档,不会(也不能)改它。

// 汉字 / 假名 / 谚文各算一个「字」;英文词按连续的字母数字(含词内的撇号、连字符)算
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
const WORD = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g

/** 统计一段文字。按原文计,Markdown 的标记符号不算字。 */
export function countText(text) {
  const source = String(text ?? '')
  return {
    cjk: (source.match(CJK) ?? []).length,
    words: (source.match(WORD) ?? []).length,
    // 空行分隔的非空块算一段
    paragraphs: source.split(/\r?\n\s*\r?\n/).filter((block) => block.trim().length > 0).length,
    chars: source.replace(/\s/g, '').length,
  }
}

function summary(stats) {
  return `汉字 ${stats.cjk} · 英文 ${stats.words} 词 · ${stats.paragraphs} 段`
}

export default {
  activate(ctx) {
    // 点工具栏按钮 → 执行命令 → 用提示告诉用户结果
    ctx.registerCommand('kb.word-count.show', async (_args, api) => {
      const doc = await api.document.read()
      const all = countText(doc.text)
      const picked = doc.selection ? `;选中:${summary(countText(doc.selection))}` : ''
      api.notify(`全文:${summary(all)}${picked}`)
    })

    ctx.registerToolbarItem({
      id: 'kb.word-count.button',
      label: '字数统计',
      icon: 'Σ',
      command: 'kb.word-count.show',
    })

    ctx.registerPanel({
      id: 'kb.word-count.panel',
      title: '字数统计',
      icon: 'Σ',
      mount(el, api) {
        const rows = [
          ['cjk', '汉字'],
          ['words', '英文词'],
          ['paragraphs', '段落'],
          ['chars', '字符(不含空白)'],
        ]
        const list = document.createElement('dl')
        list.style.cssText = 'display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:0;'
        const cells = {}
        for (const [key, label] of rows) {
          const term = document.createElement('dt')
          term.textContent = label
          term.style.cssText = 'color:var(--m)'
          const value = document.createElement('dd')
          value.style.cssText = 'margin:0;font-variant-numeric:tabular-nums'
          value.dataset.testid = `wc-${key}`
          value.textContent = '—'
          list.append(term, value)
          cells[key] = value
        }
        el.append(list)

        // 连续输入时 read() 可能乱序返回:只认最后一次发起的那个
        let latest = 0
        async function refresh() {
          const ticket = ++latest
          let stats = null
          try {
            stats = countText((await api.document.read()).text)
          } catch {
            // 没有打开的文档:显示占位,不报错
          }
          if (ticket !== latest) return
          for (const [key] of rows) cells[key].textContent = stats ? String(stats[key]) : '—'
        }

        const subscription = api.document.onChange(refresh)
        void refresh()
        return () => {
          latest += 1
          subscription.dispose()
          el.replaceChildren()
        }
      },
    })
  },
}
