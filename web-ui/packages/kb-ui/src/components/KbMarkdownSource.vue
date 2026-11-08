<script setup lang="ts">
// Markdown 源码编辑器(03 浏览器详情):等宽字体 + 轻量语法着色(标题 / 行内代码 / 加粗 / 链接),
// 底层是一个透明文字的 <textarea> 叠在着色层上——光标、选区、输入法、撤销全部是原生行为,
// 不引入 md-editor 这种整页级的重组件;需要渲染预览时才在页面里按需加载它。
// 着色层与 textarea 放在同一个 grid 格子里,高度都跟内容走,滚动只发生在外层容器,
// 所以两层永远对齐(不需要同步 scrollTop,也没有滚动条宽度差导致的折行错位)。
import { computed } from 'vue'

const props = withDefaults(defineProps<{ modelValue: string; readonly?: boolean }>(), { readonly: false })
const emit = defineEmits<{ 'update:modelValue': [value: string]; focus: []; blur: [] }>()

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 先整体转义再着色:输入里的 < > & 永远不会变成标签。 */
const html = computed(
  () =>
    props.modelValue
      .split('\n')
      .map((line) => {
        const safe = escapeHtml(line)
        if (/^#{1,6}\s/.test(safe)) return `<span class="kw">${safe}</span>`
        return safe
          .replace(/(`[^`]+`)/g, '<span class="st">$1</span>')
          .replace(/(\*\*[^*]+\*\*)/g, '<span class="nu">$1</span>')
          .replace(/(\[\[[^\]]+\]\])/g, '<span class="cm">$1</span>')
      })
      .join('\n') + '\n',
)
</script>

<template>
  <div class="code kb-md" :class="{ 'is-readonly': readonly }">
    <div class="kb-md-stack">
      <!-- eslint-disable-next-line vue/no-v-html -- 内容已整体转义,只插入着色 span -->
      <pre class="kb-md-layer" aria-hidden="true" v-html="html"></pre>
      <textarea
        class="kb-md-input"
        spellcheck="false"
        :readonly="readonly"
        :value="modelValue"
        aria-label="Markdown 正文"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
        @focus="emit('focus')"
        @blur="emit('blur')"
      ></textarea>
    </div>
  </div>
</template>
