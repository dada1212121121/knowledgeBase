/**
 * Text Surface 的 ProseMirror schema（与旧编辑器的协同房间格式兼容）
 *
 * 为什么节点 / 标记名要和旧编辑器（Milkdown / Crepe）一模一样：
 * 笔记的多人编辑房间存的是 y-prosemirror 的 `Y.XmlFragment`，元素名就是 ProseMirror 的节点名、
 * 文字属性就是标记名，服务端快照里已经存了大量这种结构。y-prosemirror 遇到本地 schema 不认识的
 * 节点 / 标记时，会把那个元素**从共享文档里删掉**，删除再同步给房间里的所有人——
 * 新旧两种客户端只要有一个名字对不上，就会互相删别人的内容。所以：
 * 1. 旧编辑器有的每个节点 / 标记，这里都有，必填 attrs 都有默认值（y-prosemirror 建节点缺 attrs 会抛错 → 删除）；
 * 2. 这里能产生的每个节点 / 标记，旧编辑器也都认识（不再有 `html_block` / `raw_html` 这类自有名字）；
 * 3. content 规则只能比旧编辑器宽，不能更严（例如列表项允许以非段落开头）。
 * 契约由 `roomSchema.spec.ts` 对照真实浏览器导出的旧编辑器 schema 快照守住。
 *
 * 表格与序列化契约仍按 utils/milkdownConfig.ts：`-` 列表、两空格硬换行、紧凑表格。
 */
import { Schema, type DOMOutputSpec, type MarkSpec, type NodeSpec } from 'prosemirror-model'
import { colorHex, isHexColor, type ColorProp } from '@/utils/colorPalette'

/** 表格列对齐；null 表示未显式声明（旧编辑器同样用 null 表示 `---`） */
export type TableAlignment = 'left' | 'center' | 'right' | null

/** 表格单元格公共属性：与旧编辑器 GFM 表格一致，colspan / rowspan / colwidth 只为兼容，不参与序列化 */
const cellAttrs = {
  colspan: { default: 1 },
  rowspan: { default: 1 },
  colwidth: { default: null },
  alignment: { default: null as TableAlignment },
}

const cellDOM = (tag: 'th' | 'td') => (node: { attrs: Record<string, unknown> }): DOMOutputSpec => [
  tag,
  node.attrs.alignment ? { style: `text-align: ${String(node.attrs.alignment)}` } : {},
  0,
]

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },

  // 段落：唯一允许空内容的块，序列化成空行。块级原样 HTML 也落在段落里（段落只含一个 html 节点），与旧编辑器一致
  paragraph: {
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'p' }],
    toDOM: (): DOMOutputSpec => ['p', 0],
  },

  // 标题 1~6；id 是旧编辑器算的锚点 slug，这里只保留不使用
  heading: {
    attrs: { id: { default: '' }, level: { default: 1 } },
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
    toDOM: (node): DOMOutputSpec => [`h${node.attrs.level}`, 0],
  },

  blockquote: {
    content: 'block+',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM: (): DOMOutputSpec => ['blockquote', 0],
  },

  // 围栏代码块；language 保存 info string。块级公式（`$$`）也是代码块：language = 'LaTeX'（与旧编辑器一致），
  // kbMath 记录原文是 `$$` 写法，保存时写回 `$$` 而不是改成 ```LaTeX 围栏（旧编辑器不认这个属性，会原样忽略）
  code_block: {
    attrs: { language: { default: '' }, kbMath: { default: false } },
    content: 'text*',
    group: 'block',
    marks: '',
    defining: true,
    code: true,
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
    toDOM: (node): DOMOutputSpec => ['pre', { 'data-language': node.attrs.language }, ['code', 0]],
  },

  // 分割线（旧编辑器叫 hr）
  hr: {
    group: 'block',
    parseDOM: [{ tag: 'hr' }],
    toDOM: (): DOMOutputSpec => ['hr'],
  },

  // 无序列表；任务列表复用它，靠 list_item.checked 区分
  bullet_list: {
    attrs: { spread: { default: false } },
    content: 'listItem+',
    group: 'block',
    parseDOM: [{ tag: 'ul' }],
    toDOM: (): DOMOutputSpec => ['ul', 0],
  },

  // 有序列表；order 是起始序号，保证 `3.` 开头的列表往返不变
  ordered_list: {
    attrs: { order: { default: 1 }, spread: { default: false } },
    content: 'listItem+',
    group: 'block',
    parseDOM: [
      {
        tag: 'ol',
        getAttrs: (dom) => {
          const start = (dom as HTMLElement).getAttribute('start')
          return { order: start ? Number(start) : 1 }
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => (node.attrs.order === 1 ? ['ol', 0] : ['ol', { start: node.attrs.order }, 0]),
  },

  // 列表项；checked 为 null 表示普通项，true/false 表示任务项。label / listType / spread 是旧编辑器的显示属性，只透传
  list_item: {
    attrs: {
      label: { default: '•' },
      listType: { default: 'bullet' },
      spread: { default: true },
      checked: { default: null },
    },
    // 比旧编辑器的 `paragraph block*` 宽：真实笔记里有以引用、代码块开头的列表项
    content: 'block+',
    group: 'listItem',
    defining: true,
    parseDOM: [
      {
        tag: 'li',
        getAttrs: (dom) => {
          const input = (dom as HTMLElement).querySelector?.('input[type="checkbox"]')
          return { checked: input ? (input as HTMLInputElement).checked : null }
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => {
      if (node.attrs.checked == null) return ['li', 0]
      // content hole 必须是父节点的唯一子节点，所以正文要包一层；复选框放在 li 直属位置，供 CSS 定位
      return [
        'li',
        { 'data-checked': String(node.attrs.checked) },
        [
          'input',
          {
            type: 'checkbox',
            checked: node.attrs.checked ? '' : null,
            // 复选框本身没有可见文字：用条目正文做可访问名称，读屏才能说出「哪件事已完成」
            'aria-label': node.textContent || '任务',
          },
        ],
        ['div', { class: 'kb-task-line' }, 0],
      ]
    },
  },

  // 行内图片；alt / title 缺省为空字符串（旧编辑器同样如此，空串与「没有」序列化结果相同）
  image: {
    inline: true,
    // width：用户拖拽调整后的显示宽度（px，null = 自动）。只存宽度，高度按原图比例算；落到 Markdown 里是地址的 #w= 片段（见 utils/imageSize.ts）
    attrs: { src: { default: '' }, alt: { default: '' }, title: { default: '' }, width: { default: null } },
    group: 'inline',
    draggable: true,
    marks: '',
    parseDOM: [
      {
        tag: 'img[src]',
        getAttrs: (dom) => ({
          src: (dom as HTMLElement).getAttribute('src') ?? '',
          alt: (dom as HTMLElement).getAttribute('alt') ?? '',
          title: (dom as HTMLElement).getAttribute('title') ?? '',
          width: Number((dom as HTMLElement).getAttribute('width')) || null,
        }),
      },
    ],
    // alt 为空字符串也要写出来：装饰图要让读屏跳过，缺属性则会被当成「图片无说明」
    // contenteditable=false：复制 / 拖出去的图片 DOM 也不带浏览器自己的缩放手柄；调整大小只走编辑器自己的手柄（imageNodeView）
    toDOM: (node): DOMOutputSpec => ['img', { src: node.attrs.src, alt: node.attrs.alt ?? '', title: node.attrs.title || null, width: node.attrs.width || null, contenteditable: 'false' }],
  },

  // 换行：isInline=false 是硬换行（行尾两空格），isInline=true 是段落内的软换行（源文里的普通换行）
  hardbreak: {
    inline: true,
    group: 'inline',
    attrs: { isInline: { default: false } },
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM: (node): DOMOutputSpec => ['br', node.attrs.isInline ? { 'data-soft': 'true' } : {}],
  },

  // 原样 HTML（行内 `<kbd>`、块级 `<details>` 都是它；块级时单独占一个段落）。只显示源码，绝不当 HTML 渲染
  html: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { value: { default: '' } },
    parseDOM: [{ tag: 'span[data-type="html"]', getAttrs: (dom) => ({ value: (dom as HTMLElement).dataset.value ?? '' }) }],
    toDOM: (node): DOMOutputSpec => [
      'span',
      { 'data-type': 'html', 'data-value': node.attrs.value, class: 'kb-text-html', contenteditable: 'false' },
      String(node.attrs.value),
    ],
  },

  // 表格：表头行 + 若干数据行（旧编辑器的 GFM 结构）
  table: {
    content: 'table_header_row table_row*',
    group: 'block',
    isolating: true,
    parseDOM: [{ tag: 'table' }],
    toDOM: (): DOMOutputSpec => ['table', ['tbody', 0]],
  },
  table_header_row: {
    content: '(table_header)*',
    // 粘贴 HTML 表格时：含 th 的行才是表头行
    parseDOM: [{ tag: 'tr', priority: 60, getAttrs: (dom) => ((dom as HTMLElement).querySelector('th') ? null : false) }],
    toDOM: (): DOMOutputSpec => ['tr', 0],
  },
  table_row: {
    content: '(table_cell)*',
    parseDOM: [{ tag: 'tr' }],
    toDOM: (): DOMOutputSpec => ['tr', 0],
  },
  table_header: {
    attrs: cellAttrs,
    // 旧编辑器是恰好一个段落；这里放宽到多个，编辑时回车不至于非法（序列化成 `<br>`）
    content: 'paragraph+',
    isolating: true,
    parseDOM: [{ tag: 'th' }],
    toDOM: cellDOM('th'),
  },
  table_cell: {
    attrs: cellAttrs,
    content: 'paragraph+',
    isolating: true,
    parseDOM: [{ tag: 'td' }],
    toDOM: cellDOM('td'),
  },

  // 脚注：`[^label]: 内容` 定义块与正文里的 `[^label]` 引用
  footnote_definition: {
    attrs: { label: { default: '' } },
    content: 'block+',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'div[data-type="footnote_definition"]', getAttrs: (dom) => ({ label: (dom as HTMLElement).dataset.label ?? '' }) }],
    toDOM: (node): DOMOutputSpec => [
      'div',
      { 'data-type': 'footnote_definition', 'data-label': node.attrs.label, class: 'kb-text-fn-def' },
      ['span', { class: 'kb-text-fn-label', contenteditable: 'false' }, `[^${String(node.attrs.label)}]:`],
      ['div', 0],
    ],
  },
  footnote_reference: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { label: { default: '' } },
    parseDOM: [{ tag: 'sup[data-type="footnote_reference"]', getAttrs: (dom) => ({ label: (dom as HTMLElement).dataset.label ?? '' }) }],
    toDOM: (node): DOMOutputSpec => [
      'sup',
      { 'data-type': 'footnote_reference', 'data-label': node.attrs.label, class: 'kb-text-fn-ref' },
      `[${String(node.attrs.label)}]`,
    ],
  },

  // 行内公式 `$...$`；只显示源码（阅读态 MarkdownRead 负责渲染）
  math_inline: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { value: { default: '' } },
    parseDOM: [{ tag: 'span[data-type="math_inline"]', getAttrs: (dom) => ({ value: (dom as HTMLElement).dataset.value ?? '' }) }],
    toDOM: (node): DOMOutputSpec => [
      'span',
      { 'data-type': 'math_inline', 'data-value': node.attrs.value, class: 'kb-text-math' },
      `$${String(node.attrs.value)}$`,
    ],
  },

  text: { group: 'inline' },
}

const marks: Record<string, MarkSpec> = {
  // marker 是旧编辑器记的原文标记字符（`*` / `_`），这里透传；保存时一律按契约写 `**`
  strong: {
    attrs: { marker: { default: '*' } },
    parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
    toDOM: (): DOMOutputSpec => ['strong', 0],
  },
  emphasis: {
    attrs: { marker: { default: '*' } },
    parseDOM: [{ tag: 'em' }, { tag: 'i' }],
    toDOM: (): DOMOutputSpec => ['em', 0],
  },
  strike_through: {
    parseDOM: [{ tag: 's' }, { tag: 'del' }],
    toDOM: (): DOMOutputSpec => ['s', 0],
  },
  // 行内代码：允许与 strong / emphasis 共存。若排斥其它标记，`**a \`b\` c**` 会被拆成两段 strong，语义就变了
  inlineCode: {
    parseDOM: [{ tag: 'code' }],
    toDOM: (): DOMOutputSpec => ['code', 0],
  },
  link: {
    attrs: { href: {}, title: { default: null } },
    inclusive: false,
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs: (dom) => ({ href: (dom as HTMLElement).getAttribute('href'), title: (dom as HTMLElement).getAttribute('title') }),
      },
    ],
    toDOM: (mark): DOMOutputSpec => ['a', { href: mark.attrs.href, title: mark.attrs.title }, 0],
  },
  // 调色板里的字色 / 底色 / 字体（`<span style="color: #e5484d">`、`<span style="font-family: …">`，见 utils/colorPalette.ts）；
  // 自定义色把 6 位 hex 直接存进 key，用内联 style 渲染；不同 prop 可叠加
  kb_color: {
    attrs: { prop: { default: 'color' }, key: { default: 'red' } },
    excludes: '',
    parseDOM: [
      {
        tag: 'span[data-kb-color]',
        getAttrs: (dom) => ({ prop: (dom as HTMLElement).dataset.prop ?? 'color', key: (dom as HTMLElement).dataset.kbColor ?? 'red' }),
      },
    ],
    toDOM: (mark): DOMOutputSpec => {
      const prop = String(mark.attrs.prop) as ColorProp
      const key = String(mark.attrs.key)
      // 只有颜色 prop 才接受自定义 hex；字体仍只认表里的 key，避免把 hex 写进 font-family
      const custom = prop !== 'font-family' && isHexColor(key)
      return [
        'span',
        {
          'data-kb-color': key,
          'data-prop': prop,
          // 自定义色不能写 class（hex 里的 # 不是合法类名），保留 kb-color 供选中 / 测试钩子使用
          class: custom ? 'kb-color is-custom' : `kb-color is-${prop === 'color' ? 'fg' : prop === 'font-family' ? 'font' : 'bg'}-${key}`,
          ...(custom ? { style: `${prop}: ${colorHex(prop, key)}` } : {}),
        },
        0,
      ]
    },
  },
}

/** 笔记编辑器 schema（全站唯一实例） */
export const textSchema = new Schema({ nodes, marks })

/** 序列化时标记的开启顺序：外层先开，内层后开 */
export const MARK_ORDER = ['link', 'kb_color', 'strong', 'emphasis', 'strike_through', 'inlineCode'] as const
