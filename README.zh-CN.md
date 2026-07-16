<div align="center">

# pi-approval-guardian

**为 Pi 提供 fail-closed、Codex Guardian 风格的自动审批门。**

在执行前，通过隔离 reviewer model 审查所有 agent 发出的 `bash`，以及项目外或敏感路径的 `write`、`edit`。

[![npm version](https://img.shields.io/npm/v/pi-approval-guardian.svg)](https://www.npmjs.com/package/pi-approval-guardian)
[![CI](https://github.com/mics8128/pi-approval-guardian/actions/workflows/ci.yml/badge.svg)](https://github.com/mics8128/pi-approval-guardian/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](README.md) · [繁體中文](README.zh-TW.md) · **简体中文** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

</div>

> [!IMPORTANT]
> Pi extension 会以你的用户权限执行。安装前请检查源码。本包是审批门，不是操作系统 sandbox。

## 为什么需要它

Coding agent 需要 shell 权限，但可能误解范围、受到不可信输出的 prompt injection、选择破坏性实现，或修改用户未授权的敏感文件。

```text
Pi agent tool call
  ├─ 普通项目内 source edit ─────────────────► 正常执行
  └─ bash / 敏感 write / 敏感 edit
                  ▼
       隔离的 Guardian reviewer
       仅启用 read · grep · find · ls
                  ▼
       只有明确 allow 才执行；其他全部阻止
```

Reviewer 分别判断动作的内在风险和用户授权。只有有效的 `{"outcome":"allow"}` 才会放行。

## 快速开始

```bash
pi install npm:pi-approval-guardian
```

仅安装到当前项目：

```bash
pi install -l npm:pi-approval-guardian
```

创建 `~/.pi/agent/approval-guardian.json`：

```json
{
  "model": "llm-esapp/codex-auto-review",
  "timeoutMs": 90000,
  "policy": "未经用户明确批准确切目标和副作用，不得修改生产环境。"
}
```

重启 Pi 或执行 `/reload`，然后输入 `/approval-guardian`。

安全测试：让 Pi 执行 `printf '%s\n' 'guardian-ok'`。预期：

```text
Guardian · allowed · low risk · auth high
```

## 完整功能列表

### 拦截和执行规则

| 功能 | 行为 |
| --- | --- |
| 所有 agent `bash` | 每个 Pi agent 发出的 `bash` tool call 都会先审查。 |
| 敏感 `write` | canonical target 位于项目外或命中敏感路径时审查。 |
| 敏感 `edit` | 使用相同的项目边界和敏感路径规则。 |
| 普通 source edit | 项目内且不敏感的 `write`／`edit` 不审查，避免额外延迟。 |
| 明确 allow | 只有 `outcome: "allow"` 才执行。 |
| Fail closed | deny、timeout、provider failure、无效 JSON、取消、model/auth 不可用、circuit open 全部阻止。 |
| 禁止 workaround | 拒绝后要求 agent 不得通过间接命令或绕过 policy 重试。 |
| 直接 shell 不涵盖 | `!`／`!!`、其他终端和其他进程不受拦截。 |
| 其他工具不涵盖 | 当前只处理 `bash`、`write`、`edit`。 |

### 敏感路径检测

`write`／`edit` 在目标位于项目外，或匹配下列敏感类别时送审：

- 环境和 secrets：`.env`、`.env.*`、credentials/secrets 文件与目录；
- 身份和密钥：`.ssh/`、`.gnupg/`、`.aws/`、`.kube/`、`authorized_keys`、PEM/key/P12/PFX；
- Shell 持久化：`.zshrc`、`.zprofile`、`.bashrc`、`.bash_profile`、`.profile`；
- Git/CI：`.git/`、hooks/config、`.github/`、`.gitlab-ci.yml`；
- Pi 设置：`.pi/`、`settings.json`、`approval-guardian.json`；
- 包执行面：`package.json` 和 npm/pnpm/Yarn lockfiles；
- Infra：Terraform、Kubernetes 目录和 Docker Compose。

分类器会解析现有目录 symlink 和 dangling file symlink，防止借助 symlink 写出项目。命中敏感规则并不自动拒绝，而是要求 Guardian 审查。

### Reviewer 隔离

- 独立 reviewer model，不改变主对话 model；
- 隔离的 in-memory Pi session；
- 仅启用 `read`、`grep`、`find`、`ls`；
- 无 `bash`、`write`、`edit`；
- 不加载 extensions、skills、prompt templates、themes、project context files；
- 使用 `low` thinking level；
- 可只读检查 scripts、package scripts、mutation target、配置和 repository metadata；
- transcript、tool output、文件、retry reason、action 全部视为不可信 evidence。

工具白名单不是 OS sandbox。Reviewer 仍可以当前用户的系统权限读取文件。

### Policy 和 prompt

Policy 同步采用 OpenAI Codex Guardian commit [`03bb3b12367397e14a8facc2e018d645ff4d8e83`](https://github.com/openai/codex/tree/03bb3b12367397e14a8facc2e018d645ff4d8e83/codex-rs/core/src/guardian) 的相关设计：

- transcript/action 分隔和防 prompt injection framing；
- risk：`low`、`medium`、`high`、`critical`；
- authorization：`unknown`、`low`、`medium`、`high`；
- low/medium 通常允许；
- high 需要足够授权、有限范围且无 absolute deny；
- critical 拒绝；
- secret/private data 向不可信目标泄漏，即使 high authorization 也拒绝；
- credential probing、持久安全削弱、破坏操作、Git 和有限删除规则；
- 用户了解具体风险后重新明确批准同一动作的处理；
- 可追加 organization policy；
- 严格 JSON 最终响应。

### Transcript 限额

| 项目 | 限额 |
| --- | ---: |
| Message transcript | 40,000 字符 |
| Tool transcript | 40,000 字符 |
| 单条 message | 8,000 字符 |
| 单条 tool evidence | 4,000 字符 |
| Planned action | 64,000 字符 |
| 最近非 user entries | 40 |

优先保留第一条和最新 user intent、可容纳的其他 user message，以及最近 assistant/tool evidence。长内容会进行 middle truncation 并标记省略。

### Session reuse 和 delta

- 第一次发送 bounded full transcript；
- 成功后记录 parent-history cursor；
- 后续重用 reviewer session，只发送新增 transcript delta 和新 action；
- 调用串行化，防止同一 session 并发 prompt；
- branch 变化、cwd/model/timeout/policy 变化时重建并发送 full transcript；
- retry 会丢弃旧 reviewer state，用新 session 和 full transcript 重试；
- shutdown/reload 会清理并取消活动 review。

### Retry 和 deadline

| 功能 | 值 |
| --- | ---: |
| 最大 attempts | 3 |
| 初始 backoff | 200 ms |
| 倍率 | 2× |
| Jitter | 0.9–1.1× |
| 默认共享 deadline | 90 秒 |
| 配置范围 | 1–300 秒 |

仅对无效 assessment JSON 和 Pi 分类为临时性的 provider error（overload、rate limit、HTTP 5xx、fetch/transport/stream failure 等）重试。Quota/billing exhaustion 不重试。

Session startup、attempts、prompt 和 retry wait 共用一个 deadline。明确 allow/deny、取消和 timeout 不重试。

### Failure 分类

| 结果 | 含义 | 行为 |
| --- | --- | --- |
| `allowed` | 明确 allow | 执行 |
| `denied` | 明确 deny | 阻止并禁止 workaround |
| `timeout` | deadline 到期 | 阻止 |
| `failure` | Model/auth/session/provider/parser failure | 阻止 |
| `cancelled` | Parent run/reload/shutdown 取消 | 阻止 |
| `circuit-open` | 同一 run 拒绝过多 | 不调用 reviewer，直接阻止 |

### Denial circuit breaker

同一 Pi agent run 内，连续 3 次明确 denial，或最近 50 次 review 中累计 10 次明确 denial，会打开 circuit 并中止 run。只有有效 reviewer `deny` 计为 denial。

### 精简 UI

- `Guardian · reviewing`
- `Guardian · allowed · low risk · auth high`
- `Guardian · blocked · high risk · auth low`
- `Guardian · timed out · blocked`
- `Guardian · review failed · blocked`
- `Guardian · cancelled · blocked`
- `Guardian · circuit open · blocked`

## 配置

Global：`~/.pi/agent/approval-guardian.json`

Project：`<project>/.pi/approval-guardian.json`，仅在 project trusted 时加载。

环境变量：

```bash
PI_APPROVAL_GUARDIAN_MODEL
PI_APPROVAL_GUARDIAN_TIMEOUT_MS
PI_APPROVAL_GUARDIAN_POLICY
```

Model/timeout 优先级：

```text
environment > trusted project > global > default
```

Policy 累加：

```text
default + global + trusted project + environment
```

## 安装和升级

```bash
pi install npm:pi-approval-guardian
pi install npm:pi-approval-guardian@0.2.0
pi update --extensions
pi remove npm:pi-approval-guardian
```

Git：

```bash
pi install git:github.com/mics8128/pi-approval-guardian@v0.2.0
```

本地开发：

```bash
git clone https://github.com/mics8128/pi-approval-guardian.git
cd pi-approval-guardian
npm install
pi install "$(pwd)"
```

修改后执行 `/reload`。

## 与 Codex Guardian 对比

| 能力 | pi-approval-guardian | Codex Guardian |
| --- | --- | --- |
| Runtime | Pi TypeScript extension | Codex native subsystem |
| 触发 | 所有 agent `bash`；选择性 `write`/`edit` | Codex approval policy 路由 |
| Action types | Bash + 敏感文件 mutation | Shell、exec、execve、patch、network、MCP、permissions |
| Sandbox 集成 | 无，仅 approval gate | 集成 Codex permission/sandbox |
| Reviewer tools | Pi read-only 工具 | Native read-only profile |
| Session delta | 有 | 有 |
| Retry | Parse/临时 provider failure 最多 3 次 | 选定 parse/session failure 最多 3 次 |
| Structured output | Prompt contract + parser | JSON Schema + parser |
| Telemetry | 无 Guardian analytics | Native events/analytics |

本项目是 **Codex Guardian-style**，不是 OpenAI 官方组件，也不保证与 Codex 完全一致。

## 安全、隐私和限制

- Reviewer provider 会收到 bounded transcript 和 planned action。
- Reviewer 可用当前用户权限只读检查本地文件。
- 请使用可信 provider。
- 本包没有自有 telemetry。
- Reviewer 工具白名单不是 OS sandbox。
- 允许的命令仍使用 Pi 原环境和权限执行。
- 敏感路径列表是 heuristic，不是完整 DLP。
- 路径分类和执行之间可能存在 filesystem race。
- Truncation 可能遗漏重要上下文。
- LLM 判断具有概率性；它降低风险，但不能证明安全。
- 不拦截 `!`/`!!`、其他终端、MCP、network、deployment、email、browser、subagent 或任意 custom tools。

## 开发和发布

要求 Node.js 22.19+。

```bash
npm install
npm run check
npm run package:check
```

维护者发布 npm 前请阅读 [docs/PUBLISHING.md](docs/PUBLISHING.md)。仓库提供 GitHub Actions trusted publishing/OIDC workflow，但必须先在 npm 配置 trusted publisher 并审查 tarball。

## 许可证和第三方声明

本项目原创代码采用 [MIT License](LICENSE)。`src/policy.ts` 包含修改自 OpenAI Codex Guardian 的内容，该部分仍受 [Apache License 2.0](LICENSES/Apache-2.0.txt) 约束。来源和修改说明见 [NOTICE](NOTICE)。本项目与 OpenAI 无隶属或背书关系。
