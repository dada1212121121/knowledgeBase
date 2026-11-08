// 转写块 → SRT 字幕(「可导出 .srt」)。
//
// **只导出可信的逐段时间戳**。真实的 `MediaExtractor` 在没做转写时给出的是占位锚点:
//   - 已转写:一个整篇的块,锚点 `Time { 0, 60000 }`(占位,不是真实时长);
//   - 未转写:一个提示段落,锚点 `Time { 0, 0 }`。
// 这两种都不是字幕,导出出去就是「格式合法、内容错」的文件,所以直接判为不可导出。
// 段与段之间缺 `end_ms` 时用下一段的开始时间兜底(这是唯一允许的推测);最后一段没有结束时间就不导出。
export interface SrtBlock {
  text: string
  anchor: { kind: string; start_ms?: number; end_ms?: number } | null
}

/**
 * 抽取器的占位锚点:`0–0` 的提示块,或 `0–60000` 的整篇块。
 * 缺 `end_ms` 的不算占位(交给导出时兜底)。
 *
 * 已知限制:真实转写里若**只有一段**且恰好是 `0–60000`,也会被当占位而不导出。
 * 彻底的做法是让后端在块上带 `time_precise`,本轮先按值判断。
 */
export function isPlaceholderAnchor(anchor: SrtBlock['anchor'], soleTimedBlock = true): boolean {
  if (anchor?.kind !== 'time') return true
  if (anchor.end_ms === undefined || anchor.end_ms === null) return false
  const start = Math.max(0, Math.round(anchor.start_ms ?? 0))
  const end = Math.max(0, Math.round(anchor.end_ms))
  if (end <= start) return true
  // 有多段时,`0–60000` 就是普通的第一分钟(不再当占位)
  return soleTimedBlock && start === 0 && end === 60_000
}

/** 毫秒 → `HH:MM:SS,mmm`(SRT 的时间戳,逗号是规范要求)。 */
export function srtStamp(ms: number): string {
  const safe = Math.max(0, Math.round(ms))
  const hours = Math.floor(safe / 3_600_000)
  const minutes = Math.floor((safe % 3_600_000) / 60_000)
  const seconds = Math.floor((safe % 60_000) / 1000)
  const millis = safe % 1000
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`
}

/** cue 文本:SRT 用空行分隔条目,正文里的空行会把一条字幕截成两条,折叠成单换行。 */
function cueText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
}

/**
 * 把转写块拼成 SRT。
 * 返回空串表示「这份文件没有可信的逐段时间戳」,调用方据此隐藏导出按钮。
 */
export function toSrt(blocks: SrtBlock[]): string {
  const timeBlocks = blocks.filter((block) => block.anchor?.kind === 'time' && cueText(block.text))
  const timed = timeBlocks
    .filter((block) => !isPlaceholderAnchor(block.anchor, timeBlocks.length === 1))
    .sort((left, right) => (left.anchor?.start_ms ?? 0) - (right.anchor?.start_ms ?? 0))
  const cues = timed
    .map((block, index) => {
      const start = Math.max(0, Math.round(block.anchor?.start_ms ?? 0))
      const end = Math.max(0, Math.round(block.anchor?.end_ms ?? timed[index + 1]?.anchor?.start_ms ?? 0))
      if (end <= start) return null
      return { start, end, text: cueText(block.text) }
    })
    .filter((cue): cue is { start: number; end: number; text: string } => cue !== null)
  return cues
    .map((cue, index) => `${index + 1}\n${srtStamp(cue.start)} --> ${srtStamp(cue.end)}\n${cue.text}\n`)
    .join('\n')
}
