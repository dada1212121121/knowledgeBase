<script setup lang="ts">
// 全局拖放遮罩:任意页面拖入文件 / 文件夹都会出现,松开即加入当前集合。
// 只组合 token 工具类;不写死颜色与尺寸。
import { onMounted, onUnmounted, ref } from 'vue'
import KbIcon from './KbIcon.vue'

const props = withDefaults(
  defineProps<{ collection?: string; collections?: string[]; disabled?: boolean }>(),
  { collection: '', collections: () => [], disabled: false },
)
const emit = defineEmits<{ drop: [files: File[]]; 'update:collection': [value: string] }>()

const over = ref(false)
const alt = ref(false)
/** 正在拖的项目数(dragover 阶段浏览器只给数量,拿不到文件名和大小) */
const count = ref(0)

function onDragOver(event: DragEvent) {
  if (props.disabled) {
    over.value = false
    return
  }
  if (!event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  over.value = true
  alt.value = event.altKey
  count.value = event.dataTransfer.items?.length ?? 0
}

function onDragLeave(event: DragEvent) {
  // 只有真正离开窗口才收起(子元素之间的移动也会触发 dragleave)
  if (event.relatedTarget === null) over.value = false
}

function onDrop(event: DragEvent) {
  if (props.disabled) return
  event.preventDefault()
  over.value = false
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (files.length) emit('drop', files)
}

function onKey(event: KeyboardEvent) {
  alt.value = event.altKey
}

onMounted(() => {
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('drop', onDrop)
  window.addEventListener('keydown', onKey)
  window.addEventListener('keyup', onKey)
})

onUnmounted(() => {
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('drop', onDrop)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('keyup', onKey)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="kb-fade">
      <div v-if="over" class="kb-overlay kb-drop-overlay" role="presentation">
        <div class="kb-drop-panel">
          <div class="kb-drop-orb is-lg"><KbIcon name="upload" :size="28" /></div>
          <div class="kb-drop-ovtitle">
            松开即可添加到 <span class="kb-drop-ovname">{{ collection || '知识库' }}</span>
          </div>
          <div class="m">{{ count ? `${count} 个项目 · ` : '' }}文件夹保留目录结构</div>
          <div class="row kb-drop-tags">
            <span class="tag">可直接点击下方切换目标集合</span>
            <span class="tag">.zip 自动解包</span>
            <span class="tag">遵守 .gitignore</span>
          </div>
          <div v-if="props.collections.length" class="kb-row kb-drop-col-list">
            <span
              v-for="name in props.collections"
              :key="name"
              class="seg"
              :class="{ 'is-active': name === collection }"
              role="button"
              tabindex="0"
              @click.stop="emit('update:collection', name)"
            >
              <i :class="{ on: name === collection }">{{ name }}</i>
            </span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.kb-drop-col-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: center;
  margin-top: 10px;
  max-width: 90%;
  max-height: 120px;
  overflow-y: auto;
}
.seg {
  cursor: pointer;
  padding: 4px 10px;
  border-radius: var(--r-sm, 6px);
  background: rgba(var(--ink), 0.08);
  font-size: var(--text-12, 12px);
  transition: all 0.15s ease;
  user-select: none;
}
.seg:hover {
  background: rgba(var(--ink), 0.15);
}
.seg.is-active,
.seg i.on {
  background: var(--accent);
  color: #fff;
  font-style: normal;
  font-weight: 600;
}
</style>
