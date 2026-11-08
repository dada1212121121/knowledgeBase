// Office 包逐部件比较（Node 版）——与 crates/kb-extract/src/office_check.rs 的 `compare` 保持同一规则。
//
// 为什么在 e2e 里再实现一份：服务端 `roundtrip-check` 需要库里有这份文件和守护进程，e2e 用本地夹具不起守护进程。
// 18 份真实文档的"无损"结论必须用同一把尺子量，否则量出来的数字没有意义。规则（见 Rust 源码）：
//   - 字节完全相同 → 没变；
//   - .xml / .rels 比"结构指纹"：忽略 XML 声明、注释、标签间空白、属性顺序，`<a></a>` 与 `<a/>` 一样；
//   - docProps/core.xml 里的 modified / lastModifiedBy / revision 每次保存都会变，不算内容改写；
//   - 其它部件字节不同就算变；旧有新无 = removed，旧无新有 = added。
// 本文件用 `node e2e/office-compare.mjs` 直接运行自检（合成包，覆盖 Rust 单测里的情形）。
import JSZip from 'jszip'
import { SaxesParser } from 'saxes'

const VOLATILE_CORE = new Set(['modified', 'lastModifiedBy', 'revision'])

const localName = (name) => name.slice(name.indexOf(':') + 1)

/** XML 结构指纹；解析失败返回 null（和 Rust 一样，当作"不能证明相同"） */
export function canonicalXml(text, ignore = new Set()) {
  const out = []
  let skipping = 0
  let pending = ''
  let failed = false
  const flushText = () => {
    if (pending && skipping === 0 && pending.trim() !== '') out.push(`#${pending}`)
    pending = ''
  }
  const parser = new SaxesParser({ xmlns: false })
  parser.on('error', () => {
    failed = true
  })
  parser.on('opentag', (tag) => {
    flushText()
    if (skipping > 0 || ignore.has(localName(tag.name))) {
      skipping += 1
      return
    }
    const attributes = Object.entries(tag.attributes)
      .map(([key, value]) => `${key}=${value}`)
      .sort()
    out.push(`<${tag.name} ${attributes.join(' ')}>`)
    if (tag.isSelfClosing) out.push('</>')
  })
  parser.on('closetag', (tag) => {
    flushText()
    if (tag.isSelfClosing) {
      // 自闭合标签：opentag 已经入栈了成对的结束；跳过状态下要把 skipping 配平
      if (skipping > 0) skipping -= 1
      return
    }
    if (skipping > 0) skipping -= 1
    else out.push('</>')
  })
  parser.on('text', (value) => {
    pending += value
  })
  parser.on('cdata', (value) => {
    pending += value
  })
  try {
    parser.write(text).close()
  } catch {
    return null
  }
  flushText()
  return failed ? null : out
}

async function readParts(bytes) {
  const zip = await JSZip.loadAsync(bytes)
  const parts = new Map()
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) parts.set(name, await entry.async('uint8array'))
  }
  return parts
}

const equalBytes = (left, right) => left.length === right.length && left.every((byte, index) => byte === right[index])

/** @returns {{changed: string[], removed: string[], added: string[]}} */
export async function comparePackages(oldBytes, newBytes) {
  const oldParts = await readParts(oldBytes)
  const newParts = await readParts(newBytes)
  const diff = { changed: [], removed: [], added: [] }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (const [name, data] of [...oldParts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const other = newParts.get(name)
    if (!other) {
      diff.removed.push(name)
      continue
    }
    if (equalBytes(data, other)) continue
    const isXml = name.endsWith('.xml') || name.endsWith('.rels')
    let same = false
    if (isXml) {
      try {
        const ignore = name === 'docProps/core.xml' ? VOLATILE_CORE : new Set()
        const left = canonicalXml(decoder.decode(data), ignore)
        const right = canonicalXml(decoder.decode(other), ignore)
        same = !!left && !!right && left.length === right.length && left.every((token, index) => token === right[index])
      } catch {
        same = false
      }
    }
    if (!same) diff.changed.push(name)
  }
  for (const name of [...newParts.keys()].sort()) if (!oldParts.has(name)) diff.added.push(name)
  return diff
}

/** document.xml 里所有 <w:t> 文字按顺序拼起来（粗略的"文字是否一致"，服务端用的是正式抽取器） */
export async function docxPlainText(bytes) {
  const zip = await JSZip.loadAsync(bytes)
  const xml = await zip.file('word/document.xml')?.async('string')
  if (!xml) return ''
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((match) => match[1]).join('')
}

/* ---------------- 自检 ---------------- */

async function pack(entries) {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(entries)) zip.file(name, content)
  return zip.generateAsync({ type: 'uint8array' })
}

export async function selfTest() {
  const failures = []
  const expect = (name, ok, detail = '') => {
    if (!ok) failures.push(`${name}${detail ? `：${detail}` : ''}`)
  }
  const DOC = '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>'
  const CORE = (modified, extra = '') =>
    `<cp:coreProperties xmlns:cp="c" xmlns:dcterms="d"><dcterms:modified>${modified}</dcterms:modified><cp:lastModifiedBy>甲</cp:lastModifiedBy><cp:revision>3</cp:revision>${extra}</cp:coreProperties>`
  const base = { 'word/document.xml': DOC, 'docProps/core.xml': CORE('2026-01-01'), 'word/media/a.png': 'PNG' }
  const baseBytes = await pack(base)

  const same = await comparePackages(baseBytes, await pack(base))
  expect('完全相同', !same.changed.length && !same.removed.length && !same.added.length)

  const whitespace = await comparePackages(
    baseBytes,
    await pack({ ...base, 'word/document.xml': '<?xml version="1.0"?>\n<!-- c -->\n<w:document xmlns:w="w">\n  <w:body>\n    <w:p><w:r><w:t>正文</w:t></w:r></w:p>\n  </w:body>\n</w:document>' }),
  )
  expect('声明 / 注释 / 标签间空白不算改写', !whitespace.changed.length, JSON.stringify(whitespace))

  const reorder = await comparePackages(
    await pack({ ...base, 'word/document.xml': '<w:p xmlns:w="w" a="1" b="2"><w:br/></w:p>' }),
    await pack({ ...base, 'word/document.xml': '<w:p b="2" xmlns:w="w" a="1"><w:br></w:br></w:p>' }),
  )
  expect('属性顺序与 <a/> / <a></a> 不算改写', !reorder.changed.length, JSON.stringify(reorder))

  const core = await comparePackages(baseBytes, await pack({ ...base, 'docProps/core.xml': CORE('2026-11-05') }))
  expect('core.xml 只有 modified 变不算改写', !core.changed.length, JSON.stringify(core))
  const coreAdded = await comparePackages(await pack({ ...base, 'docProps/core.xml': '<cp:coreProperties xmlns:cp="c" xmlns:dcterms="d"/>' }), await pack({ ...base, 'docProps/core.xml': CORE('2026-11-05') }))
  expect('第一次保存多出 modified / revision 不算改写', !coreAdded.changed.length, JSON.stringify(coreAdded))
  const coreTitle = await comparePackages(baseBytes, await pack({ ...base, 'docProps/core.xml': CORE('2026-01-01', '<dc:title xmlns:dc="t">新标题</dc:title>') }))
  expect('core.xml 里标题变了算改写', coreTitle.changed.join() === 'docProps/core.xml', JSON.stringify(coreTitle))

  const text = await comparePackages(baseBytes, await pack({ ...base, 'word/document.xml': DOC.replace('正文', '正文改') }))
  expect('正文变了算改写', text.changed.join() === 'word/document.xml', JSON.stringify(text))

  const binary = await comparePackages(baseBytes, await pack({ ...base, 'word/media/a.png': 'PNG2' }))
  expect('二进制部件字节不同算改写', binary.changed.join() === 'word/media/a.png', JSON.stringify(binary))

  const removed = { ...base }
  delete removed['word/media/a.png']
  const lost = await comparePackages(baseBytes, await pack(removed))
  expect('丢了部件算 removed', lost.removed.join() === 'word/media/a.png', JSON.stringify(lost))
  const gained = await comparePackages(await pack(removed), baseBytes)
  expect('多了部件算 added', gained.added.join() === 'word/media/a.png', JSON.stringify(gained))

  const broken = await comparePackages(baseBytes, await pack({ ...base, 'word/document.xml': '<w:document><w:body></w:document>' }))
  expect('新文件 XML 不合法算改写', broken.changed.join() === 'word/document.xml', JSON.stringify(broken))

  expect('docxPlainText', (await docxPlainText(baseBytes)) === '正文')
  return failures
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '') && process.argv.includes('--self-test')) {
  const failures = await selfTest()
  if (failures.length) {
    console.error(`✗ office-compare 自检未通过\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('✓ office-compare 自检通过')
}
