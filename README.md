# pi-provider-workbuddy

<p align="center">
  <b>把本机登录的 WorkBuddy（CodeBuddy）模型接入 pi —— 国内版与国际版两个 provider 并行注册，OAuth 扫码登录，模型目录带真实积分倍率，只读积分查询，国内版每日签到。</b>
</p>

---

## 功能

- **双区域并行接入**：`workbuddy`（国内版，`copilot.tencent.com`）与 `workbuddy-global`（国际版，`workbuddy.ai`）同时注册，各自持有凭据、目录与模型，互不干扰。哪个区域有账号，哪个区域的模型就出现在 pi 的模型选择器里。
- **登录即用**：`/login` 一条命令完成扫码（国内版）或网页登录（国际版），无需手动配置 API key。
- **自动发现桌面端登录**：已安装 WorkBuddy 桌面 App 的机器上，插件自动读取它的登录状态（**始终只读**，永远不会改动桌面端的凭据）。Windows 新版桌面端加密的凭据字段，通过调用已安装 App 自身的解密能力读取；App 未安装时如实报告，不会谎报「未登录」。
- **按桌面客户端重做请求层**：使用 WorkBuddy 桌面 CLI 的客户端归属头、User-Agent、OpenAI SDK 指纹，以及稳定的会话 ID / 用户发送 ID / 每请求消息 ID；一次工具循环仍只算一次用户发送。
- **按模型选择协议**：国内版 Claude 走 Anthropic Messages（`/v1/messages`），其余模型与国际版全部走 Chat Completions（`/v2/chat/completions`）。
- **模型名内嵌积分倍率**：模型显示为 `GLM-5.3 · x0.79` 这样的形式，倍率完全来自上游目录，插件不写死也不猜。
- **只读积分查询**：`/workbuddy.status` 查看两个区域的登录状态、token 有效期、积分余额，以及国内版**今天有没有签到**，不花积分。
- **每日签到**：`/workbuddy.sign` 领取国内版（WorkBuddy CN）的每日签到积分。先查活动状态，活动进行中且今天未领才领取——重复执行不会重复领，也不会把「今天已签」报成失败。
- **工具调用恢复**：上游偶尔把工具调用写进正文文本而不是结构化字段，插件按严格的四道闸（已闭合、名字已声明、请求有工具、无缺参）把它恢复成真正的工具调用；不满足条件的原样展示，从不猜测。
- **错误说得清楚**：排队时告诉你排在第几位；积分耗尽、模型负载高、登录失效各有各的提示，不把「模型忙」说成「余额不足」。

> **⚠️ 风险提示**：WorkBuddy 已开始限制非官方客户端请求，上游一旦收紧，本插件可能随时失效。每一次调用都消耗**你自己账号**的积分，按上游给出的倍率真实扣费——插件不提供账号、不共享凭据、不绕过计费。使用官方 WorkBuddy 客户端始终是最安全的选择，请自行评估账号风险后再安装。

## 安装

**方式一：从 npm 安装（推荐）**

```bash
pi install npm:pi-provider-workbuddy
```

**方式二：从 GitHub 安装**

```bash
pi install git:github.com/lorlike/pi-provider-workbuddy
```

安装完成后重启 pi（或运行 `/reload`），然后运行 `pi list` 确认 `pi-provider-workbuddy` 出现在列表里。

## 快速开始

### 1. 登录

两个 provider 都已注册，用 pi 的 `/login` 选择对应入口：

```text
/login workbuddy          # 国内版：弹出链接，浏览器打开后扫码
/login workbuddy-global   # 国际版：弹出链接，浏览器打开后网页登录
```

登录窗口会自动打开授权页；被浏览器拦截时复制链接手动打开即可。完成后插件自动拿到凭据并刷新模型目录。

> 也可以什么都不做：如果本机已登录 WorkBuddy 桌面 App，插件启动时会自动发现该账号。

### 2. 选模型

`/model` 里找 `WorkBuddy (CN)` 或 `WorkBuddy AI (Global)` 分组，模型名后面的 `· x0.79` 就是积分倍率。

没有账号的区域不会列出可发起请求的模型——列出来也只会点到就失败。登录对应区域后模型自动出现。

### 3. 日常命令

| 命令 | 说明 |
| --- | --- |
| `/workbuddy.sign` | 国内版每日签到（领今日积分）；已签到 / 活动未开启会如实说明 |
| `/workbuddy.status` | 登录状态、凭据来源、token 有效期、积分余额，以及今日签到状态（只读） |
| `/workbuddy.refresh` | 从上游刷新模型目录并重载 |
| `/workbuddy.logout [cn\|global]` | 清除插件自己存的凭据（不影响桌面端登录）；不带参数默认清两个区域 |

## 请求身份与模型路由

请求头不是只为了“能返回 200”。WorkBuddy 的用量后台依靠这些值识别使用端、会话和一次用户发送；缺字段时会归到空客户端，ID 不稳定时则会把同一次工具循环拆成多次请求。

### 使用端与客户端身份

| 请求头 | 值 | 作用 |
| --- | --- | --- |
| `User-Agent` | 国内版 `WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0`；国际版 `WorkBuddy/5.9.3 workbuddy-ai/5.9.3 CLI/2.165.0` | 声明桌面 CLI 客户端 |
| `X-IDE-Name` / `X-IDE-Type` | `WorkBuddy` | 使用端显示为 WorkBuddy |
| `X-IDE-Version` | `5.9.3` | 客户端版本 |
| `X-Agent-Purpose` | `conversation` | 请求属于对话 |
| `X-Agent-Intent` | `craft` | 桌面客户端的 agent 意图 |
| `X-Agent-Type` | `main` | 主对话 agent |
| `X-Agent-Runtime` | `local-agent` | 本地 agent 运行时 |
| `X-Product` | `SaaS` | 产品通道 |
| `X-User-Id` / `X-Domain` | 当前账号 | 账号与登录域 |
| `X-Enterprise-Id` / `X-Tenant-Id` | 当前企业 | 仅在当前账号有企业 ID 时发送 |
| `X-Stainless-*` | OpenAI `6.25.0` / Electron Node `v22.21.1` | 声明桌面客户端内置 SDK 指纹 |

宿主 SDK 自带的 `Authorization`、`x-api-key`、User-Agent、浏览器标记和 `X-Stainless-*` 会在最终发请求前被清除；真实的 `Authorization` 与 WorkBuddy 桌面身份头再统一写入。Messages 路由的 `anthropic-beta` 等协议头会保留。

### 三个 ID 与计费计数

| 请求头 | 生命周期 | 规则 |
| --- | --- | --- |
| `X-Conversation-ID` | 整个对话 | Pi 有 `sessionId` 时由它稳定派生；否则由第一条真实用户消息派生。两者都没有时不发送，绝不临时编造 |
| `X-Conversation-Request-ID` | 一次用户发送 | 用户发出这条消息后，所有工具调用回传、工具结果图片、重试都复用同一个值；用户发下一条消息时生成新值 |
| `X-Conversation-Message-ID` / `X-Request-ID` | 一次 HTTP 请求 | 每次 HTTP 请求都新生成，两个头始终相同 |

因此，**一次工具循环不是多次用户发送**。WorkBuddy 后台按 `X-Conversation-Request-ID` 把整段循环计为一次请求；只有用户真正发送下一条消息，或发出无法归属到具体用户消息的请求时，才会出现新的计数。

ID 由进程内随机盐、账号作用域、会话标识和用户消息签名派生：相同消息在不同账号下不会复用同一 ID，消息原文也不会以明文出现在 ID 中。

### 协议路由矩阵

| 区域 | 模型 | 协议 | 终结点 | 请求体 |
| --- | --- | --- | --- | --- |
| 国内版 | 模型 ID 以 `claude-` 开头 | Anthropic Messages | `/v1/messages` | 保持 agent 的 Messages 结构；不 gzip；只删除无签名 thinking |
| 国内版 | 其他模型 | Chat Completions | `/v2/chat/completions` | 强制 `stream: true`；按桌面客户端行为 gzip |
| 国际版 | 所有模型，包括 Claude | Chat Completions | `/v2/chat/completions` | 强制 `stream: true`；按桌面客户端行为 gzip |

只有国内版提供 `/v1/messages`；把国际版 Claude 发到 Messages 只会得到 404。国内版 Claude 在 Messages 上额外开放 `max` thinking 档，并映射为 Anthropic 的 `output_config.effort`。

客户端版本目前按已测得的桌面端固定为 WorkBuddy `5.9.3` / CLI `2.165.0`。上游升级后应同步更新 `src/upstream.ts` 与 `src/wire-headers.ts` 中的版本常量。

### 签到（目前只有国内版）

```text
/workbuddy.sign      # 领取今天的签到积分
/workbuddy.status    # 看今天签到了没有
```

行为说明：

- **先问状态再领**：`/workbuddy.sign` 先查活动状态（`checkin-activity-status`，旧端点 `checkin-status` 作后备），活动进行中且今天未领才调 `daily-checkin`。所以它**幂等**，一天跑几次都只有第一次真正领取。
- **按北京时间算一天**：签到日以 UTC+8 划分（固定偏移，不依赖系统时区数据库）。
- **如实报告**：上游会区分「已签到（code 1001）」「账号不能参与（1002）」「活动已结束（1003）」，插件照原样转述，不把拒绝说成网络失败。
- **本地只记结论**：结果写在 `~/.pi/agent/workbuddy/workbuddy-checkin.json`，只存「哪天 / 结论 / 积分 / 连签天数」，**不存昵称也不存 token**。上游查不到状态时，`/workbuddy.status` 只会显示**当天**的本地记录，并明确标注是本地记录——没看到的一天绝不会被说成「已签到」。
- **国际版没有这个活动**：上游国际版出厂即关闭签到，`/workbuddy.sign global` 会直接说明，不浪费一次请求。

## 常见问题

**Q：启动时报「No API key found for workbuddy」？**

还没有登录。运行 `/login workbuddy`（国内版）或 `/login workbuddy-global`（国际版）。这是 pi 对未认证 provider 的标准提示，不代表插件没装好。

**Q：桌面端明明登录了，插件却说未登录？**

运行 `/workbuddy.status`，未登录区域会列出探测过的每一条路径和跳过原因（不存在 / 读不了 / 字段已加密拿不到密钥 / 属于另一个地区）。常见情况：

- **字段已加密且拿不到密钥** → 需要已安装的 WorkBuddy 桌面 App 在场（插件通过它自身的解密能力读凭据），确认 App 已安装且版本较新；
- **属于另一个地区** → 登录信息是真实可用的，只是挂在另一个区域下，用对应的 `/login` 入口即可。

**Q：国际版报错「该账号属于国内版」或反过来？**

两个区域的凭据互不通用（国际版还有 `workbuddy.ai` 与 `codebuddy.ai` 两个品牌域名的区分），请用对应区域的 `/login` 入口重新登录。

**Q：模型请求返回渠道校验错误（code 11128）？**

这是上游网关对请求内容的指纹校验，与账号、积分、网络都无关，换账号也不会改变结果。插件已对已知的第三方 agent 提示词做归一化处理；如果仍被拦截，请到 [Issues](https://github.com/lorlike/pi-provider-workbuddy/issues) 反馈。

**Q：插件会把我的凭据传到哪里？**

凭据只在本机流转：桌面端文件只读，刷新得到的 token 写在 `~/.pi/agent/workbuddy/` 下，请求只发往 WorkBuddy 自己的网关。插件没有任何遥测，也不经过任何第三方服务器。

## 工作原理

```text
pi（openai-completions 内建实现）
  → 自定义 fetch 覆盖层：
      · prepareChatBody：强制 stream:true、tool_choice 压平、
        developer→system、保证 system 头、已测得的渠道指纹前置中性头
      · WorkBuddy 头：Bearer token、桌面客户端归属、CLI UA、
        X-User-Id / X-Enterprise-Id / X-Domain
      · 会话 ID、用户发送 ID、每请求消息 ID 分层生成
      · Chat 请求 gzip；CN Claude 改走 Anthropic Messages 且不 gzip
  → 国内版 https://copilot.tencent.com/v2/chat/completions
    国际版 https://www.workbuddy.ai（或 codebuddy.ai，按凭据域路由）
  → SSE 流过 DSML 恢复缓冲（见「功能」第 6 条）
  → 错误分类：排队（6020-6022，报位次并禁止无意义重试）、积分耗尽（14018）、
    模型负载（14003，可自动重试）、会话失效（12153）、账号受限（11140 + 措辞）、
    渠道指纹（11128）、上下文超长（11115 → pi 可识别的溢出标记，触发压缩自救）

模型目录：/v3/config（App 通道 UA；国内版失败时降级 /v2 旧文档）
积分查询：/v2/billing/meter/get-user-resource（企业席位走企业表）
每日签到：/v2/billing/meter/checkin-activity-status → /v2/billing/meter/daily-checkin（国内版）
```

更多实现细节：

- **思考档位**：只映射上游为该模型声明过的档位；`off` 档位只在模型声明可关闭思考、且不在实测拒绝名单（9 个模型对 `reasoning_effort: "off"` 回 400，勾上等于每次压缩摘要都失败）时提供。
- **图片输入**：按厂商文档核验表判定，而不是上游平台侧的 `supportsImages` 声明（真实数据里它对纯文本模型也是 `true`）；未核实的模型不声明 image 输入。
- **上下文超长**：上游 11115 的错误信息是中文而 pi 的溢出检测读英文，错误消息前置 `prompt is too long (upstream code 11115)`，让 pi 的压缩自救能触发。

## 从源码构建

```bash
git clone https://github.com/lorlike/pi-provider-workbuddy.git
cd pi-provider-workbuddy
npm install
npm run typecheck   # 类型检查
npm test            # 11 个单元/最终请求集成测试
npm run build       # 构建到 dist/
```

## 致谢

上游协议（端点、线格式、错误码、渠道闸、DSML 恢复的四道闸纪律）与大量实测结论来自 [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)（MIT），该项目致谢 corrinehu/dsh-workbuddy-connect、Sliverkiss/workbuddy2api 与 hawklithm/workbuddy2api（均 MIT）。感谢这些项目的作者把测量记录写得如此完整。

## 免责声明

本项目与腾讯 / WorkBuddy / CodeBuddy 官方没有任何关联，也不是官方客户端。使用本插件产生的一切账号后果（限流、限制、封禁等）由使用者自行承担。

## License

[MIT](LICENSE)
