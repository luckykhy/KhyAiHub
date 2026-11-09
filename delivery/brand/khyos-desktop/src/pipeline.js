// main.js 的集成装载器按 src/pipeline.js 取渲染管线（与 director/models/audio
// 同级），实现本体在 src/render/pipeline.js。这一层只是路径适配，不含任何
// 逻辑——真正改动请去 render/pipeline.js。
export * from './render/pipeline.js';
