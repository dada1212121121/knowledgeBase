import DOMPurify from 'dompurify'

/** 不可信 Markdown 渲染后的 HTML。交给 DOMPurify,不手写协议黑名单。 */
export function sanitizeMarkdownHtml(html: string): string {
  if (!html) return ''
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'math', 'svg', 'noscript'],
    // DOMPurify 默认只放行 http(s) / mailto 等协议,会把 `kb://` 连同 href 一起丢掉。
    // 在默认白名单后补上 kb,其余危险协议(javascript: / vbscript:)仍然被挡住。
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|kb):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  })
}

/**
 * 外来文档(网页 / 邮件 / EPUB / ODT / RTF 转出来的 HTML)进入主 DOM 前的清洗。
 * 比 `sanitizeMarkdownHtml` 更严:去掉 style 属性(防止 position:fixed 之类盖住界面)、class / id(防止撞上应用样式)、
 * 表单 / 框架 / 样式 / 链接外部资源的标签;链接只留 http(s) / mailto / 文内锚点,并强制新窗口 + noopener。
 * 图片只允许 data: URL(CSP 本来也只放行 data:)。
 */
export function sanitizeDocHtml(html: string): string {
  if (!html) return ''
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'math', 'svg', 'noscript', 'link', 'meta', 'base', 'video', 'audio', 'source', 'canvas'],
    FORBID_ATTR: ['style', 'class', 'id', 'name', 'srcset', 'ping', 'formaction', 'background'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|data:image\/(?:png|jpe?g|gif|webp|bmp);base64,|#)/i,
    RETURN_DOM_FRAGMENT: false,
  })
  const template = document.createElement('template')
  template.innerHTML = clean
  for (const anchor of template.content.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href') ?? ''
    if (!href.startsWith('#')) {
      anchor.setAttribute('target', '_blank')
      anchor.setAttribute('rel', 'noopener noreferrer nofollow')
    }
  }
  for (const image of template.content.querySelectorAll('img')) {
    const src = image.getAttribute('src') ?? ''
    if (!src.startsWith('data:image/')) {
      // 外链图片在 CSP 下本来也加载不了:换成可见的占位文字,别留一个裂图
      const note = document.createElement('span')
      note.textContent = `[图片${image.getAttribute('alt') ? `：${image.getAttribute('alt')}` : ''}]`
      image.replaceWith(note)
    }
  }
  return template.innerHTML
}
