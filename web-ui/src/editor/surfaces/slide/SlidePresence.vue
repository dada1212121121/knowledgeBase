<script setup lang="ts">
/**
 * 协同时别人的位置：对方选中的形状画一个对方颜色的框，框上挂名字
 * 纯展示，不接收指针（盖在画布上不能挡住点击）。颜色来自对方的代表色，名字标签用同色底、白字。
 */
import { toScreen } from './overlay'
import type { PeerBox } from './presence'

defineProps<{ boxes: readonly PeerBox[]; scale: number }>()
</script>

<template>
  <div class="kb-sl-presence" data-testid="slide-presence" aria-hidden="true">
    <div v-for="box in boxes" :key="box.peer.id" class="kb-sl-peerbox" :style="{ ...toScreen(box.rect, scale), borderColor: box.peer.color }" data-testid="slide-peer-box">
      <span class="kb-sl-peername" :style="{ background: box.peer.color, top: `${-18 - box.stack * 18}px` }">{{ box.peer.name }}</span>
    </div>
  </div>
</template>

<style>
.kb-sl-presence {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: visible;
}
.kb-sl-peerbox {
  position: absolute;
  box-sizing: border-box;
  border: 2px solid;
  border-radius: 2px;
}
.kb-sl-peername {
  position: absolute;
  left: -2px;
  max-width: 160px;
  padding: 1px 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #fff;
  font-size: 11px;
  line-height: 16px;
  border-radius: 3px 3px 3px 0;
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.55);
}
.kb-sl-peers {
  display: inline-flex;
  gap: 2px;
  margin-left: auto;
}
.kb-sl-peerdot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: #fff;
  font-size: 10px;
  line-height: 1;
  border-radius: 50%;
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.55);
}
</style>
