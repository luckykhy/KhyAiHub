<template>
  <div v-if="visible" class="clarify-card" role="form" aria-label="结构化澄清问询">
    <div class="clarify-header">
      <el-tag type="warning" size="small">澄清问询</el-tag>
      <span class="clarify-title">{{ questions.length }} 张选项卡 — 点选或自由输入后发送</span>
      <button type="button" class="clarify-dismiss" aria-label="关闭问询卡" @click="dismiss">×</button>
    </div>

    <div v-for="(q, qi) in questions" :key="qi" class="clarify-question">
      <div class="clarify-q-head">
        <el-tag v-if="q.header" size="small" effect="plain">{{ q.header }}</el-tag>
        <span class="clarify-q-text">{{ q.question }}</span>
        <span v-if="q.multiSelect" class="clarify-multi-hint">（可多选）</span>
      </div>

      <div class="clarify-options" role="group" :aria-label="q.question">
        <button
          v-for="(opt, oi) in q.options"
          :key="oi"
          type="button"
          class="clarify-option"
          :class="{ selected: isPicked(qi, optLabel(opt)) }"
          :aria-pressed="isPicked(qi, optLabel(opt))"
          @click="pick(qi, q.multiSelect, optLabel(opt))"
        >
          <span class="clarify-option-label">{{ optLabel(opt) }}</span>
          <span v-if="optDescription(opt)" class="clarify-option-desc">{{ optDescription(opt) }}</span>
        </button>
      </div>

      <input
        v-model="freeText[qi]"
        type="text"
        class="clarify-free-input"
        :aria-label="`问题 ${qi + 1} 自由输入`"
        placeholder="或在此输入你自己的答案…"
        @keydown.enter.prevent="submitAll"
      />
    </div>

    <div class="clarify-actions">
      <el-button type="primary" size="small" :disabled="!hasAnyAnswer" @click="submitAll">
        发送答复
      </el-button>
      <span v-if="!hasAnyAnswer" class="clarify-hint">点选选项或填写自由输入后可发送</span>
      <span v-else class="clarify-hint">答复将以消息形式发送给 AI</span>
    </div>
  </div>
</template>

<script setup>
/**
 * ClarifyCard.vue — Web 端结构化澄清问询卡（[DESIGN-ARCH-164] §5）。
 *
 * 后端 AskUserQuestion 控制请求经 SSE/WS 的 control_request 事件下发（事件通道
 * 已存在，此前只渲染成只读文本）。本组件复用 TUI questionCardModel 的数据形状
 * {questions:[{question,header,options,multiSelect}]} 渲染可交互卡片；答复经
 * answer 事件交由宿主（AIChat.vue）走既有发送通道回传给模型。
 */
import { computed, reactive, ref, watch } from 'vue';

const props = defineProps({
  /** control_request 事件的原始 payload（routes/ai.js SSE 转发形状） */
  payload: { type: Object, default: null },
});
const emit = defineEmits(['answer', 'dismiss']);

const questions = computed(() => {
  const req = props.payload && typeof props.payload.request === 'object' ? props.payload.request : {};
  const input = req && typeof req.input === 'object' ? req.input : {};
  const qs = Array.isArray(input.questions) ? input.questions : [];
  return qs
    .map((q) => ({
      question: String(q?.question || '').trim(),
      header: String(q?.header || '').trim().slice(0, 12),
      multiSelect: !!q?.multiSelect,
      options: (Array.isArray(q?.options) ? q.options : [])
        .map((o) => ({
          label: String(o?.label || o || '').trim(),
          description: String(o?.description || '').trim(),
        }))
        .filter((o) => o.label),
    }))
    .filter((q) => q.question && q.options.length > 0);
});

const visible = computed(() => questions.value.length > 0);

// 每张卡的选中态：单选为字符串,多选为数组;freeText 为自由输入兜底。
const picked = reactive({});
const freeText = reactive({});
watch(questions, () => {
  questions.value.forEach((_, qi) => {
    picked[qi] = q_multi(qi) ? [] : '';
    freeText[qi] = '';
  });
});
function q_multi(qi) {
  const q = questions.value[qi];
  return !!q && !!q.multiSelect;
}
function optLabel(opt) {
  return String(opt && opt.label ? opt.label : opt || '');
}
function optDescription(opt) {
  return String(opt && opt.description ? opt.description : '');
}
function isPicked(qi, label) {
  const cur = picked[qi];
  return Array.isArray(cur) ? cur.includes(label) : cur === label;
}
function pick(qi, multiSelect, label) {
  if (multiSelect) {
    const cur = Array.isArray(picked[qi]) ? picked[qi] : [];
    picked[qi] = cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label];
  } else {
    picked[qi] = label;
  }
}

const hasAnyAnswer = computed(() =>
  questions.value.some((_, qi) => {
    const cur = picked[qi];
    const free = String(freeText[qi] || '').trim();
    return free || (Array.isArray(cur) ? cur.length > 0 : !!cur);
  })
);

function dismiss() {
  emit('dismiss');
}

function submitAll() {
  if (!hasAnyAnswer.value) return;
  const lines = questions.value.map((q, qi) => {
    const free = String(freeText[qi] || '').trim();
    const cur = picked[qi];
    const ans =
      free ||
      (Array.isArray(cur) ? cur.join('、') : String(cur || '').trim()) ||
      '（未作答）';
    return `${qi + 1}) ${q.question} → ${ans}`;
  });
  const text = `【澄清答复】\n${lines.join('\n')}`;
  emit('answer', text);
}
</script>

<style scoped>
.clarify-card {
  margin: 8px 0;
  padding: 12px 14px;
  border: 1px solid var(--el-border-color, #dcdfe6);
  border-radius: 10px;
  background: var(--el-fill-color-light, #f5f7fa);
}
.clarify-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.clarify-title {
  font-size: 13px;
  color: var(--el-text-color-secondary, #909399);
  flex: 1;
}
.clarify-dismiss {
  border: none;
  background: transparent;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  color: var(--el-text-color-secondary, #909399);
}
.clarify-question {
  margin-bottom: 12px;
}
.clarify-q-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.clarify-q-text {
  font-size: 14px;
  font-weight: 600;
}
.clarify-multi-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
}
.clarify-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.clarify-option {
  text-align: left;
  border: 1px solid var(--el-border-color, #dcdfe6);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--el-bg-color, #fff);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.clarify-option:hover {
  border-color: var(--el-color-primary, #409eff);
}
.clarify-option.selected {
  border-color: var(--el-color-primary, #409eff);
  background: var(--el-color-primary-light-9, #ecf5ff);
}
.clarify-option-label {
  display: block;
  font-size: 14px;
  font-weight: 600;
}
.clarify-option-desc {
  display: block;
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
  margin-top: 2px;
}
.clarify-free-input {
  margin-top: 8px;
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--el-border-color, #dcdfe6);
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 13px;
  background: var(--el-bg-color, #fff);
  color: var(--el-text-color-primary, #303133);
}
.clarify-free-input:focus {
  outline: none;
  border-color: var(--el-color-primary, #409eff);
}
.clarify-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.clarify-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
}
</style>
