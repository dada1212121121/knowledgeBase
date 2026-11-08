// 待办清单格式:编辑器扩展示例。纯 ES 模块,不依赖任何构建,直接复制到扩展目录就能用。
//
// 演示「注册一种新格式」:
//   1. Codec(registerCodec):磁盘上的 .kbtodo 是 JSON,编辑器里看到的是清单文本,保存时再翻译回 JSON;
//   2. 内容面(registerSurface):把清单画成可勾选的列表,改动通过 onDirtyChange / 快照提供者交回宿主;
//   3. 权限:Codec 需要 document.read + document.write(写回要用户确认),内容面需要 ui + document.read。
//
// 磁盘格式(JSON,两个空格缩进,结尾有换行):
//   { "title": "周五发布", "items": [ { "text": "冻结版本", "done": true }, { "text": "写发布说明", "done": false } ] }
// 编辑器里的清单文本:
//   # 周五发布
//   [x] 冻结版本
//   [ ] 写发布说明

const ITEM = /^\[( |x|X)\] ?(.*)$/

/** 磁盘上的 JSON 文本 → { title, items }。形状不对就抛错:打不开比悄悄丢数据好 */
export function parseTodoJson(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new Error(`不是合法的 .kbtodo(JSON 解析失败:${error.message})`)
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) throw new Error('不是合法的 .kbtodo:缺少 items 数组')
  const items = data.items.map((item, index) => {
    if (!item || typeof item.text !== 'string' || typeof item.done !== 'boolean') throw new Error(`第 ${index + 1} 项不是 { "text": 文字, "done": 布尔 }`)
    // 清单里一项占一行:带换行的文字放不进去,拒绝比悄悄压成一行(改写了内容)更安全
    if (/[\r\n]/.test(item.text)) throw new Error(`第 ${index + 1} 项的文字里有换行,清单视图放不下`)
    return { text: item.text, done: item.done }
  })
  return { title: typeof data.title === 'string' ? data.title : '', items }
}

/** { title, items } → 清单文本 */
export function toChecklist(model) {
  const lines = []
  if (model.title) lines.push(`# ${model.title}`)
  for (const item of model.items) lines.push(`[${item.done ? 'x' : ' '}] ${item.text}`)
  return lines.join('\n')
}

/** 清单文本 → { title, items }。认不出的行直接报错并指出行号,保存时不丢也不猜 */
export function fromChecklist(text) {
  const model = { title: '', items: [] }
  String(text ?? '')
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (line.trim() === '') return
      const item = ITEM.exec(line)
      if (item) return void model.items.push({ text: item[2], done: item[1] !== ' ' })
      if (index === 0 && line.startsWith('# ')) return void (model.title = line.slice(2))
      throw new Error(`第 ${index + 1} 行不是待办项(应写成 "[ ] 文字" 或 "[x] 文字"):${line}`)
    })
  return model
}

/** 规范的磁盘格式:改过的和没改的文件写出来的字节一致 */
export function toTodoJson(model) {
  return `${JSON.stringify({ title: model.title, items: model.items }, null, 2)}\n`
}

function createSurface() {
  let root = null
  let ctx = null
  let model = { title: '', items: [] }
  let initial = ''
  let readonly = true
  let name = 'todo.kbtodo'

  const current = () => toChecklist(model)
  const touch = () => {
    ctx?.onDirtyChange?.(current() !== initial)
    ctx?.onContentChange?.()
  }

  function render() {
    if (!root) return
    root.replaceChildren()
    const title = document.createElement('input')
    title.type = 'text'
    title.value = model.title
    title.placeholder = '清单标题'
    title.disabled = readonly
    title.dataset.testid = 'todo-title'
    title.setAttribute('aria-label', '清单标题')
    title.style.cssText = 'font:inherit;font-weight:600;font-size:1.15em;border:0;border-bottom:1px solid var(--b);background:transparent;color:inherit;padding:4px 0;margin-bottom:12px'
    title.addEventListener('input', () => {
      model.title = title.value
      touch()
    })
    const list = document.createElement('ul')
    list.style.cssText = 'list-style:none;margin:0;padding:0;display:grid;gap:6px'
    model.items.forEach((item, index) => {
      const row = document.createElement('li')
      row.style.cssText = 'display:flex;align-items:center;gap:8px'
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = item.done
      box.disabled = readonly
      box.dataset.testid = 'todo-done'
      box.setAttribute('aria-label', `完成:${item.text || `第 ${index + 1} 项`}`)
      box.addEventListener('change', () => {
        item.done = box.checked
        text.style.textDecoration = item.done ? 'line-through' : ''
        touch()
      })
      const text = document.createElement('input')
      text.type = 'text'
      text.value = item.text
      text.disabled = readonly
      text.dataset.testid = 'todo-text'
      text.setAttribute('aria-label', `第 ${index + 1} 项的文字`)
      text.style.cssText = `flex:1;font:inherit;border:0;background:transparent;color:inherit;padding:2px 4px;${item.done ? 'text-decoration:line-through;' : ''}`
      text.addEventListener('input', () => {
        item.text = text.value.replace(/[\r\n]+/g, ' ')
        touch()
      })
      row.append(box, text)
      if (!readonly) {
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.textContent = '×'
        remove.dataset.testid = 'todo-remove'
        remove.setAttribute('aria-label', `删除第 ${index + 1} 项`)
        remove.addEventListener('click', () => {
          model.items.splice(index, 1)
          render()
          touch()
        })
        row.append(remove)
      }
      list.append(row)
    })
    root.append(title, list)
    if (!readonly) {
      const add = document.createElement('button')
      add.type = 'button'
      add.textContent = '添加一项'
      add.dataset.testid = 'todo-add'
      add.style.cssText = 'margin-top:12px'
      add.addEventListener('click', () => {
        model.items.push({ text: '', done: false })
        render()
        touch()
        root.querySelectorAll('[data-testid="todo-text"]')[model.items.length - 1]?.focus()
      })
      root.append(add)
    }
  }

  return {
    async mount(el, surfaceCtx) {
      ctx = surfaceCtx
      const payload = surfaceCtx.document.payload
      name = payload.name || name
      // 有 Codec 时拿到的是解码后的清单文本;没有 Codec(只装了内容面)时是文件原文,这里不认,让宿主显示错误
      const text = payload.kind === 'text' ? payload.text : new TextDecoder().decode(payload.bytes)
      model = fromChecklist(text)
      initial = current()
      readonly = surfaceCtx.readonly
      root = document.createElement('div')
      root.dataset.testid = 'todo-surface'
      root.style.cssText = 'display:flex;flex-direction:column;padding:16px 20px;max-width:640px'
      root.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          ctx.onSaveRequest?.()
        }
      })
      el.append(root)
      render()
      // 保存时宿主向这里要「当前内容」,再交给 Codec 编码
      surfaceCtx.session.setSnapshotProvider?.(() => ({ kind: 'text', text: current(), name }))
      ctx.onDirtyChange?.(false)
    },
    unmount() {
      ctx?.session.setSnapshotProvider?.(null)
      root?.remove()
      root = null
      ctx = null
    },
    resize() {},
    focus() {
      root?.querySelector('input:not([disabled])')?.focus()
    },
    setReadonly(value) {
      readonly = value
      render()
    },
    async command() {
      return { ok: false, reason: 'readonly_surface' }
    },
    async query(query) {
      if (query.type === 'text') return current()
      if (query.type === 'wordCount') return { words: model.items.length, unitLabel: '项' }
      return null
    },
    capture() {
      return { kind: 'ext:kb.todo-format.surface' }
    },
    restore() {},
  }
}

export default {
  activate(ctx) {
    ctx.registerCodec({
      id: 'kb.todo-format.codec',
      surface: 'ext:kb.todo-format.surface',
      decode: (bytes, { name }) => ({ kind: 'text', text: toChecklist(parseTodoJson(new TextDecoder().decode(bytes))), name }),
      encode: (source) => new TextEncoder().encode(toTodoJson(fromChecklist(source.kind === 'text' ? source.text : new TextDecoder().decode(source.bytes)))),
    })
    ctx.registerSurface({ id: 'kb.todo-format.surface', create: createSurface })
  },
}
