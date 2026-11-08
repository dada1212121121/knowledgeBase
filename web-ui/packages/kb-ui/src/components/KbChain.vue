<script setup lang="ts">
// 事件链(03 浏览器详情底部「进化链」):竖线 + 彩色圆点 + 「时间 文案」。
export interface ChainEvent {
  time?: string
  text: string
  tone?: 'neutral' | 'ok' | 'warn' | 'bad'
  /** 可点击(例如跳到另一版本) */
  id?: string
}
defineProps<{ events: ChainEvent[] }>()
const emit = defineEmits<{ select: [event: ChainEvent] }>()
const toneClass = { neutral: '', ok: 'is-ok', warn: 'is-warn', bad: 'is-bad' } as const
</script>

<template>
  <div class="kb-chain">
    <div
      v-for="(event, index) in events"
      :key="index"
      class="kb-chain-item"
      :class="[toneClass[event.tone ?? 'neutral'], { 'is-link': !!event.id }]"
      @click="event.id && emit('select', event)"
    >
      <span v-if="event.time" class="mono m">{{ event.time }}</span>
      <span>{{ event.text }}</span>
    </div>
  </div>
</template>
