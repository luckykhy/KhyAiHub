<!-- IMPL-STATUS: todo -->

# [DESIGN-ARCH-196] 手机侧沙箱直连通道架构选型

> **本文是选型记录 + 一次勘察的实测留档，不是实施计划。**
> 只回答「手机侧要怎么配合沙箱、凭什么、哪条路已经死了」。
>
> 本文的相当一部分价值在**纠错**：有五条原先承载结论的 `inferred`，
> 在 2026-10-29 用设备只读探针改写了，其中一条直接判死一个变体、
> 一条推翻 `findings/01` 的一条漏洞记录。**引用本文任何结论前，
> 先看 §二 的证据分级和 §六 的仍未验证项。**

---

## 〇、人的意愿（B6-1 可追溯）

| 时间 | 谁 | 要什么 |
|---|---|---|
| 2026-10-29 | 用户 | `/workflow-authoring`，参数是 Windows 搜索 URI，`crumb` 定位 `D:\Portable\openclaw-server`；诉求「**参照这个项目完善手机的配合**」 |

**「这个项目」是什么**：腾讯云那台 OpenClaw 沙箱（`openclaw` 2026.5.3，Debian 12）
**全部 84,793 个文件的本地完整镜像**，含 9 份勘察 findings、一次安全评估（11 项漏洞）、
Amoo APK 反编译成果。它的价值在于：把原来「必须问服务器或问 Amoo 才知道」的东西
变成了**本地可读**。

**「手机的配合」今天指四件事**，四件都不完善：

| # | 手机的配合 | 今天怎么做 | 不完善在哪 |
|---|---|---|---|
| 1 | 承载 khy-os App（桥 8896，42 工具） | App 内进程 | 本身是好的，纯回环（本次实测确认） |
| 2 | 唯一能进沙箱的入口 | **无障碍刮 Amoo 聊天屏**（`amoo_ask`/`amoo_result`） | Amoo 必须前台、屏幕常亮，一条问题约 6 分钟不能切走 |
| 3 | 被 adb 拽着 | 无线调试 | 每十几分钟掉一次；**本次实测确认当前就是无线**，换网段/AP 即断 |
| 4 | 中继地址的活体查询源 | **问 Amoo** → 手改 RELAY → 重跑 setup | 三步全靠人；Cloudflare 快速隧道域名一重建手机就瞎 |

第 2 条是主干病灶：**手机对沙箱没有任何直连通道**，所有命令都要经过聊天框打字和读气泡。

---

## 一、结论

本轮是勘察，**不是实施计划**。三个结论，一个待裁决。

### 1.1 一条变体已判死：「手机 App 驱动手机本地那套 OpenClaw」

`com.stepos.stepclaw` 在手机上跑着另一套 OpenClaw（127.0.0.1:18789）。
原先的设计念头是「手机 App 直连它，比刮 Amoo 屏好得多」。**本次实测把它判死**：

| 可编程面 | 实测结果 |
|---|---|
| `POST /tools/invoke` | **401**（无凭证）／**401**（假 Bearer，回同一句 `{"error":{"message":"Unauthorized","type":"unauthorized"}}`） |
| `GET /__openclaw/control-ui-config.json` | **401** |
| WS JSON-RPC | bundle 里有 `connect.challenge`（带 `nonce`）+ `CONTROL_UI_ORIGIN_NOT_ALLOWED` 两道闸 |
| 版本 | SPA 资产 `assets/index-DV4QBOU4.js` **≠** 本地镜像的 `assets/index-jOv_K1Xj.js` → **不是同一构建** |
| token | 只在 chroot 内 `openclaw.json` 的 `gateway.auth.token` 字段或 `OPENCLAW_GATEWAY_TOKEN`，shell uid `Permission denied` |

**每一个可编程面都在一把拿不到的 token 后面。** 不要再在它上面耗。
（免费能拿到的是 `/health`、`/healthz` 这类无凭证探针，适合做存活检测，不适合干活。）

**注意一个容易搞混的区分**：版本不符只否掉「外推到**手机本地**」。
镜像本身就是**沙箱**的 2026.5.3，所以从镜像 `dist/` 读出来的**沙箱网关**鉴权结论仍然有效。
两者不是一台机器、不是一把钥匙。

### 1.2 手机侧真正缺的是一件东西，不是三件

三个勘察维度各自提了一个「手机侧传输件」，其实是**同一个组件的三层**：

| 层 | 维度提法 | 是什么 |
|---|---|---|
| 传输 | 「wsproxy 的 Dart 版」（裸 WS 管道） | `dart:io WebSocket` / 已 lock 的 `web_socket_channel`，binary frame 原样收发 |
| 连接管理 | 「常驻出站连接器（地址配置 + 鉴权头 + 重连退避 + 断线续传）」 | 地址源、指数退避、心跳、Doze 恢复、**有界**缓冲 |
| 协议适配 | 「`POST /tools/invoke` + Bearer 的 HTTP 客户端」 | dio（已有 15 个文件在用）或 dartssh2 |

**合并成一件**：一个「沙箱连接器」，地址与凭据走同一个配置源，**且不是 `/sdcard` 信箱**（见 §四.0 第 3 条）。
现有的三条通道——桥（入站）、信箱（轮询文件）、反代（无障碍 IPC）——**一条都不覆盖「主动出站长连接」这个方向**。

### 1.3 待裁决：直连沙箱走哪条协议

见 §四。**推荐 A（SSH over WebSocket 直连中继）**，但 C 的可行性被本次分析修正了
（它的「循环依赖」论证不成立，见 §四.0 第 3 条），所以这是一个**真的分叉**，需要人点头。

---

## 二、证据表

### 2.1 本次设备实测（2026-10-29，全部只读）

adb 无线调试在线（`adb-ZYPZ261A01M6870010L-R9QdlL`，`192.168.2.46`）。
留档：探针输出在 `works/data/khy/T4-transient/tmp/phone-gateway-spa/`（含手机自己那份 SPA 的 13 个 chunk）。

| # | 事实 | 分级 |
|---|---|---|
| E1 | `POST 127.0.0.1:18789/tools/invoke` 无 Authorization → **401** | measured |
| E2 | 带假 Bearer 复测 → **401**，回 `{"error":{"message":"Unauthorized","type":"unauthorized"}}`；**文案不区分 `token_missing_config` 与 `token_mismatch`**，所以「配没配 token」这条问不出来，只能问出「要不要 token」= 要 | measured |
| E3 | `GET /__openclaw/control-ui-config.json` → **401**。连控制 UI 的配置都要鉴权 | measured |
| E4 | 手机 SPA 资产指纹 `assets/index-DV4QBOU4.js`，本地镜像（沙箱 2026.5.3）是 `assets/index-jOv_K1Xj.js` → **手机上那套与镜像不是同一构建** | measured |
| E5 | 手机自己的 bundle 里存在 `CONTROL_UI_ORIGIN_NOT_ALLOWED`（"origin not allowed (open the Control UI from the gateway host or allow it in…)"）与 `connect.challenge`（payload 带 `nonce`）→ Origin 闸 + 挑战应答两道都在 | measured |
| E6 | adb shell `curl 127.0.0.1:18789/` → **200**。`/proc/<pid>/ns/net` 虽是 Permission denied，但**这条更强**：若网关在独立 netns，adb shell 的回环根本到不了它。故网关在初始 netns，与 adb shell、与我们的 App 同一个 | measured |
| E7 | `ss -ltnp` **没有 10289**，HTTP 探针也无响应 → `findings/01 §1.4` 的「`0.0.0.0:10289` 绑所有接口、同 Wi-Fi 任何人可连」**在当前设备上不可复现**。且该条本就与同一文档的端口表自相矛盾（那条外联的本地端口是 41273） | measured |
| E8 | 绑在**所有接口**上的：`*:18765`（amoon 桥）与 `*:43199`（adb 无线调试 mDNS 端口）。我们自己的 8896 是 `[::ffff:127.0.0.1]:8896`，**纯回环，干净** | measured |
| E9 | `settings get global adb_wifi_enabled` = `1`，两个 transport 都是 `_adb-tls-connect._tcp` → **8896 主链当前是无线 adb** | measured |
| E10 | 18790 / 18791 / 18800 / 8900 全部只绑回环（`[::ffff:127.0.0.1]` 或 `127.0.0.1`），无 Lan 暴露 | measured |

### 2.2 静态读本地镜像（measured，含行号）

勘察共 8 个 agent、6 个维度、153 条事实，全部为静态阅读，**零设备、零服务器、零网络**。
完整记录在工作流 journal。此处只列承重结论：

| # | 事实 | 来源 |
|---|---|---|
| S1 | 中继是**裸字节透传**，无应用层信封：`read(65536)` → binary frame，客户端 payload 原样写 TCP。握手只要 `sec-websocket-key` + `upgrade: websocket`，**不校验 Origin、不校验 path、无 token** | `access-path/relay.py:60-81,117-123,167-169` |
| S2 | 连上后服务器不发任何应用层数据，第一个字节就是 sshd 的 `SSH-2.0` 标识串 | `relay.py:141-153`；`_server-mirror/tmp/sshv.txt:21-23` |
| S3 | `MAX_PAYLOAD = 16MB`（`relay.py:23,96-97`）。复刻客户端的人必须知道这个上限 | `relay.py` |
| S4 | **PC 侧那个坑必须在手机侧重写一遍**：SSH 客户端在 WS 握手完成前就吐 banner，若 readyState != OPEN 时丢弃首写，服务端永远看不到客户端 banner，表现为 `Connection timed out during banner exchange`。正确做法是握手期间缓存上行字节，open 后补发 | `tools/ssh-relay.js:53-64,99-107` |
| S5 | `tools/ssh-relay.js:56,104-105` 的 `pending` 是**无界数组**。维度 1 建议「复用这个 open 前缓冲逻辑」——照搬会把无界缓冲搬到 Android 上，就是 OOM。**必须有界** | `ssh-relay.js` |
| S6 | 沙箱网关：`POST /tools/invoke` 是唯一「永远开启、无需改配置」的可编程 REST 面，默认 body 上限 2MB。`gateway.tools.allow:["nodes"]` 把 `nodes` 从默认拒绝名单里放了出来，而 HTTP bearer 在这套语义里等于全 operator | 镜像 `dist/server.impl-*.js` |
| S7 | App 侧**零** WebSocket 客户端在用；`web_socket_channel ^3.0.1` 已在 `pubspec.yaml:34` 声明、lock 解析 3.0.3，但 `lib/` 下零 import。dio 已 15 个文件在用 | `pubspec.yaml`、`pubspec.lock:1104-1111` |
| S8 | App 侧**零** `ConnectivityManager`/`NetworkCallback`；`MainActivity.kt:1719-1721` 注释明写「只加 FLAG_KEEP_SCREEN_ON，**不碰 WakeLock**」。现有重连只有两处且都不是长连接 | App 源码 |
| S9 | `HttpBridge.java:159-181` 的 `ensureToken` 只在内存为空时读盘并采纳任何形状合法的 32-hex 值，**无完整性校验**；`writeTokenOnce`（`:241-259`）是裸 `FileOutputStream`，无 `setReadable(false)`/Keystore 封装；token 从生成起永不变、一把开全部 42 个工具 | App 源码 |
| S10 | `amoo_ask` 的全部定位依据是 `com.stepos.ailauncher:id/chat_list`、`id/et_input_bar` 等资源 id，而 App **从不查** launcher 版本 → 一次 OTA 改掉一个 id，`amoo_ask` 从「可用」静默变「不可用」 | `AmooChatText.java:75`、`AmooSafe.java:181`、`BridgeService.java:290` |
| S11 | `DEVICE_SIGNATURE_SKEW_MS = 120 * 1e3`（`dist/message-handler-*.js:509`）→ 手机刚重启未完成 NTP 同步时，WS 设备配对以「签名不符」形态失败，错误信息不指向时钟。**只咬 WS 路径**，HTTP 路径不做设备签名 | 镜像 `dist/` |

### 2.3 本次分析改写掉的五条 `inferred`

| 原 claim | 原分级 | 实测后 |
|---|---|---|
| 「App 能连 127.0.0.1:18789」（支撑「手机 App 驱动本地网关」整条路） | inferred（唯一支撑是一次历史观测：8896 只绑回环却从 adb shell 拿到 401） | **成立，但路是死的**：E6 证明可达，E1/E3/E4/E5 证明每个面都要拿不到的 token |
| 「`0.0.0.0:10289` 同 Wi-Fi 任何人可连」 | findings/01 记为实测 | **当前不可复现**（E7）。从漏洞清单降级 |
| 「换网段对绝大部分链路无害，真正脆的是 8896 主链」 | inferred | **确认**（E9）：主链当前就是无线 adb |
| 「维度 2/5 的鉴权结论可外推到手机本地网关」 | inferred（自称证不到版本） | **否**（E4）：不同构建 |
| 「选项 C 有循环依赖」 | inferred | **否**，见 §四.0 第 3 条 |

---

## 三、缺口表（按严重度 × 可行性）

| # | 缺口 | 证据 | 修复面 |
|---|---|---|---|
| G01 | 手机侧没有任何「主动外连 + 长连接」的传输件 | S7 S8（measured） | **App 代码**。不引新依赖 |
| G03 | 中继地址没有「与隧道无关」的发现端点，手机只能等 | `watchdog.sh:24-42`；`setup-nginx.cjs` 的 8080 站点只反代 18789，无 `/url` 端点（measured） | **沙箱**（nginx 8080 加一个返回 `/opt/relay-ws/url.txt` 的端点，或换 Named Tunnel）+ **App 配置** |
| G07 | 桥 token 明文落 `/sdcard`、无 scope/过期/轮换、磁盘令牌可被投放 | S9（measured） | **App 代码**（挪私有目录 + Keystore MAC + 采纳前验 MAC + 24h 过期 + 按 scope 拆钥匙）+ **操作**（轮换一次） |
| G09 | 长连接在 MIUI/Doze 下的存活完全未验 | S8（measured）；**这一项没有任何本地文件能替代实测** | **App 代码** + **设备实测**（`dumpsys deviceidle force-idle` 后复测） |
| G11 | `amoo_ask` 的全部定位依据会随一次 launcher OTA 静默失效 | S10（measured） | **App 代码**（找不到元素时 fail-loud + 对端版本探测）；**不可完全修**（第三方 UI 契约） |
| G05 | 手机本地网关 token 是硬墙 | §1.1 全表（measured） | **不可修**。只保留无凭证探针 |
| G08 | 云端身份不可见、不可撤销，服务端存着手机设备私钥 | `devices.json` 的 `mapping.private_key`/`public_key` 字段同时存在（键名 measured）；App 无任何 keypair 代码（measured） | **平台侧（只能提）** + **手机侧**（云→手机的高权动作加本地二次确认） |
| G10 | 网络切换/漫游无感知，且最脆的是无线 adb 主链 | E9 + S8 | **App 代码**（网络状态感知 + 重连）+ **设备实测** |
| G12 | 中继零鉴权暴露在公网，sshd 侧零收紧 | S1；`sshd_config.d/` 为空、`PasswordAuthentication` 等全是 Debian 注释默认（measured）；`sshd -T` 实际生效值**未跑** | **沙箱**（relay 加 Origin + 共享密钥、或 Named Tunnel + Access；sshd 收 127.0.0.1） |
| G13 | TCP-over-TCP、无界 pending 缓冲、中继无配额 | S3 S5；TCP-over-TCP 塌方是 inferred（**零实测**） | **App 代码**（有界缓冲 + 背压）+ **沙箱**（限速） |
| G15 | 出机内容的隐私/合规边界无人问 | `shot`/`ui_dump` 读整屏含其他 app，经 `amoo_ask` 上云；`AmooSafe.java:178-179` 的净化只发生在回写文本上（measured） | **操作/平台**。本轮只建清单 |

---

## 四、架构选项

### 4.0 先消解三处会让人做错事的矛盾

1. **不要用 OkHttp**：它完全不在依赖里（app 级 gradle 只有 shizuku + junit + org.json）。
   按字面动手会先撞一次「这库根本没有」。**用 dio**。
2. **两个网关、两把钥匙，不要混**：沙箱的 `gateway.auth.token` 打的是沙箱 18789，
   不是手机本地 18789。手机本地网关不认沙箱的 token，沙箱网关从手机侧不可达（要经隧道/nginx 8080）。
3. **选项 C 的「循环依赖」论证是错的**：原论证说「送 token 需要一条通道，而这正是要建的东西」。
   但**一次性 adb provision 今天就是存在的**——整条工作流本来就依赖 adb（PC 有 adb、桥本身就依赖 adb、
   `MIUI USB 安装限制绕过` 已成惯例）。用它把凭据送进 App 私有目录 + Keystore 封装，
   **对 SSH 私钥和 gateway token 同样成立**。原分析对两者用了两套标准：对私钥说「不构成循环依赖」，
   对 token 说「循环依赖」。**这是本文最重要的修正。**

### 选项 A：手机侧直连沙箱中继（SSH over WebSocket）

- **组成**：§1.2 那个连接器的三层——`dart:io WebSocket` 连 `wss://<域名>/` 裸收发 +
  连接管理（**有界**缓冲、退避、心跳、Doze 恢复）+ 纯 Dart `dartssh2`（自定义 transport 直接吃
  WebSocket 的 StreamChannel，连本地 Socket 都不需要）。
- **必须为 measured 的前提**：①手机能出网到中继域名（公网 443）；②服务器侧有稳定地址源（G03）；
  ③手机持有一把被沙箱 `authorized_keys` 接受的私钥且能安全落 App 私有目录；④Doze 下前台服务仍能出网或连接可恢复（G09）；
  ⑤移动端能完成 RFC6455 握手并读到 `SSH-2.0` banner。
- **必须避开的坑**：S4（open 前缓存上行字节）、S5（不许照搬无界缓冲）、S3（16MB 上限）。
- **风险**：SSH 客户端库的攻击面；私钥在手机的保管；TCP-over-TCP 弱网吞吐（unverified）；
  中继零鉴权在 A 打通后暴露更大，须并行加 Origin + 共享密钥。
- **解决**：G01 G02 G03 G04 G09 G10 G13(缓冲) G14（本路线无设备签名，天然免疫 120s 时钟闸）。

### 选项 B：只做地址自动发现 + 健康检查，动作仍走 `amoo_ask`

- **组成**：一个轻量 discoverer + 状态展示，不做任何新的动作通道。
- **前提**：同 A②；`amoo_ask` 继续可用（赌 launcher 资源 id 不变，G11）。
- **风险**：最低——无新攻击面、无密钥、无新依赖。
- **不解决** G01 G02 G04 的功能缺口，只是让它们可见。
- **定位**：**A 的第一个里程碑，不是终局。**

### 选项 C：HTTP `POST /tools/invoke` 打沙箱网关

- **组成**：dio 客户端 + token 保管（Keystore）+ 调用封装，body 形如
  `{"tool":"nodes","action":"invoke","args":{node,invokeCommand:"ability.call",invokeParamsJson,invokeTimeoutMs}}`。
- **前提**：①沙箱 `gateway.auth.token` 经一次性 adb provision 安全到手机（§4.0 第 3 条，**可行**）；
  ②沙箱 18789 对手机可达（经隧道/nginx 8080）；③`gateway.tools.allow` 放行 `nodes`、
  `nodes.allowCommands` 收窄到 `stepclaw.exec`/`ability.call` 在沙箱侧保持；
  ④「共享 bearer = 全 operator」的公网暴露可接受；⑤每次调用经 security-guard 在线裁决可接受。
- **风险**：token 等于沙箱 RCE + 手机 ability 执行权；审计码 `gateway.tools_invoke_http.dangerous_allow`
  正针对 `gateway.tools.allow` 这一条；能力面只有 `ability.call`/`stepclaw.exec` 子集；
  多一个在线裁决依赖（security-guard 同步调云侧安审）。
- **解决**：G01(部分) G03(部分)。**解决不了** G02（但 G02 是「自己写 SSH」的成本，C 不需要它）。

### 推荐：A，但把 C 从「留作后续」改成「同一次裁决的二选一」

**为什么不是 B**：它不消除 `amoo_ask` 的前台锁和「问 Amoo 拿地址」这一跳，只让它们可见。
要的是手机侧能配合干活，不是更好的监控。B 的全部价值已被 A 的 M1 吸收。

**为什么是 A 而不是 C**（这条论证在 §4.0 第 3 条之后变弱了，如实记下）：
A 的优势只剩「给的是完整 shell，能力面不是 C 的真子集」和「A 建成后正好能安全投递 C 需要的 token」。
C 的优势是**代码量小一个量级**（dio 已有，无新依赖、无 SSH 客户端库的攻击面），
且它走 nginx 8080 而不是那条零鉴权中继。

**两者共同的硬前置是 G03（稳定地址源）和 G04（凭据安全到手机）**，而这两个都不选边。
所以正确的顺序是：**先把 G03 + G04 做掉，再用一次真机探针在 A/C 之间定边**，
而不是现在就把 A 定死。

---

## 五、仍未验证（按代价从低到高，全部只读）

| # | 验什么 | 怎么验 | 不过则怎样 |
|---|---|---|---|
| V1 | ~~手机本地 18789 的 `auth.mode`~~ | — | **已验（E1/E2）：要 token** |
| V2 | ~~App 能否连本地网关~~ | — | **已验（E6）：能连，但路死（§1.1）** |
| V3 | ~~手机那套的版本指纹~~ | — | **已验（E4）：不同构建，不可外推** |
| V4 | ~~8896 主链 USB 还是无线~~ | — | **已验（E9）：无线** |
| V6 | ~~10289 归属与误读~~ | — | **已验（E7）：当前不在听，findings 那条降级** |
| V5 | Doze 下前台服务是否仍能出网 | `adb shell dumpsys deviceidle force-idle` 后复测 8896 可达性与一条新出站连接 | 被断网且不可恢复 → A 与 C 都要追加保活成本，严重度升但不致死 |
| V7 | 提示词包截断标记：代码还是文档旧 | 读 `AmooMemory.java:233-262` 与 `AmooLoop.java:1510-1519`，对照 `AMOO-INTEGRATION.md:153` | 代码已有标记 → 「把注入包固定成单独一行一个 JSON」针对的是不存在的问题 |
| V8 | `relay.log` 那 5 条 handshake failed 的明细 | 读 `access-path/logs/relay.log` 全文（此前只 grep 了计数） | 是扫描器 → G12 紧迫度升，M1 之前必须先给 relay 加 Origin + 共享密钥 |
| V9 | 三份 `relay.py` 副本是否同步 | 比对 `access-path/relay.py`、`_server-mirror/opt/relay-ws/relay.py` 与 findings 引用的行号 | 不同步 → 行号引用不可混用，A 的协议复刻要以正本为准 |
| V10 | **A 的核心前提**：经中继能读到 SSH banner | 服务器侧环回跑现成的 `access-path/wscheck.py`（或等价 curl） | 读不到 → **A 出局** |
| V11 | sshd 实际生效值 | 服务器侧 `sshd -T \| grep -Ei 'passwordauthentication\|permitrootlogin\|allowtcpforwarding\|maxstartups'` | 密码登录真开 + root 可登 → G12 必须先于 M1 修 |
| V12 | Termux `RUN_COMMAND` 是否真不可得 | 复测 `pm grant` 的返回与 Termux 实际启动方式 | 若可得 → 「借用现成 ssh」可行，A 的 M2 可省掉整个 dartssh2，成本大降 |
| V13 | 弱网下中继吞吐与稳定性 | 手机经 4G/弱 Wi-Fi 打一次，与服务器环回裸 ssh 对比 | 吞吐塌方 → A 可用但仍需限预期，不影响选型 |
| V14 | 手机能否出网到中继域名 | 手机侧跑一次 WS 握手探针（等价 `wscheck.py` 的移动端复刻） | 连不上 → A 与 C 都要先解决出网，选型推迟 |

---

## 六、本次明确不做

1. **不改任何文件**：本轮勘察 + 实测，除本设计与探针留档外零写入。
2. **不碰 `com.stepos.ailauncher` / `com.stepos.stepclaw`** 的任何文件、配置与进程——不是我们的 App。
3. **不再投入「拿手机本地网关 token」**：chroot 无 root 是硬墙（§1.1 measured）。
4. **不打 `stepos.com` 官方端点**：缺动态 Bearer，「只带静态 appId/apiKey 是否被拒」从未验证，无业务需要。
5. **不引 OkHttp、不新增原生依赖**：不加 `third_party/` + bootstrap + CMake `FATAL_ERROR` + JNI shim 这一套。
   `web_socket_channel` 与 dio 已够。若要加原生库另立专项，并注意 release 的 cxx 配置是旧的。
6. **不动服务器生产配置**：relay 加固、sshd 收紧、8080 端点、Named Tunnel 全部单独立项。
7. **不做顺手重构**（B3）：G07 的 token 改造只做「挪位置 + 验 MAC + scope + 过期」四件事。
8. **不做版本号决策**（B7）：本文所有里程碑编号是工作项，不是 MINOR/MAJOR。

---

## 七、R2 自检

本文引用均为**文件名 + 字段名/行号**（如 `openclaw.json` 的 `gateway.auth.token` 字段、
`devices.json` 的 `mapping.private_key`/`mapping.public_key` 字段、`/opt/relay-ws/url.txt`），
未出现任何密钥 / token / 口令 / appId / apiKey 原文，亦未引用快速隧道域名。
§2.1 为复现探针记了一次 adb 无线调试串与局域网 IP——那是**设备标识不是凭据**，
且 `findings/01 §1.1` 本就公开记录同一硬件序列号；除此之外无任何设备 ID。
设备探针输出全部落在 `works/data/khy/T4-transient/tmp/`（B8 规定的临时目录）。
