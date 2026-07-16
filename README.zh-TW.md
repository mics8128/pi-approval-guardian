# pi-approval-guardian

**為 Pi 工具呼叫提供 fail-closed 自動審核。**

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
| `grep.path` | 全部送審，包含廣泛或未指定路徑的搜尋 |
| `read.path` | 已知私密資料 |
| `find.path`／`ls.path` | 已知私密路徑 |
| `write.path`／`edit.path` | 專案外或私密／敏感路徑 |
| 其他帶有字串 `path` 的工具 | 預設 `private-only` |

一般專案內 source edit 不增加 reviewer 延遲。使用者直接輸入的 `!`／`!!`、其他 terminal 或其他 process 不會被攔截。

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

只有有效的 `outcome: "allow"` 才會執行。Deny、timeout、錯誤輸出、auth/model/provider failure、取消與 circuit open 都會 fail closed。

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

- 使用與主對話分離的 model 與 in-memory session。
- 一般審核只提供 `read`、`grep`、`find`、`ls`。
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

也可使用已在 Pi model registry 註冊並完成認證的自訂 reviewer channel。`fallbackModel` 預設為正式的 `openai-codex/codex-auto-review`；不同的 primary 找不到、沒有可用認證、失敗或逾時時，Guardian 會嘗試 fallback，並只在 UI 顯示小提示。明確 deny 或取消不會觸發 fallback。

預設 review matrix：

```json
{
  "review": {
    "bash.command": "always",
    "grep.path": "always",
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

環境變數：

```bash
PI_APPROVAL_GUARDIAN_MODEL
PI_APPROVAL_GUARDIAN_FALLBACK_MODEL
PI_APPROVAL_GUARDIAN_TIMEOUT_MS
PI_APPROVAL_GUARDIAN_POLICY
```

Primary model、fallback model 與 timeout precedence：`environment > trusted project > global > built-in default`。Policy 會合併 global、trusted project 與 environment 設定。

執行 `/approval-guardian` 可查看 primary／fallback readiness 與有效設定來源；`/approval-guardian rules` 可查看生效中的規則。

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
- Primary 與 fallback reviewer channel 都不可用時，受保護動作會 fail closed。
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
