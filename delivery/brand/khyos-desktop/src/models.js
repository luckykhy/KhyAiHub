// main.js 的集成装载器按 src/models.js 取角色模组集合（与 pipeline/director/
// audio 同级），五个实现本体在 src/models/ 下。这一层只是路径适配，不含任何
// 逻辑——真正改动请去 models/ 下对应文件。id 与 src/story/cast.json 一一
// 对应，键合成 { [castId]: model } 的那一步在 main.js（导演要的形状）。
export { model as lampkeeperQue } from './models/lampkeeper-que.js';
export { model as inboxDing } from './models/inbox-ding.js';
export { model as paperMothJian } from './models/paper-moth-jian.js';
export { model as tortoiseDai } from './models/tortoise-dai.js';
export { model as inkEelYuan } from './models/ink-eel-yuan.js';
