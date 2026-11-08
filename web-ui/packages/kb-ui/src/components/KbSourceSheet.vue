<script setup lang="ts">
// 「选来源」底部弹层:手机上点上传 / 插图,先问一句 拍照 / 从相册选 / 选择文件。
// 这里只负责「问」:点哪一项就 emit('choose', id),真正唤起系统选择器、拿到文件之后的流程都留给调用方
// (上传区交给 requestUpload,编辑器交给自己的插入流程),所以弹层本身不碰 input、不碰上传。
// 谁来决定「该不该出弹层」也在调用方:用 TOUCH_PHONE_QUERY(触屏且 <600 宽)判断,两处要保持同一条线。
//
// class 与 data-testid 沿用最初写在上传区里的名字(kb-drop-* / drop-sheet / opt-*):
// 单测和 e2e 场景按这些名字找元素,样式在 tokens/dashboard.css。
import { onBeforeUnmount, onMounted } from 'vue'
import KbIcon from './KbIcon.vue'
import KbSheet from './KbSheet.vue'

export type SourceId = 'camera' | 'album' | 'file'
export interface SourceOption {
  id: SourceId
  /** 行标题,例如「拍照」 */
  title: string
  /** 标题下的一句说明,告诉用户选完会怎样 */
  hint: string
}

defineProps<{ title: string; options: SourceOption[] }>()
const emit = defineEmits<{ choose: [id: SourceId]; close: [] }>()

const ICONS = { camera: 'camera', album: 'image', file: 'doc' } as const

/**
 * 弹层常常叠在对话框上面(「添加数据」):对话框的 Esc 监听是 document 捕获阶段、注册得更早,
 * KbSheet 自己的同阶段监听排在它后面,Esc 会先把整个对话框关掉(已选的文件清单也没了)。
 * 所以在 window 捕获阶段(比 document 更早)先接住 Esc,只关弹层。
 * 外接键盘的 iPad 分屏、手机蓝牙键盘会遇到。
 */
function onKey(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  event.stopImmediatePropagation()
  event.preventDefault()
  emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <KbSheet :title="title" @close="emit('close')">
    <div class="kb-drop-sheet" data-testid="drop-sheet">
      <button v-for="option in options" :key="option.id" type="button" class="kb-drop-opt" :data-testid="`opt-${option.id}`" @click="emit('choose', option.id)">
        <span class="kb-drop-opt-ico"><KbIcon :name="ICONS[option.id]" :size="18" /></span>
        <span class="kb-drop-opt-text"><b>{{ option.title }}</b><span class="m">{{ option.hint }}</span></span>
      </button>
    </div>
  </KbSheet>
</template>
