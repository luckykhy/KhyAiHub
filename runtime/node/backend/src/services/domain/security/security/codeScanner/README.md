# index

D2 功能单元（单源文件）。以下职责描述**逐字摘自 `index.js` 的块注释头**，未做二次概括：

> Code Scanner — Extract and scan code blocks from AI responses. Aligned with ANOLISA Agent Sec Core code scanning: - Extracts code blocks (fenced + inline) from AI output

## 谁在用（解析后的 require 图，非字符串命中）

- `services/backend/src/services/security/index.js`
- `services/backend/src/tools/securityScan.js`

## 状态

本目录由入口缓冲批量登记器生成，`lifecycle.stage = staged`：它只声明「已进缓冲区并有可用记录」，
**不等于人工晋级**（晋级需人复核 contract 段与三判据）。原始判据见 [RESEARCH-018] §4 C-5 与 [DESIGN-LAY-008] §12.45。
