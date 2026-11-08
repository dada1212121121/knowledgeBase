// 波形计算(设计稿 音视频预览里的波形条)。
//
// 从解码后的音频采样算出「每个桶的峰值」,再归一化到 0..1 给 SVG 画柱状图。
// 抽成纯函数是因为解码要浏览器 API,而分桶逻辑最容易出错(空数组、桶比样本多、静音)。

/** 把一路采样(通常 -1..1)分成 `buckets` 个桶,取每桶峰值的绝对值。 */
export function computePeaks(samples: Float32Array, buckets: number): number[] {
  const count = Math.max(1, Math.floor(buckets))
  if (samples.length === 0) return new Array(count).fill(0)
  const size = samples.length / count
  const peaks: number[] = []
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor(index * size)
    const end = Math.max(start + 1, Math.floor((index + 1) * size))
    let peak = 0
    for (let at = start; at < end && at < samples.length; at += 1) {
      const value = Math.abs(samples[at])
      if (value > peak) peak = value
    }
    peaks.push(peak)
  }
  return peaks
}

/** 多声道取每个桶的最大值(左右声道合成一条波形)。 */
export function mergeChannels(channels: Float32Array[], buckets: number): number[] {
  if (channels.length === 0) return new Array(Math.max(1, Math.floor(buckets))).fill(0)
  const merged = computePeaks(channels[0], buckets)
  for (const channel of channels.slice(1)) {
    const peaks = computePeaks(channel, buckets)
    for (let index = 0; index < merged.length; index += 1) {
      if (peaks[index] > merged[index]) merged[index] = peaks[index]
    }
  }
  return merged
}

/** 归一化到 0..1;全静音(峰值 0)时返回全 0,不把噪声放大成满格。 */
export function normalizePeaks(peaks: number[]): number[] {
  const max = peaks.reduce((best, value) => (value > best ? value : best), 0)
  if (max <= 0) return peaks.map(() => 0)
  return peaks.map((value) => Math.min(1, value / max))
}

/** 时间轴刻度:0:00 / 1:30 这类短文案。 */
export function clockText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const part = (value: number) => String(value).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  const body = `${part(Math.floor((total % 3600) / 60))}:${part(total % 60)}`
  return hours ? `${hours}:${body}` : body
}

/** 键盘步进后的位置(毫秒):← / → 各 5%,Home / End 到两端;不认识或越界的按键返回原位置。 */
export function nextPosition(key: string, at: number, duration: number): number {
  if (!duration || duration <= 0) return 0
  const clamped = Math.min(duration, Math.max(0, at))
  const step = duration / 20
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, clamped - step)
    case 'ArrowRight':
      return Math.min(duration, clamped + step)
    case 'Home':
      return 0
    case 'End':
      return duration
    default:
      return clamped
  }
}

/** 把播放位置夹到 [0, 时长](ARIA slider 要求 valuenow 落在 min..max 之间)。 */
export function clampPosition(position: number, duration: number): number {
  if (!Number.isFinite(position)) return 0
  if (!Number.isFinite(duration) || duration <= 0) return 0
  return Math.min(duration, Math.max(0, Math.round(position)))
}
