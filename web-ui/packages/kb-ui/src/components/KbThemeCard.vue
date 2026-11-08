<script setup lang="ts">
// 主题卡(设计规范): mini 预览 + 名称 + 选中态。
withDefaults(
  defineProps<{
    label: string
    tone: 'dark' | 'light' | 'split'
    theme: string
    active: boolean
    accent?: string
  }>(),
  {
    accent: 'indigo',
  },
)
const emit = defineEmits<{ select: [] }>()
</script>

<template>
  <div class="th" :class="{ on: active }" :data-v="theme" @click="emit('select')">
    <div class="pv">
      <template v-if="tone === 'split'">
        <div style="position: absolute; inset: 0; clip-path: inset(0 50% 0 0)">
          <div class="mini" data-theme="dark" data-tone="dark" :data-accent="accent">
            <div class="ms"><i class="a"></i><i></i><i style="width: 70%"></i><i style="width: 60%"></i></div>
            <div class="mc">
              <div class="mt"></div>
              <div class="mk">
                <u style="height: 40%"></u>
                <u style="height: 65%"></u>
                <u style="height: 50%"></u>
                <u style="height: 85%"></u>
                <u style="height: 60%"></u>
              </div>
              <div class="mb"></div>
            </div>
          </div>
        </div>
        <div style="position: absolute; inset: 0; clip-path: inset(0 0 0 50%)">
          <div class="mini" data-theme="light" data-tone="light" :data-accent="accent">
            <div class="ms"><i class="a"></i><i></i><i style="width: 70%"></i><i style="width: 60%"></i></div>
            <div class="mc">
              <div class="mt"></div>
              <div class="mk">
                <u style="height: 40%"></u>
                <u style="height: 65%"></u>
                <u style="height: 50%"></u>
                <u style="height: 85%"></u>
                <u style="height: 60%"></u>
              </div>
              <div class="mb"></div>
            </div>
          </div>
        </div>
      </template>
      <div v-else class="mini" :data-theme="theme" :data-tone="tone" :data-accent="accent">
        <div class="ms"><i class="a"></i><i></i><i style="width: 70%"></i><i style="width: 60%"></i></div>
        <div class="mc">
          <div class="mt"></div>
          <div class="mk">
            <u style="height: 40%"></u>
            <u style="height: 65%"></u>
            <u style="height: 50%"></u>
            <u style="height: 85%"></u>
            <u style="height: 60%"></u>
          </div>
          <div class="mb"></div>
        </div>
      </div>
      <span class="ck">
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2.5 6.3l2.3 2.3 4.7-5" />
        </svg>
      </span>
    </div>
    <div class="nm">{{ label }}</div>
  </div>
</template>
