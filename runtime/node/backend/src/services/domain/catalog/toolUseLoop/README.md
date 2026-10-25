# toolUseLoop — 工具循环守护单元

谁要：`services/tool/toolUseLoopCore.js`（运行时工具循环内核）需要一组**零 IO、确定性**的
判定叶子，把「这一轮该不该继续调工具」的判断从内核里拆出来单独可测。

为什么：循环失控（重复同一调用、预算耗尽后仍继续、取消信号发出后仍推进）在历史上是
工具循环最贵的一类缺陷，而它们都能在纯函数层判掉。本单元因此只放纯判定与纯状态，
不含任何 IO / 网络 / 落盘——IO 归 `toolUseLoopCore.js`。

怎么验：13 个源文件各有同名同目录测试（`*.test.js`），
`node --test runtime/node/backend/src/services/domain/catalog/toolUseLoop/*.test.js`。
生命周期记录见同目录 `khy.module.json`（domain=D2，stage=stable）。
