# pi-approval-guardian

**為 Pi 工具呼叫提供預設 fail-closed 的自動審核。**

Agent 執行 shell、讀取私密資料，或修改專案外／敏感檔案前，會先交由隔離 reviewer model 評估。

[![npm version](https://img.shields.io/npm/v/pi-approval-guardian.svg)](https://www.npmjs.com/package/pi-approval-guardian)
[![CI](https://github.com/mics8128/pi-approval-guardian/actions/workflows/ci.yml/badge.svg)](https://github.com/mics8128/pi-approval-guardian/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Pi package](https://img.shields.io/badge/Pi-package-6c5ce7)](https://pi.dev/packages/pi-approval-guardian)

[English](README.md) · **繁體中文** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

> [!IMPORTANT]
> Pi extension 會以目前使用者權限執行。安裝前請先檢查原始碼。本套件是 approval gate，不是作業系統 sandbox。

## 安裝

```bash
pi install npm:pi-approval-guardian
```

預設使用 `openai-codex/codex-auto-review`，共同 deadline 為 90 秒。尚未登入官方 Codex provider 時執行：

```text
/login openai-codex
/reload
/approval-guardian
```

預設設定不需要建立設定檔。

## 預設保護範圍

| 工具／動作 | 預設審核範圍 |
| --- | --- |
| `bash.command` | 全部送審 |
| `grep.path` | 專案外搜尋，或 path／pattern／glob／有效 scope 可能接觸私密資料時送審 |
| `read.path` | 已知私密資料 |
| `find.path`／`ls.path` | 已知私密路徑 |
| `write.path`／`edit.path` | 專案外或私密／敏感路徑 |
| 其他帶有字串 `path` 的工具 | 預設 `private-only` |

一般乾淨的專案內 source edit 與搜尋不增加 reviewer 延遲。使用者直接輸入的 `!`／`!!`、其他 terminal 或其他 process 不會被攔截。

## 運作方式

```text
Pi agent tool call
        │
        ├─ 一般動作 ───────────────────────────────► 執行
        │
        └─ 受保護動作
               │
               ▼
        隔離 Guardian reviewer
        一般審核：read · grep · find · ls
        私密資料審核：不提供工具
               │
          ┌────┴────┐
          ▼         ▼
        allow     其他結果
        執行       阻擋
```

Guardian 啟用時，受保護動作只有在 reviewer 回傳有效的 `outcome: "allow"` 後才會執行。Deny、timeout、錯誤輸出、auth/model/provider failure、取消與 circuit open 都會 fail closed。

私密資料還必須在 user transcript 中已有明確授權，且 reviewer 回傳 `user_authorization: "high"`。

## 私密資料判定

常見保護項目包括：

- `.env`、`.npmrc`、`.netrc`、`.pypirc`、Git credential、service-account、credential／secret 目錄；
- SSH／GPG 金鑰、cloud CLI、Kubernetes、Docker 認證；
- Browser login store、password manager、keychain／keyring、VPN、私密憑證與 Terraform credential；
- Linux、macOS 與 Windows 的常見 credential 位置；
- Pi 的 auth、settings/model/Guardian/trust、API key、run/session/delegate history、memory、context/session database 與搜尋索引。

整個 `.pi/` **不會**被視為私密。`.pi/agent/npm/node_modules/` 內的已安裝套件程式碼與 skill 文件，以及使用者的 skill／agent／extension 原始碼，不會只因位於 `.pi/` 就要求私密讀取授權；個別檔名仍可能命中其他規則。

讀取與修改採不同分類：project `.pi/skills`、`.pi/agents`、`.pi/extensions`、prompts、themes、chains 與套件設定仍是敏感 mutation surface，因為修改後可能改變 Pi 行為。它們的讀取不會只因 `.pi/` 位置被視為機密，但修改仍會送審。

分類會使用 canonical path，並解析 symlink target。

## Reviewer 行為

- Reviewer 狀態使用獨立的 in-memory session；最後 fallback 可使用主 session 的 model identity，但不會重用主對話狀態。
- 一般審核只提供 `read`、`grep`、`find`、`ls`；reviewer 專用 guard 會在執行前阻擋已判定為私密的 path 與 scope。
- 私密資料授權審核完全不提供工具。
- Reviewer 不會取得 `bash`、`write`、`edit`。
- Transcript、檔案、tool output 與 planned action 都視為不可信 evidence。
- 每個 reviewer channel 各自在共同 deadline 內，對錯誤 assessment 與部分暫時性 provider failure 最多嘗試 3 次。

連續 3 個 adverse batch，或最近 50 個 review batch 累積 10 個 adverse batch，會開啟 circuit。Deny、timeout 與 failure 屬於 adverse；allow 與取消不計。同一筆 assistant message 的 sibling tool calls 視為一個 batch。

## 選用設定

Global：

```text
~/.pi/agent/approval-guardian.json
```

Trusted project：

```text
<project>/.pi/approval-guardian.json
```

最小範例：

```json
{
  "model": "openai-codex/codex-auto-review",
  "fallbackModel": "openai-codex/codex-auto-review",
  "timeoutMs": 90000,
  "policy": "未取得精確授權時不得修改 production。"
}
```

也可使用已在 Pi model registry 註冊並完成認證的自訂 reviewer channel。去除重複 model 後，Guardian 會依序嘗試 primary、設定的 `fallbackModel`，最後才使用目前 Pi session model。只有 model／認證不可用或明確 failure 才會進下一個 channel。Timeout 會直接讓該動作 fail closed，不再嘗試其他 channel；allow、明確 deny 與取消也會立即停止。每個 channel 都有各自獨立、可增量重用的 reviewer session，切換提示只顯示於 UI。

預設 review matrix：

```json
{
  "review": {
    "bash.command": "always",
    "grep.path": "outside-or-private",
    "read.path": "private-only",
    "find.path": "private-only",
    "ls.path": "private-only",
    "write.path": "outside-or-private",
    "edit.path": "outside-or-private"
  }
}
```

可用層級：`always`、`outside-or-private`、`private-only`、`off`。

Trusted project 只能提高 global 保護，不能降低：

```text
off < private-only < outside-or-private < always
```

預設會審查每個 agent `bash`；一般專案內 `grep` 若 path、selector 與有效 scope 都不涉及私密資料，則不增加 reviewer 延遲。需要更嚴格模式時可把 `grep.path` 設為 `always`。不建議直接關閉 `bash.command`，除非已有可信的 shell gate 或 sandbox 提供同等保護。

環境變數：

```bash
PI_APPROVAL_GUARDIAN_MODEL
PI_APPROVAL_GUARDIAN_FALLBACK_MODEL
PI_APPROVAL_GUARDIAN_TIMEOUT_MS
PI_APPROVAL_GUARDIAN_POLICY
```

Primary model、fallback model 與 timeout precedence：`environment > trusted project > global > built-in default`。Policy 會合併 global、trusted project 與 environment 設定。

格式錯誤或不支援的設定只會顯示 UI 警告並被忽略；其餘有效設定與內建預設仍會生效，因此設定 typo 不會全域阻擋工具。未啟用暫時 bypass 時，受保護動作若未取得 reviewer 的有效 allow，仍然會 fail closed。

執行 `/approval-guardian` 可查看 primary、設定 fallback、current-model fallback 的 readiness 與有效設定來源；`/approval-guardian rules` 可查看生效中的規則。

### 暫時 bypass

確定要在目前 Pi 執行階段短暫停用審核時，執行：

```text
/approval-guardian bypass
```

bypass 期間，editor 下方會持續保留單行警告。停用期間，受保護的 agent tool call 會略過 Guardian 分類、reviewer 推論、核准 input 鎖定與 circuit enforcement；其他 extension 或 tool 內部檢查仍然有效。要恢復保護，執行：

```text
/approval-guardian enable
```

指令會等待目前 agent run 完全結束後再切換狀態；不會放行或重試先前已阻擋的 call、不會自行觸發新的 agent turn，也不代表授予 agent 額外權限。bypass 只保存在記憶體中，遇到 `/reload`、`/new`、`/resume`、`/fork` 或 process 重啟就會自動清除。只有互動式 TUI mode 能啟用；RPC、JSON 與 print mode 因無法保證持續顯示警告而會拒絕。

bypass／enable 通知只顯示於 UI。Guardian 刻意不把這個控制狀態注入 agent context：持久的「已 bypass」訊息可能在重新啟用後變成過期資訊，也可能被誤解為工作授權。要 agent 執行什麼，仍應另外下達明確指令。

這會移除一層重要安全邊界，只應在明確且短暫的時間窗使用。

## 更新與移除

```bash
pi update npm:pi-approval-guardian
```

更新後執行 `/reload`。

```bash
pi remove npm:pi-approval-guardian
```

專案區域安裝與移除：

```bash
pi install -l npm:pi-approval-guardian
pi remove -l npm:pi-approval-guardian
```

移除後執行 `/reload`，即可從目前 session 卸載。

帶版本號的 npm spec 會固定版本；要更新 pin，請重新安裝新的明確版本。

## 安全限制

- 核准後的動作仍以 Pi 的一般使用者權限執行。
- Reviewer 判斷具有機率性，可能出錯。
- Reviewer provider 會收到 bounded transcript 與 planned-action metadata。
- 已授權的私密讀取不會在主對話中自動遮罩。
- 路徑分類先套用與 Pi 相同的 `~`、`@`、`file://` 與 Unicode 空白正規化，但規則仍是 heuristic，無法辨識所有重新命名或間接 secret。
- Shell 不會被完整解析成 AST；Guardian 只對常見私密目標做有界 glob 比對，複雜間接讀取仍可能漏判。
- allow 後 Guardian 會驗證並鎖定 JSON-like tool input，避免後續 `tool_call` handler 改寫；exotic runtime value 會 fail closed。它無法觀察 commandPrefix、spawnHook、custom tool 內部行為或 dispatch 後的 filesystem 變化。
- Pathless 或 nested-path custom tools、MCP、network、browser、email、deployment 與 subagent 動作不會自動全部受保護，必須有專屬 enforcement。
- Filesystem 狀態可能在審核與執行之間改變。
- Guardian 啟用時，Primary、設定 fallback 與不同的 current-model fallback 都不可用會讓受保護動作 fail closed。
- 使用者啟用暫時 bypass 後，Guardian review、input lock 與 circuit enforcement 會刻意停用，直到重新啟用或自動重設。
- Pi project trust、OS/container sandbox 與本套件解決的是不同安全層。

完整技術行為請參閱 [docs/REFERENCE.md](docs/REFERENCE.md)。

## 開發

需要 Node.js 22.19 以上。

```bash
npm install
npm run check
npm run package:check
pi -e .
```

維護者發布流程請參閱 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 授權與來源標示

原始專案程式碼採 [MIT License](LICENSE)。修改與改寫的 OpenAI Codex Guardian policy／prompt 材料仍適用 [Apache License 2.0](LICENSES/Apache-2.0.txt)，詳見 [NOTICE](NOTICE)。

本專案受 Guardian 啟發，與 OpenAI 無隸屬或背書關係。
