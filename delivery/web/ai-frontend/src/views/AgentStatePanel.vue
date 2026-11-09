<!--
  AgentStatePanel.vue (C2) — lightweight 2D digital-human status panel.

  A pure-CSS four-state status orb (idle / listening / thinking / speaking)
  plus four Element Plus info cards: 人格档案 (persona), 记忆 (memory),
  工具 (tools), 活动 (activity). No 3D, no WebGL, no three.js — only Vue 3 +
  Element Plus + CSS theme tokens.

  All data is fed in via props from AIChat.vue's existing stream/ws dispatch;
  this component holds no transport logic of its own. The Persona card is
  populated from the read-only GET /api/ai/persona endpoint.
-->
<template>
  <div class="agent-state-panel">
    <!-- Status orb -->
    <div class="orb-wrap">
      <div :class="['orb', `orb--${orbState}`]">
        <span class="orb-core"></span>
      </div>
      <div class="orb-label">{{ orbLabel }}</div>
    </div>

    <!-- Persona card -->
    <el-card class="state-card" shadow="never">
      <template #header>
        <span class="card-title">人格档案</span>
      </template>
      <div v-if="persona && persona.present">
        <div v-for="sec in persona.sections" :key="sec.title" class="persona-sec">
          <div class="persona-sec-title">{{ sec.title }}</div>
          <div v-for="(line, i) in sec.lines" :key="i" class="persona-sec-line">{{ line }}</div>
        </div>
      </div>
      <div v-else-if="personaError" class="card-empty card-empty--error">
        {{ personaError }}
      </div>
      <div v-else class="card-empty">
        未设置 AI 人格档案（可选）—— 配置后可定制小K的语气与回答风格
      </div>
    </el-card>

    <!-- Memory card -->
    <el-card class="state-card" shadow="never">
      <template #header>
        <span class="card-title">记忆</span>
        <span class="card-count">{{ memoryItems.length }}</span>
      </template>
      <div v-if="memoryItems.length">
        <div v-for="(m, i) in memoryItems.slice(-4)" :key="i" class="card-line">{{ m }}</div>
      </div>
      <div v-else class="card-empty">暂无记忆条目</div>
    </el-card>

    <!-- Tools card -->
    <el-card class="state-card" shadow="never">
      <template #header>
        <span class="card-title">工具</span>
        <span class="card-count">{{ toolCalls.length }}</span>
      </template>
      <div v-if="toolCalls.length">
        <div v-for="(t, i) in toolCalls.slice(-5)" :key="i" class="card-line">
          <span class="tool-dot"></span>{{ t }}
        </div>
      </div>
      <div v-else class="card-empty">暂无工具调用</div>
    </el-card>

    <!-- Activity card -->
    <el-card class="state-card" shadow="never">
      <template #header>
        <span class="card-title">活动</span>
      </template>
      <div v-if="activity.length">
        <div v-for="(a, i) in activity.slice(-5)" :key="i" class="card-line">{{ a }}</div>
      </div>
      <div v-else class="card-empty">暂无活动</div>
    </el-card>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  orbState: { type: String, default: 'idle' },
  persona: { type: Object, default: () => ({ present: false, sections: [] }) },
  // 面板本身不发请求，拿不到失败原因；由喂数据的 AIChat 把 loadError 传进来，
  // 否则一次 500 会显示成「未设置人格档案」。
  personaError: { type: String, default: '' },
  memoryItems: { type: Array, default: () => [] },
  toolCalls: { type: Array, default: () => [] },
  activity: { type: Array, default: () => [] },
  // 「在分析什么」：AIChat 把最后一条 thinkingTail / 当前工具的动词+目标喂进来
  // （规则 2.4）。空字符串就退回「分析用户意图」，不能停在「思考中」。
  thinkingTail: { type: String, default: '' },
  // 本轮已等待秒数，撑起 orb 标签里的进度位。
  waitSeconds: { type: Number, default: 0 },
});

// 目标 + 耗时（RUNTIME-002）：四个词都是「动作状态」而不是「在干什么」，
// thinking 态额外接一句真实分析内容。
const ORB_LABELS = {
  idle: () => '待命 · 本轮无进行中的请求',
  listening: (s) => `接收提问 · 第 ${s}s`,
  thinking: (s, tail) => `分析中 · ${tail || '分析用户意图'} · 第 ${s}s`,
  speaking: (s) => `生成回复 · 已输出 · 第 ${s}s`,
};

// thinking 态的一句话说明可能很长，压成一行末尾（否则侧栏被撑开）。
function trimTail(text) {
  const one = String(text || '').trim().replace(/\s+/g, ' ');
  return one.length > 40 ? `${one.slice(0, 40)}…` : one;
}

const orbLabel = computed(() => {
  const fn = ORB_LABELS[props.orbState] || ORB_LABELS.idle;
  return fn(props.waitSeconds, trimTail(props.thinkingTail));
});
</script>

<style scoped>
.agent-state-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.orb-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 12px 0;
}

.orb {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  transition:
    background 0.4s ease,
    box-shadow 0.4s ease,
    width 0.3s ease,
    height 0.3s ease;
}

.orb-core {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--khy-bg, var(--khy-white));
  opacity: 0.85;
  transition:
    width 0.3s ease,
    height 0.3s ease;
}

/* idle — calm grey, no animation, shrunk to a quiet dot so it does not dominate
   the panel as an empty placeholder; it grows back when a conversation starts. */
.orb--idle {
  width: 40px;
  height: 40px;
  background: radial-gradient(circle, var(--khy-gray-400) 0%, var(--khy-gray-500) 100%);
  box-shadow: 0 0 0 3px rgba(107, 114, 128, 0.12);
}

.orb--idle .orb-core {
  width: 16px;
  height: 16px;
}

/* listening — steady blue pulse */
.orb--listening {
  background: radial-gradient(circle, var(--khy-primary) 0%, var(--khy-primary) 100%);
  box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.2);
  animation: orb-pulse 1.8s ease-in-out infinite;
}

/* thinking — amber, faster pulse */
.orb--thinking {
  background: radial-gradient(circle, var(--khy-warning) 0%, var(--khy-warning) 100%);
  box-shadow: 0 0 0 4px rgba(217, 119, 6, 0.2);
  animation: orb-pulse 0.9s ease-in-out infinite;
}

/* speaking — green, lively pulse */
.orb--speaking {
  background: radial-gradient(circle, var(--khy-success) 0%, var(--khy-success) 100%);
  box-shadow: 0 0 0 4px rgba(22, 163, 74, 0.22);
  animation: orb-pulse 0.6s ease-in-out infinite;
}

@keyframes orb-pulse {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.08);
  }
}

.orb-label {
  font-size: 13px;
  color: var(--khy-text-secondary, var(--khy-gray-500));
}

.state-card {
  border: 1px solid var(--khy-border, var(--khy-gray-100));
}

.card-title {
  font-weight: 600;
  font-size: 13px;
}

.card-count {
  float: right;
  font-size: 12px;
  color: var(--khy-text-secondary, var(--khy-gray-400));
}

.card-line {
  font-size: 12px;
  color: var(--khy-text, var(--khy-gray-700));
  padding: 2px 0;
  word-break: break-all;
}

.card-empty {
  font-size: 12px;
  color: var(--khy-text-secondary, var(--khy-gray-300));
}

.card-empty--error {
  color: var(--el-color-danger, var(--khy-danger, #f56c6c));
  line-height: 1.5;
}

.persona-sec {
  margin-bottom: 6px;
}

.persona-sec-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--khy-primary, var(--khy-primary));
}

.persona-sec-line {
  font-size: 12px;
  color: var(--khy-text-secondary, var(--khy-gray-500));
  padding-left: 6px;
}

.tool-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--khy-primary, var(--khy-primary));
  margin-right: 6px;
}
</style>
