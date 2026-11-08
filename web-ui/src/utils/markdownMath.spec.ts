// 公式识别规则:只负责把 `$...$` / `$$...$$` 变成占位节点,渲染交给动态加载的 katex。
import { describe, expect, it } from 'vitest'
import MarkdownIt from 'markdown-it'
import { mathPlugin } from './markdownMath'

function makeMd(): MarkdownIt {
  const md = new MarkdownIt({ html: false })
  md.use(mathPlugin)
  return md
}

describe('mathPlugin', () => {
  it('行内公式变成 span 占位,TeX 写在 data-tex 里', () => {
    const html = makeMd().render('质能方程 $E=mc^2$ 就是它')
    expect(html).toContain('<span class="kb-math" data-tex="E=mc^2">E=mc^2</span>')
    expect(html).toContain('就是它')
  })

  it('块级公式变成 div,支持跨行与单行两种写法', () => {
    const multi = makeMd().render('$$\n\\int_0^1 x^2 dx\n$$')
    expect(multi).toContain('class="kb-math is-block"')
    expect(multi).toContain('data-tex="\\int_0^1 x^2 dx"')
    const single = makeMd().render('$$a+b$$')
    expect(single).toContain('class="kb-math is-block"')
    expect(single).toContain('data-tex="a+b"')
  })

  it('TeX 里的尖括号 / 引号被转义,不会变成标签', () => {
    const html = makeMd().render('$a<b"c"$')
    expect(html).toContain('data-tex="a&lt;b&quot;c&quot;"')
    expect(html).not.toContain('<b')
  })

  it('代码块 / 行内代码里的 $ 不算公式', () => {
    const md = makeMd()
    expect(md.render('```sh\necho $HOME\n```')).not.toContain('kb-math')
    expect(md.render('`$HOME` 是环境变量')).not.toContain('kb-math')
  })

  it('没配对的 $、转义的 \\$、空的 $$ 都按原文输出', () => {
    const md = makeMd()
    expect(md.render('价格 $5 到 $9')).toContain('<p>价格 $5 到 $9</p>')
    expect(md.render('\\$HOME 不是公式')).toContain('$HOME')
    expect(md.render('$$\n$$')).not.toContain('kb-math')
  })

  it('`$$` 没闭合时交回段落,不把后面整篇吞掉', () => {
    const html = makeMd().render('$$\n公式\n\n后面的段落')
    expect(html).not.toContain('kb-math')
    expect(html).toContain('后面的段落')
  })

  it('公式里允许出现转义的美元符号', () => {
    const html = makeMd().render('$\\$100$')
    expect(html).toContain('data-tex="\\$100"')
  })
})
