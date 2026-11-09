// main.js 的集成装载器按 src/director.js 取导演模块（与 pipeline/models/audio
// 同级），实现本体在 src/director/director.js。这一层只是路径适配，不含任何
// 逻辑——真正改动请去 director/director.js。
export * from './director/director.js';
