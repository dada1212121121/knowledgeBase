<script setup lang="ts">
// 音频波形(设计稿):从原件解码出峰值画柱状图,点击可定位。
// 解码失败(浏览器不支持该编码 / 取不到原件)就只显示时间轴,不挡转写文本。
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { clampPosition, clockText, mergeChannels, nextPosition, normalizePeaks } from '@/utils/waveform'

const props = defineProps<{
  /** 原件地址(`GET /api/v1/raw`);没有就不画波形 */
  src: string | null
  /** 已知时长(毫秒;转写块里算出来的,拿不到就等解码结果) */
  durationMs?: number | null
  /** 当前播放位置(毫秒;由播放器的 `timeupdate` 传进来,没有就按 0 算) */
  positionMs?: number | null
}>()
/** `seek` 的第二个参数:定位后是否自动播放(点击 true,键盘微调 false)。 */
const emit = defineEmits<{ seek: [ms: number, play?: boolean] }>()

const BUCKETS = 160
/** 下载上限:编码后超过这个大小就不下(先看 `Content-Length`,不是下完再判)。 */
const MAX_BYTES = 48 * 1024 * 1024
/** 解码后上限:float32 × 声道数,超过就不解码(解码后的内存才是真开销)。 */
const MAX_DECODED_BYTES = 512 * 1024 * 1024
/** 采样率按 48 kHz 估(拿不到真实值时的保守估计) */
const ESTIMATE_RATE = 48_000

const peaks = ref<number[]>([])
const duration = ref<number>(0)
const state = ref<'idle' | 'loading' | 'ready' | 'failed' | 'too-large'>('idle')

/** 解码后体积估算:时长 × 采样率 × 双声道 × float32(保守估计,用来提前放弃)。 */
function estimateDecodedBytes(durationMs: number): number {
  return (durationMs / 1000) * ESTIMATE_RATE * 2 * 4
}

/** 当前请求序号:快速切换文件时,旧请求的结果不许覆盖新的。 */
let requestSeq = 0
let controller: AbortController | null = null

async function load(url: string | null) {
  requestSeq += 1
  const seq = requestSeq
  controller?.abort()
  controller = null
  peaks.value = []
  duration.value = props.durationMs ?? 0
  if (!url) {
    state.value = 'idle'
    return
  }
  // 先用转写块里已知的时长估一下解码后体积:几小时的录音就算文件不大也不该解。
  // 这一步必须在 fetch **之前**(质量检查 :原来放在下载之后,长录音照样整份下载)。
  if (props.durationMs && estimateDecodedBytes(props.durationMs) > MAX_DECODED_BYTES) {
    state.value = 'too-large'
    return
  }
  state.value = 'loading'
  const current = new AbortController()
  controller = current
  try {
    const response = await fetch(url, { signal: current.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    // 先看大小再决定下不下。没有 `Content-Length` 时不要当成 0:
    // 那会让这道预检静默失效,按“未知”处理,交给下载后的兜底判断
    const header = response.headers.get('content-length')
    const length = header === null ? null : Number(header)
    if (length !== null && Number.isFinite(length) && length > MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('原件过大,跳过波形')
    }
    const buffer = await response.arrayBuffer()
    if (seq !== requestSeq) return
    if (buffer.byteLength > MAX_BYTES) throw new Error('原件过大,跳过波形')
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) throw new Error('浏览器不支持 WebAudio')
    const context = new Ctx()
    try {
      const audio = await context.decodeAudioData(buffer)
      const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index))
      const decodedBytes = channels.length * channels[0].length * 4
      if (decodedBytes > MAX_DECODED_BYTES) throw new Error('解码后体积过大,跳过波形')
      if (seq !== requestSeq) return
      peaks.value = normalizePeaks(mergeChannels(channels, BUCKETS))
      duration.value = Math.round(audio.duration * 1000)
      state.value = 'ready'
    } finally {
      void context.close()
    }
  } catch (err) {
    // 解码失败 / 被取消 / 体积超限都是正常情况:退回纯时间轴,不挡转写文本
    if (seq === requestSeq) {
      const message = err instanceof Error ? err.message : ''
      state.value = message.includes('过大') ? 'too-large' : 'failed'
    }
  } finally {
    if (controller === current) controller = null
  }
}

/** 真实播放位置优先用父组件传进来的(质量检查 :私有状态会过期) */
const position = computed(() => clampPosition(props.positionMs ?? 0, duration.value))

function onSeek(event: MouseEvent) {
  if (!duration.value) return
  const target = event.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  emit('seek', Math.round(ratio * duration.value))
}

onMounted(() => void load(props.src))
watch(() => props.src, (url) => void load(url))
// 卸载时中断请求:切页 / 换文件后不该继续下载
onUnmounted(() => {
  requestSeq += 1
  controller?.abort()
  controller = null
})

/** 键盘定位:左右箭头按 5% 步进(无障碍:波形是可操作的控件)。 */
function onKey(event: KeyboardEvent) {
  if (!duration.value || state.value !== 'ready') return
  // 不抢浏览器 / 系统的组合键(Alt+← 是后退)
  if (event.altKey || event.ctrlKey || event.metaKey) return
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  // 键盘微调不自动播放(点击才播):DocViewer 的 seekTo 收到 false
  emit('seek', Math.round(nextPosition(event.key, position.value, duration.value)), false)
}
</script>

<template>
  <div class="kb-wave" :class="`is-${state}`">
    <div
      class="kb-wave-bars"
      role="slider"
      tabindex="0"
      :aria-label="'音频波形,点击或左右箭头定位'"
      :aria-valuemin="0"
      :aria-valuemax="duration || 0"
      :aria-valuenow="position"
      :aria-valuetext="`${clockText(position)} / ${clockText(duration)}`"
      @click="onSeek"
      @keydown="onKey"
    >
      <i
        v-for="(peak, index) in peaks"
        :key="index"
        :style="{ height: `${Math.max(3, Math.round(peak * 100))}%` }"
      ></i>
      <!-- 还没解码出来:一条静态基线,避免高度塌陷 -->
      <span v-if="!peaks.length" class="kb-wave-baseline"></span>
    </div>
    <div class="kb-wave-axis">
      <span class="kb-hint">{{
        state === 'too-large'
          ? '原件过大 / 过长,不画波形(只显示时间轴)'
          : state === 'failed'
            ? '原件无法解码,只显示时间轴'
            : clockText(0)
      }}</span>
      <span class="kb-spacer"></span>
      <span class="kb-hint">{{ duration ? clockText(duration) : '—' }}</span>
    </div>
  </div>
</template>

<style scoped>
.kb-wave {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  /* 160 根柱 × (1px + 2px 间距) 的 min-content 有 478px:不让它撑宽外层(同类问题) */
  min-width: 0;
}
.kb-wave-bars {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 56px;
  min-width: 0;
  overflow: hidden;
  cursor: pointer;
}
.kb-wave-bars i {
  flex: 1;
  min-width: 1px;
  border-radius: var(--r1);
  background: var(--accent-soft);
}
.kb-wave-baseline {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 1px;
  background: var(--border-default);
}
.kb-wave-axis {
  display: flex;
  align-items: center;
}
</style>
