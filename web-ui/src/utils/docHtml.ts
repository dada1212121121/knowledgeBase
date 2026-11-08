// 把各格式的解析结果拼成阅读视图要的 HTML(未清洗,调用方过 sanitizeDocHtml)。纯函数。
import type { DocBlock, PptSlide } from './legacyOffice'
import type { Mail } from './mail'
import { humanSize } from './hexdump'

const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const lines = (value: string) => esc(value).replace(/\n/g, '<br>')

export function blocksToHtml(blocks: DocBlock[]): string {
  return blocks
    .map((block) =>
      block.kind === 'p'
        ? block.text.trim()
          ? `<p>${lines(block.text)}</p>`
          : ''
        : `<table>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${lines(cell)}</td>`).join('')}</tr>`).join('')}</table>`,
    )
    .join('\n')
}

export interface Section {
  title: string
  html: string
}

export function pptSlidesToSections(slides: PptSlide[]): Section[] {
  return slides.map((slide, index) => {
    const body = slide.body.map((item) => `<p>${lines(item)}</p>`).join('')
    const notes = slide.notes.length ? `<hr><blockquote><p><b>演讲者备注</b></p>${slide.notes.map((item) => `<p>${lines(item)}</p>`).join('')}</blockquote>` : ''
    return { title: slide.title || `第 ${index + 1} 张`, html: `<h2>${esc(slide.title || `第 ${index + 1} 张`)}</h2>${body}${notes}` }
  })
}

/** 邮件:头信息、正文(HTML 优先,否则纯文本分段)、附件清单。 */
export function mailToHtml(mail: Mail): string {
  const row = (label: string, value: string) => (value ? `<p><b>${label}</b>　${esc(value)}</p>` : '')
  const head = `<h2>${esc(mail.subject || '(无主题)')}</h2>${row('发件人', mail.from)}${row('收件人', mail.to)}${row('抄送', mail.cc)}${row('时间', mail.date)}<hr>`
  const body = mail.html
    ? mail.html
    : mail.text
        .split(/\r?\n\r?\n+/)
        .map((paragraph) => (paragraph.trim() ? `<p>${lines(paragraph.replace(/\r/g, ''))}</p>` : ''))
        .join('')
  const attachments = mail.attachments.length
    ? `<hr><p><b>附件（${mail.attachments.length}）</b></p><ul>${mail.attachments.map((item) => `<li>${esc(item.name)}${item.size ? `（${humanSize(item.size)}）` : ''}</li>`).join('')}</ul>`
    : ''
  return head + (body || '<p>（邮件没有正文）</p>') + attachments
}
