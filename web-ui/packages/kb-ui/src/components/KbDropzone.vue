<script setup lang="ts">
// 拖放 / 上传区(设计规范与数据源设计稿):标题 + 说明 + 「选择文件 / 选择文件夹」+ 默认插槽(格式标签)。
// 页面只传标题与回调,样式全部来自 token;文件夹选择会带上 webkitRelativePath,保留目录结构。
// 注意:拖进来的文件由全局拖放遮罩接收(见 ShellFrame),`files` 只在点按钮 / 点空白处选择时触发。
//
// 手机(触屏且 <600 宽,.10):点上传先弹一个底部弹层,三选一:拍照 / 从相册选 / 选择文件。
// 三者最后都走同一个 `files` 事件(页面再交给 requestUpload),这里不碰上传逻辑。
// 电脑和平板(鼠标)保持原来的两个按钮。给了 accept(例如只收 .zip)时没有相机和相册可言,也保持单个「选择文件」。
import { computed, ref } from 'vue'
import KbIcon from './KbIcon.vue'
import KbSourceSheet, { type SourceId, type SourceOption } from './KbSourceSheet.vue'
import { cameraFiles } from '../composables/cameraFile'
import { TOUCH_PHONE_QUERY, useMedia } from '../composables/useMedia'

const props = withDefaults(defineProps<{ title: string; description?: string; accept?: string; compact?: boolean; folder?: boolean; picker?: boolean }>(), {
  description: '',
  accept: '',
  compact: false,
  folder: true,
  picker: true,
})
const emit = defineEmits<{ files: [files: File[]] }>()
const over = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const folderInput = ref<HTMLInputElement | null>(null)
const cameraInput = ref<HTMLInputElement | null>(null)
const albumInput = ref<HTMLInputElement | null>(null)

const touchPhone = useMedia(TOUCH_PHONE_QUERY)
/** 用底部弹层选来源:手机触屏,且没有被 accept 限制成某种文件 */
const useSheet = computed(() => props.picker && touchPhone.value && !props.accept)
const sheetOpen = ref(false)
/** 弹层三项的文案:这里的相册包含视频,文件是文档 / 压缩包等 */
const SOURCES: SourceOption[] = [
  { id: 'camera', title: '拍照', hint: '用相机拍一张,直接上传' },
  { id: 'album', title: '从相册选', hint: '照片和视频,可以多选' },
  { id: 'file', title: '选择文件', hint: '文档、压缩包等,可以多选' },
]

/** 拖放不在这里 emit:全局 KbDropOverlay 在 window 上接 drop(冒泡过来),这里再发一次会重复上传。 */
function onDrop() {
  over.value = false
}
function onPick(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  if (files.length) emit('files', files)
  input.value = ''
}
function onCamera(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  if (files.length) emit('files', cameraFiles(files))
  input.value = ''
}
/** 点空白处等同「选择文件」(手机上是打开来源弹层);点按钮 / 标签自己处理。 */
function onZoneClick(event: MouseEvent) {
  if ((event.target as HTMLElement).closest('button, input')) return
  if (useSheet.value) sheetOpen.value = true
  else fileInput.value?.click()
}
/** 弹层里选了一项:先收弹层再唤起系统选择器。input 在弹层外面,弹层卸载不会让它失效;click 仍在用户点击的同一次事件里,不会被浏览器拦。 */
function choose(id: SourceId) {
  sheetOpen.value = false
  const input = { camera: cameraInput, album: albumInput, file: fileInput }[id]
  input.value?.click()
}
</script>

<template>
  <div
    class="kb-drop"
    :class="{ 'is-over': over, 'is-compact': compact }"
    @click="onZoneClick"
    @dragover.prevent="over = true"
    @dragleave.prevent="over = false"
    @drop.prevent="onDrop"
  >
    <div class="kb-drop-orb"><KbIcon name="upload" :size="20" /></div>
    <div class="kb-drop-title">{{ title }}</div>
    <div v-if="description" class="m kb-drop-desc">{{ description }}</div>
    <div class="kb-drop-actions">
      <button v-if="useSheet" type="button" class="btn pri kb-drop-pick" data-testid="drop-pick" @click="sheetOpen = true">上传文件</button>
      <template v-else>
        <button type="button" class="btn sm pri" @click="fileInput?.click()">选择文件</button>
        <button v-if="folder" type="button" class="btn sm" @click="folderInput?.click()">选择文件夹</button>
      </template>
    </div>
    <div v-if="$slots.default" class="kb-drop-chips"><slot /></div>
    <input ref="fileInput" type="file" :accept="accept" multiple class="kb-none" data-testid="pick-file" @change="onPick" />
    <input v-if="!useSheet" ref="folderInput" type="file" multiple webkitdirectory class="kb-none" data-testid="pick-folder" @change="onPick" />
    <!-- capture 在部分 iOS 版本被忽略(直接弹系统选择器):可以接受的降级,不做 UA 判断 -->
    <input v-if="useSheet" ref="cameraInput" type="file" accept="image/*" capture="environment" class="kb-none" data-testid="pick-camera" @change="onCamera" />
    <input v-if="useSheet" ref="albumInput" type="file" accept="image/*,video/*" multiple class="kb-none" data-testid="pick-album" @change="onPick" />

    <KbSourceSheet v-if="sheetOpen" title="上传文件" :options="SOURCES" @choose="choose" @close="sheetOpen = false" />
  </div>
</template>
