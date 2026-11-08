// jsdom 没有布局:CodeMirror 量坐标时会调 Range.getClientRects / getBoundingClientRect。
// 给个空实现就够跑「文档内容 / 命令 / 事件」这类断言(不验证像素,像素交给 e2e 截图)。
const emptyRects = Object.assign([] as unknown as DOMRectList, { item: () => null })
if (typeof Range !== 'undefined') {
  Range.prototype.getClientRects ??= () => emptyRects
  Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 0, 0)
}
if (typeof document !== 'undefined') {
  document.elementFromPoint ??= () => null
}
