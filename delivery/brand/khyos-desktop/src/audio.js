// main.js 的集成装载器按 src/audio.js 取配乐模块（与 pipeline/director/models
// 同级），实现本体在 src/audio/audio.js、编排数据在 src/audio/score.json。
// 这一层只是路径适配，不含任何逻辑——真正改动请去 audio/audio.js。
export * from './audio/audio.js';
