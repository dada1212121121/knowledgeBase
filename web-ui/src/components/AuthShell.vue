<script setup lang="ts">
// 登录 / 注册 / 找回密码共用的外壳(多用户设计说明,草图 设计稿)。
// ≥1024px 左边是品牌介绍,右边是表单;更窄时只显示表单,顶部放一个小品牌条。
// 站点名与一句话介绍来自 /auth/status(管理员在系统参数里改),不写死。
import KbIcon from '@kb-ui/components/KbIcon.vue'
import { useVisualViewport } from '@/composables/useVisualViewport'

defineProps<{ siteName: string; tagline?: string }>()
// 软键盘:写 --kbd-inset / data-kbd,输入框聚焦时滚进可见区(iOS 的布局视口不随键盘缩,没有它输入框会被盖住)
useVisualViewport()
</script>

<template>
  <div class="auth">
    <aside class="auth-pane" aria-hidden="false">
      <div class="auth-brand"><img src="/icons/icon-192.png" class="auth-mark" alt="kb" /><b>{{ siteName }}</b></div>
      <h1 class="auth-title">
        <template v-if="tagline">{{ tagline }}</template>
        <template v-else>个人与团队的<em>知识库</em></template>
      </h1>
      <p class="auth-lead">记笔记、存文档、一起写。你的内容只属于你,想分享时再分享。</p>
      <ul class="auth-points">
        <li>
          <span class="auth-ico"><KbIcon name="lock" :size="18" /></span>
          <div><b>每个人一个独立的知识库</b>内容互相隔离,默认只有你能看到</div>
        </li>
        <li>
          <span class="auth-ico"><KbIcon name="share" :size="18" /></span>
          <div><b>按需分享,权限可控</b>可查看、可评论、可编辑,也可以发链接给游客</div>
        </li>
        <li>
          <span class="auth-ico"><KbIcon name="users" :size="18" /></span>
          <div><b>多人实时协作</b>同一篇文档一起写,看得到彼此的光标</div>
        </li>
      </ul>
      <!-- 装饰:产品长什么样的静态示意(搜索结果 + 谁在一起编辑)。读屏软件跳过,不可点,不含真实数据 -->
      <div class="auth-demo" aria-hidden="true">
        <div class="auth-demo-search"><KbIcon name="search" :size="14" /><span>双哈希增量索引怎么做</span></div>
        <div class="auth-demo-hit"><span class="auth-demo-tag">笔记</span><span class="auth-demo-title">增量索引只重算改动的块</span></div>
        <div class="auth-demo-hit"><span class="auth-demo-tag">代码</span><span class="auth-demo-title">fn reindex_changed(&amp;self)</span></div>
        <div class="auth-demo-foot">
          <span class="auth-demo-stack"><i></i><i></i><i></i></span>
          <span>3 人正在一起编辑</span>
        </div>
      </div>
    </aside>
    <main class="auth-main">
      <div class="auth-box">
        <div class="auth-mobile-brand"><img src="/icons/icon-192.png" class="auth-mark" alt="kb" /><span>{{ siteName }}</span></div>
        <slot />
      </div>
    </main>
  </div>
</template>

<style>
.auth {
  min-height: 100dvh;
  /* #app 是固定视口高度的 flex 容器:不写这行,内容比视口高时(软键盘占掉一截留白)会被它压缩、裁掉而不是撑出滚动 */
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  background-color: var(--bg-canvas);
  background-image:
    radial-gradient(1100px 700px at 15% 15%, color-mix(in oklab, var(--accent) 18%, transparent), transparent),
    radial-gradient(900px 600px at 85% 85%, color-mix(in oklab, var(--accent) 12%, transparent), transparent),
    linear-gradient(180deg, color-mix(in oklab, var(--bg-canvas) 45%, transparent) 0%, color-mix(in oklab, var(--bg-canvas) 75%, transparent) 100%),
    url('/auth-bg-dark.webp');
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
  background-attachment: fixed;
  color: var(--text-primary);
  position: relative;
}

/* 浅色主题：超清蓝图科技线条背景，与深色星轨完全对应 */
[data-tone=light] .auth,
[data-theme=light] .auth,
[data-theme=paper] .auth {
  background-image:
    radial-gradient(1000px 600px at 15% 15%, color-mix(in oklab, var(--accent) 14%, transparent), transparent),
    radial-gradient(800px 500px at 85% 85%, color-mix(in oklab, var(--accent) 9%, transparent), transparent),
    linear-gradient(180deg, color-mix(in oklab, var(--bg-canvas) 35%, transparent) 0%, color-mix(in oklab, var(--bg-canvas) 65%, transparent) 100%),
    url('/auth-bg-light.webp');
}

.auth-pane {
  display: flex;
  flex-direction: column;
  justify-content: center;
  position: relative;
  overflow: hidden;
  padding: 48px 64px;
  background: transparent;
}
/* 极淡的点阵,往边缘渐隐:给大片留白一点质感,不抢文字 */
.auth-pane::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: radial-gradient(rgba(var(--ink), 0.08) 1px, transparent 1px);
  background-size: 22px 22px;
  -webkit-mask-image: radial-gradient(ellipse at 30% 20%, #000 0%, transparent 70%);
  mask-image: radial-gradient(ellipse at 30% 20%, #000 0%, transparent 70%);
}
.auth-pane > * {
  position: relative;
}
.auth-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
}
.auth-mark {
  display: block;
  object-fit: contain;
  width: 32px;
  height: 32px;
  border-radius: var(--r2);
  background: transparent;
  filter: drop-shadow(0 2px 8px color-mix(in oklab, var(--accent) 45%, transparent));
}
.auth-title {
  font-size: calc(38px * var(--fs));
  line-height: 1.2;
  letter-spacing: -0.02em;
  font-weight: 700;
  margin: 32px 0 14px;
}
.auth-title em {
  font-style: normal;
  color: var(--accent-text);
}
.auth-lead {
  max-width: 420px;
  color: var(--text-secondary);
}
.auth-points {
  list-style: none;
  padding: 0;
  display: grid;
  gap: 14px;
  margin-top: 28px;
  max-width: 420px;
}
.auth-points li {
  display: flex;
  gap: 12px;
  color: var(--text-secondary);
}
.auth-points li b {
  display: block;
  font-weight: 500;
  color: var(--text-primary);
}
.auth-ico {
  flex: none;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: var(--r2);
  background: color-mix(in oklab, var(--accent) 16%, transparent);
  color: var(--accent-text);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
/* 产品示意卡:自己的不透明底色,文字都用校准过的令牌,压在渐变上也不影响对比度 */
.auth-demo {
  display: grid;
  gap: 8px;
  max-width: 420px;
  margin-top: 32px;
  padding: 14px;
  border-radius: var(--r3);
  background: color-mix(in oklab, var(--surface-1) 85%, transparent);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--border-default);
  box-shadow: 0 18px 40px -18px rgba(var(--shade), 0.55);
  font-size: calc(13px * var(--fs));
  color: var(--text-secondary);
  user-select: none;
}
.auth-demo-search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 12px;
  border-radius: var(--r2);
  background: var(--surface-sunken);
  border: 1px solid var(--border-default);
  color: var(--text-primary);
}
.auth-demo-search svg {
  color: var(--text-tertiary);
}
.auth-demo-hit {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 4px;
  min-width: 0;
}
.auth-demo-tag {
  flex: none;
  padding: 1px 8px;
  border-radius: var(--r-pill);
  background: color-mix(in oklab, var(--accent) 14%, transparent);
  color: var(--accent-text);
  font-size: calc(11px * var(--fs));
}
.auth-demo-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}
.auth-demo-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 4px 0;
  border-top: 1px solid var(--border-subtle);
  font-size: calc(12px * var(--fs));
}
.auth-demo-stack {
  display: inline-flex;
}
.auth-demo-stack i {
  width: 20px;
  height: 20px;
  margin-left: -6px;
  border-radius: 50%;
  border: 2px solid var(--surface-1);
}
.auth-demo-stack i:first-child {
  margin-left: 0;
  background: #e03131; /* tokens-allow */
}
.auth-demo-stack i:nth-child(2) {
  background: #1971c2; /* tokens-allow */
}
.auth-demo-stack i:nth-child(3) {
  background: #2f9e44; /* tokens-allow */
}

.auth-main {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 24px calc(32px + var(--kbd-inset, 0px));
  min-height: 100dvh;
}
.auth-main::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(560px 400px at 50% 40%, color-mix(in oklab, var(--accent) 12%, transparent), transparent);
}

/* 表单毛玻璃卡片：移动端与桌面端统一包裹，确保文字高对比度与高级质感 */
.auth-box {
  position: relative;
  width: min(432px, 100%);
  padding: 34px 30px;
  border-radius: var(--r4);
  background: color-mix(in oklab, var(--surface-1) 85%, transparent);
  backdrop-filter: blur(24px) saturate(160%);
  -webkit-backdrop-filter: blur(24px) saturate(160%);
  border: 1px solid var(--border-default);
  box-shadow:
    inset 0 1px 0 rgba(var(--ink), 0.08),
    0 24px 56px -20px rgba(var(--shade), 0.55);
  display: flex;
  flex-direction: column;
  gap: 18px;
  animation: auth-rise var(--dur-slow, 280ms) var(--ease-out, ease-out) both;
}
@keyframes auth-rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}

.auth-mobile-brand {
  display: none;
  align-items: center;
  gap: 12px;
  font-size: calc(16px * var(--fs));
  font-weight: 700;
  letter-spacing: -0.01em;
  margin-bottom: 6px;
  color: var(--text-primary);
}
.auth-mobile-brand .auth-mark {
  width: 36px;
  height: 36px;
}

@media (max-width: 1023px) {
  .auth {
    grid-template-columns: minmax(0, 1fr);
  }
  .auth-pane {
    display: none;
  }
  .auth-mobile-brand {
    display: flex;
  }
  .auth-main {
    align-items: center;
    padding-top: max(32px, 6vh);
  }
}

@media (max-width: 599px) {
  .auth-main {
    padding: max(24px, 4vh) 16px calc(24px + var(--safe-bottom) + var(--kbd-inset, 0px));
  }
  .auth-box {
    padding: 26px 20px;
    border-radius: var(--r3);
    backdrop-filter: blur(20px) saturate(150%);
    -webkit-backdrop-filter: blur(20px) saturate(150%);
  }
}

/* 表单控件:三个页面共用 */
/* 表单本身不产生盒子,里面的字段直接参与 .auth-box 的纵向排布(间距统一由 .auth-box 的 gap 管) */
.auth-form {
  display: contents;
}
.auth-box h2 {
  font-size: calc(24px * var(--fs));
  font-weight: 700;
  line-height: 1.3;
}
.auth-sub {
  color: var(--text-secondary);
  margin-top: -10px;
}
.auth-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.auth-field > label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: calc(13px * var(--fs));
  color: var(--text-secondary);
}
.auth-field > label .auth-link {
  margin-left: auto;
}
.auth-inp {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 12px;
  border-radius: var(--r2);
  background: var(--surface-sunken);
  /* 边框用 --control-line:输入框的边界要有 3:1 的对比度 */
  border: 1px solid var(--control-line);
  color: var(--text-tertiary);
}
.auth-inp:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 25%, transparent);
}
.auth-inp input {
  flex: 1;
  min-width: 0;
  height: 100%;
  background: transparent;
  border: 0;
  outline: none;
  color: var(--text-primary);
  font: inherit;
  font-size: max(16px, calc(14px * var(--fs)));
}
.auth-inp input::placeholder {
  color: var(--text-quaternary);
}
.auth-inline {
  display: flex;
  gap: 8px;
}
.auth-inline .auth-inp {
  flex: 1;
  min-width: 0;
}
.auth-inline .kb-btn {
  flex: none;
  height: 44px;
  min-width: 104px;
  justify-content: center;
  white-space: nowrap;
}
.auth-help {
  font-size: calc(12px * var(--fs));
  color: var(--text-tertiary);
}
.auth-help.is-bad {
  color: var(--status-danger);
}
.auth-error {
  font-size: calc(13px * var(--fs));
  color: var(--status-danger);
}
.auth-alt {
  text-align: center;
  color: var(--text-secondary);
  font-size: calc(13px * var(--fs));
}
.auth-link {
  color: var(--accent-text);
  text-decoration: none;
  font-size: calc(13px * var(--fs));
  cursor: pointer;
}
.auth-link:hover {
  text-decoration: underline;
}
.auth-alt .auth-link {
  text-decoration: underline;
  text-underline-offset: 3px;
}
@media (pointer: coarse) {
  .auth-link {
    position: relative;
  }
  .auth-link::before {
    content: '';
    position: absolute;
    inset: -14px -6px;
  }
}
.auth-submit {
  width: 100%;
  height: 44px;
  justify-content: center;
}
.auth-strength {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
}
.auth-strength i {
  height: 4px;
  border-radius: var(--r-xs);
  background: rgba(var(--ink), 0.12);
}
.auth-strength i.on {
  background: var(--status-success);
}
.auth-strength.is-weak i.on {
  background: var(--status-danger);
}
.auth-strength.is-mid i.on {
  background: var(--status-warning);
}
</style>
