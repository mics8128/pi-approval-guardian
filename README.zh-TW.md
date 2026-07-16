<div align="center">

# pi-approval-guardian

**為 Pi 提供 fail-closed、Codex Guardian 風格的自動核准閘門。**

在執行前，以隔離的 reviewer model 審查所有 agent 發出的 `bash`，以及專案外／敏感路徑的 `write`、`edit`。

[![npm version](https://img.shields.io/npm/v/pi-approval-guardian.svg)](https://www.npmjs.com/package/pi-approval-guardian)
[![CI](https://github.com/mics8128/pi-approval-guardian/actions/workflows/ci.yml/badge.svg)](https://github.com/mics8128/pi-approval-guardian/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](README.md) · **繁體中文** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

</div>

> [!IMPORTANT]
> Pi extension 會以你的使用者權限執行。安裝前請先檢查原始碼。本套件是核准閘門，不是作業系統 sandbox。

## 為什麼需要它

Coding agent 需要 shell 權限，但可能誤解範圍、受到不可信輸出的 prompt injection、採用破壞性實作，或修改使用者沒有授權的敏感檔案。

本套件在 Pi tool call 與真正執行之間加入獨立 reviewer：

```text
Pi agent tool call
  ├─ 一般專案內 source edit ─────────────────► 正常執行
  └─ bash／敏感 write／敏感 edit
                  ▼
       隔離的 Guardian reviewer
       僅有 read · grep · find · ls
                  ▼
       明確 allow 才執行；其他一律阻擋
```

Reviewer 會分開判斷動作本身的風險與使用者授權。只有可解析的 `{"outcome":"allow"}` 才能放行。

## 快速開始

```bash
pi install npm:pi-approval-guardian
```

僅安裝到目前專案：

```bash
pi install -l npm:pi-approval-guardian
```

建立 `~/.pi/agent/approval-guardian.json`：

```json
{
  "model": "openai-codex/codex-auto-review",
  "timeoutMs": 90000,
  "policy": "未經使用者明確批准確切目標與副作用，不得修改 production。"
}
```

重新啟動 Pi 或執行 `/reload`，再輸入：

```text
/approval-guardian
```

安全測試：請 Pi 執行 `printf '%s\n' 'guardian-ok'`。預期看到：

```text
Guardian · allowed · low risk · auth high
```

## 完整功能

### 攔截與執行規則

| 功能 | 行為 |
| --- | --- |
| 所有 agent `bash` | 每一個由 Pi agent 發出的 `bash` tool call 都會先送審。 |
| 敏感 `write` | 目標位於專案外或命中敏感路徑時送審。 |
| 敏感 `edit` | 採用相同的專案邊界與敏感路徑規則。 |
| 一般 source edit | 專案內且不敏感的 `write`／`edit` 不送審，避免不必要延遲。 |
| 明確 allow | 只有 reviewer 回傳有效 `outcome: "allow"` 才執行。 |
| Fail closed | deny、timeout、provider failure、錯誤 JSON、取消、model/auth 不可用、circuit open 全部阻擋。 |
| 禁止 workaround | 明確拒絕後會要求 agent 不得透過間接 command 或規避 policy 重試。 |
| 不涵蓋直接 shell | 使用者透過 `!`／`!!`、其他 terminal 或其他程式執行的 command 不會被攔截。 |
| 其他工具 | 目前不攔截 `bash`、`write`、`edit` 以外的 Pi tools。 |

### 敏感路徑

`write`／`edit` 在以下任一情況會送審：

1. canonical path 位於 canonical project root 之外；
2. 路徑符合敏感分類。

分類器會解析既有 directory symlink 與 dangling file symlink，避免透過 symlink 寫到專案外。

| 類別 | 範例 |
| --- | --- |
| 環境與秘密 | `.env`、`.env.*`、`credentials.json`、`secrets.json`、`secrets/` |
| 身分與金鑰 | `.ssh/`、`.gnupg/`、`.aws/`、`.kube/`、`authorized_keys`、`*.pem`、`*.key` |
| Shell 持久化 | `.zshrc`、`.zprofile`、`.bashrc`、`.bash_profile`、`.profile` |
| Git 與自動化 | `.git/`、Git hooks/config、`.github/`、`.gitlab-ci.yml` |
| Pi 設定 | `.pi/`、`settings.json`、`approval-guardian.json` |
| 套件執行面 | `package.json`、npm/pnpm/Yarn lockfiles |
| Infra／部署 | Terraform、Kubernetes 目錄、Docker Compose |

命中敏感路徑不代表必然拒絕，而是必須由 Guardian 評估。

### Reviewer 隔離

- 使用獨立 model，不切換主對話 model。
- 使用隔離的 in-memory Pi session。
- 只啟用 `read`、`grep`、`find`、`ls`。
- 不提供 `bash`、`write`、`edit`。
- 不載入 extensions、skills、prompt templates、themes 或 project context files。
- 使用 `low` thinking level。
- 可在風險取決於本機狀態時，唯讀檢查 scripts、package scripts、mutation targets、設定與 repository metadata。
- Transcript、tool output、檔案內容、retry reason 與 planned action 一律視為不可信 evidence。

這不是 OS sandbox；reviewer 仍可透過唯讀工具讀取目前使用者有權限讀取的檔案。

### Policy 與 prompt

Policy 同步採用 OpenAI Codex Guardian commit [`03bb3b12367397e14a8facc2e018d645ff4d8e83`](https://github.com/openai/codex/tree/03bb3b12367397e14a8facc2e018d645ff4d8e83/codex-rs/core/src/guardian) 的相關概念：

- transcript／action 明確分隔；
- 防 prompt injection 的 untrusted-evidence framing；
- risk：`low`、`medium`、`high`、`critical`；
- authorization：`unknown`、`low`、`medium`、`high`；
- low／medium 原則上放行；
- high 需要至少 medium 授權、有限範圍且沒有 absolute deny；
- critical 拒絕；
- 對不可信目的地外洩 secret／private data，即使 high authorization 也拒絕；
- credential probing、持久性安全弱化、破壞性操作、Git 與有限刪除規則；
- 使用者看過具體風險後，對相同動作重新明確批准的規則；
- 可追加組織 policy；
- 嚴格 JSON 回傳契約。

### Transcript 額度

| 項目 | 限制 |
| --- | ---: |
| Message transcript | 40,000 字元 |
| Tool transcript | 40,000 字元 |
| 單筆 message | 8,000 字元 |
| 單筆 tool evidence | 4,000 字元 |
| Planned action | 64,000 字元 |
| 最近非 user entries | 40 |

會優先保留第一筆與最新 user intent、其他可容納的 user message，以及最近 assistant/tool evidence。過長內容採 middle truncation 並標示省略。

### Session reuse 與 delta

- 第一次送出 bounded full transcript。
- 成功審查後記錄 parent-history cursor。
- 後續重用 reviewer session，只送新增 transcript delta 與新 action。
- Reviewer call 會序列化，避免同一 session 被並行 prompt。
- Branch diverge/shrink、cwd、model、timeout 或 effective policy 改變時，會 dispose 舊 session 並重送 full transcript。
- Retry 會丟棄可能損壞的 reviewer state，以全新 session + full transcript 重試。
- Session shutdown／reload 會清理 reviewer，並取消進行中的 review。

### Retry 與 deadline

| 功能 | 值 |
| --- | ---: |
| 最多 attempts | 3 |
| 初始 backoff | 200 ms |
| 倍率 | 2× |
| Jitter | 0.9–1.1× |
| 預設共同 deadline | 90 秒 |
| 可設定範圍 | 1–300 秒 |

Invalid assessment JSON 與 Pi 判定為暫時性的 provider error（overload、rate limit、HTTP 5xx、transport/fetch/stream failure 等）才會 retry。Quota／billing exhaustion 不視為暫時性錯誤。

Session startup、所有 attempts、prompt 與 retry waits 共用同一 deadline。明確 allow／deny、取消與 timeout 不 retry。

### Failure 分類

| 結果 | 意義 | 執行 |
| --- | --- | --- |
| `allowed` | Reviewer 明確 allow | 執行 |
| `denied` | Reviewer 明確 deny | 阻擋並禁止 workaround |
| `timeout` | 共同 deadline 到期 | 阻擋 |
| `failure` | Model/auth/session/provider/parser failure | 阻擋 |
| `cancelled` | Parent run、reload 或 shutdown 取消 | 阻擋 |
| `circuit-open` | 同一 run 內拒絕過多 | 不呼叫 reviewer，直接阻擋 |

### Denial circuit breaker

在同一個 Pi agent run 中：

- 連續 3 次明確 denial；或
- 最近 50 次 review 累積 10 次明確 denial

會開啟 circuit。只有有效 reviewer `deny` 會計入 denial。Circuit 開啟時會 abort 該 run，後續受保護 action 不再消耗 reviewer request。

### 精簡 UI

- `Guardian · reviewing`
- `Guardian · allowed · low risk · auth high`
- `Guardian · blocked · high risk · auth low`
- `Guardian · timed out · blocked`
- `Guardian · review failed · blocked`
- `Guardian · cancelled · blocked`
- `Guardian · circuit open · blocked`

## 設定

Global：`~/.pi/agent/approval-guardian.json`

Project：`<project>/.pi/approval-guardian.json`，只在 project trusted 時讀取。

環境變數：

```bash
PI_APPROVAL_GUARDIAN_MODEL
PI_APPROVAL_GUARDIAN_TIMEOUT_MS
PI_APPROVAL_GUARDIAN_POLICY
```

Model 與 timeout 優先順序：

```text
environment > trusted project > global > default
```

Policy 會累加：

```text
default + global + trusted project + environment
```

## 安裝、更新、移除

```bash
pi install npm:pi-approval-guardian
pi install npm:pi-approval-guardian@0.2.0
pi update --extensions
pi remove npm:pi-approval-guardian
```

Git 安裝：

```bash
pi install git:github.com/mics8128/pi-approval-guardian@v0.2.0
```

本機開發：

```bash
git clone https://github.com/mics8128/pi-approval-guardian.git
cd pi-approval-guardian
npm install
pi install "$(pwd)"
```

修改後在 Pi 執行 `/reload`。

## 與 Codex Guardian 比較

| 能力 | pi-approval-guardian | Codex Guardian |
| --- | --- | --- |
| Runtime | Pi TypeScript extension | Codex native subsystem |
| 觸發 | 所有 agent `bash`；選擇性 `write`／`edit` | 由 Codex approval policy 路由的 requests |
| Action types | Bash + 敏感檔案 mutation | Shell、exec、execve、patch、network、MCP、permissions |
| Sandbox 整合 | 無，僅 approval gate | 整合 Codex permission/sandbox |
| Reviewer tools | Pi `read`／`grep`／`find`／`ls` | Native read-only profile |
| Session delta | 有 | 有 |
| Retry | Parse／暫時性 provider failure 最多 3 次 | 選定 parse／session failures 最多 3 次 |
| Structured output | Prompt contract + parser | JSON Schema + parser |
| Telemetry | 無 Guardian analytics backend | Native assessment events/analytics |

本專案是 **Codex Guardian-style**，不是 OpenAI 官方元件，也不宣稱與 Codex 完全相同。

## 安全、隱私與限制

- Reviewer provider 會收到 bounded transcript 與 planned action。
- Reviewer 可用目前使用者權限唯讀檢查本機檔案。
- 請使用你信任的 provider。
- 本套件沒有自有 telemetry。
- Tool allowlist 不是 OS sandbox。
- 獲准 command 仍以 Pi 原本的環境與權限執行。
- Sensitive-path list 是 heuristic，不是完整 DLP。
- Path classification 與真正執行之間仍可能存在 filesystem race。
- Truncation 可能省略重要 context。
- LLM 判斷具有機率性；這是降低風險，不是安全證明。
- 不攔截 `!`／`!!`、其他 terminal、MCP、network、deployment、email、browser、subagent 或任意 custom tools。

## 開發

需求：Node.js 22.19+。

```bash
npm install
npm run check
npm run package:check
```

專案結構與完整英文文件請參閱 [README.md](README.md)。

## npm 發布

維護者請先閱讀 [docs/PUBLISHING.md](docs/PUBLISHING.md)。專案已提供 GitHub Actions npm trusted publishing／OIDC workflow；實際 publish 前仍必須設定 npm trusted publisher 並審查 tarball。

## 授權與第三方聲明

本專案原創程式碼採用 [MIT License](LICENSE)。`src/policy.ts` 包含修改自 OpenAI Codex Guardian 的內容，該部分仍適用 [Apache License 2.0](LICENSES/Apache-2.0.txt)。詳細來源與修改說明請見 [NOTICE](NOTICE)。本專案與 OpenAI 無從屬或背書關係。
