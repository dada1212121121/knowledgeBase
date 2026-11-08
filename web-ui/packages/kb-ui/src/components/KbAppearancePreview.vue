<script setup lang="ts">
// 外观实时预览窗口(外观设置设计稿): 响应当前主题与色调的迷你看板。
withDefaults(
  defineProps<{
    themeText?: string
    accentText?: string
    densityText?: string
  }>(),
  {
    themeText: '暗夜',
    accentText: '靛蓝',
    densityText: '默认',
  },
)

const emit = defineEmits<{ reset: [] }>()
</script>

<template>
  <div class="pvw">
    <div class="ap-h">
      <b>实时预览</b><span>{{ themeText }} · {{ accentText }} · {{ densityText }}</span>
    </div>
    <div class="frame">
      <div class="fb">
        <i></i><i></i><i></i>
        <span class="m" style="font-size: calc(11px * var(--fs)); margin-left: 8px" style-allow="预览窗口标题字号">kb.local/dashboard</span>
      </div>
      <div class="fbody">
        <div class="fside">
          <div class="ni on">
            <svg viewBox="0 0 16 16"><path d="M3 7l5-4 5 4v6H3z" /></svg>
            <span class="lbl2">仪表盘</span>
          </div>
          <div class="ni">
            <svg viewBox="0 0 16 16"><ellipse cx="8" cy="4" rx="5" ry="2" /><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" /></svg>
            <span class="lbl2">浏览器</span>
          </div>
          <div class="ni">
            <svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
            <span class="lbl2">搜索</span>
          </div>
          <div class="ni">
            <svg viewBox="0 0 16 16"><path d="M2 9l2-6h8l2 6v4H2zM2 9h4l1 2h2l1-2h4" /></svg>
            <span class="lbl2">审核</span>
          </div>
        </div>
        <div class="fmain">
          <div class="card metric" style="padding: 10px 12px" style-allow="预览指标卡间距">
            <div class="k">知识条目</div>
            <div class="v" style="font-size: calc(20px * var(--fs)); line-height: 28px" style-allow="指标值字号">12,438</div>
            <div class="s up">+312 本周</div>
          </div>
          <div class="row" style="gap: 6px" style-allow="按钮排布间距">
            <span class="btn pri sm">新建条目</span>
            <span class="btn sm">导出</span>
            <span class="tag g" style="margin-left: auto" style-allow="状态标签右对齐">在线</span>
          </div>
          <div class="row" style="gap: 6px" style-allow="标签行间距">
            <span class="tag ac">insight</span>
            <span class="tag y">待审</span>
            <span class="tag r">失败</span>
          </div>
          <div class="inp" style="box-shadow: var(--ring); border-color: transparent; height: 28px" style-allow="预览搜索框阴影与高度">
            <span class="m" style="font-size: calc(12px * var(--fs))" style-allow="占位文本字号">搜索 “sidecar 超时”</span>
          </div>
          <div class="card" style="overflow: hidden" style-allow="迷你表格圆角溢出隐藏">
            <table>
              <tbody>
                <tr class="sel">
                  <td class="mono" style="font-size: calc(11.5px * var(--fs))" style-allow="代码字体字号">drf_52c</td>
                  <td style="font-size: calc(12px * var(--fs))" style-allow="表格内容字号">指数退避</td>
                </tr>
                <tr>
                  <td class="mono" style="font-size: calc(11.5px * var(--fs))" style-allow="代码字体字号">drf_52b</td>
                  <td style="font-size: calc(12px * var(--fs))" style-allow="表格内容字号">kb_ 前缀</td>
                </tr>
                <tr>
                  <td class="mono" style="font-size: calc(11.5px * var(--fs))" style-allow="代码字体字号">drf_529</td>
                  <td style="font-size: calc(12px * var(--fs))" style-allow="表格内容字号">幂等导入</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="row" style="justify-content: space-between" style-allow="两端对齐行">
            <span style="font-size: calc(12px * var(--fs))" style-allow="开关标签字号">自动审核</span>
            <span class="sw on"></span>
          </div>
        </div>
      </div>
    </div>
    <div class="row m" style="font-size: calc(12px * var(--fs))" style-allow="底栏说明字号">
      <svg class="gi" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <path d="M3 8.5l3 3 7-7" />
      </svg>
      已同步到账户 · 所有设备生效
      <span class="btn sm" style="margin-left: auto" style-allow="操作按钮右对齐" @click="emit('reset')">恢复默认</span>
    </div>
  </div>
</template>
