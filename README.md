# pi-codex-reviewer

一個採用 OpenAI Codex Guardian／Auto-review 邏輯的 Pi bash approval gate。

每當 Pi 準備執行 `bash` tool，插件會先把目前對話、近期工具呼叫與結果、工作目錄及待執行 command 送給獨立 reviewer model。只有 reviewer 明確回傳 `{"outcome":"allow"}` 時才會執行；拒絕、timeout、API error、model 不存在、認證失敗或回傳格式錯誤時一律阻擋。

## 行為

- 自動攔截 Pi 的 `bash` tool calls。
- 不攔截使用者直接透過 `!`／`!!` 執行的 shell command；只審查 Pi agent 發出的 `bash` tool call。
- 使用獨立 reviewer model，不會切換目前對話使用中的模型。
- 傳送使用者意圖、assistant 訊息、近期 tool calls 與 tool results 作為授權前後文。
- 對話內容和 command 都被標示為不可信 evidence，避免 prompt injection 直接要求 reviewer 放行。
- 依 Codex Guardian 的四級風險判定：`low`、`medium`、`high`、`critical`。
- 依前後文判定使用者授權程度：`unknown`、`low`、`medium`、`high`。
- 採 fail-closed：沒有明確 `allow` 就不執行。
- 被拒絕後會要求 Pi 不得透過 workaround 或間接 command 繞過。

## Codex 相容邏輯

本插件依照 Codex Guardian 的公開實作重現核心流程：

1. 保留人類對話，以及近期 tool call／result evidence。
2. 將 transcript 與 planned action 放在明確分隔區塊。
3. 將所有 transcript、工具輸出與 command 視為不可信資料，而非 reviewer instructions。
4. 先判斷 intrinsic risk 與 user authorization，再決定 allow／deny。
5. Low／medium risk 原則上放行；high risk 必須有足夠授權及有限 blast radius；critical risk 拒絕。
6. Reviewer 必須回傳嚴格 JSON。
7. Timeout、review failure 與 JSON parse failure 全部 fail closed。

為避免對話無限增長，前後文採用與 Codex Guardian 類似的分離額度：message 與 tool evidence 各自保留，單筆內容會截斷，並優先保留第一筆／最新的使用者訊息及最新的非使用者 evidence。

參考的 Codex 原始碼版本：`cbc83d961e8132bfff4d340ab8342d181b79e95e`

- [Guardian prompt 與 transcript selection](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/core/src/guardian/prompt.rs)
- [Guardian policy template](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/core/src/guardian/policy_template.md)
- [Default risk policy](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/core/src/guardian/policy.md)
- [Fail-closed review flow](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/core/src/guardian/review.rs)

## 安裝

> Pi extension 會以你的使用者權限執行。安裝前請先檢查原始碼。

### 本機安裝

```bash
npm install
pi install "$(pwd)"
```

只安裝到目前專案：

```bash
pi install -l "$(pwd)"
```

### 直接試跑

```bash
npm install
pi -e ./extensions/index.ts
```

### Git 安裝

發布到 GitHub 後：

```bash
pi install git:github.com/mics8128/pi-codex-reviewer@v0.1.0
```

也可以直接安裝最新版：

```bash
pi install git:github.com/mics8128/pi-codex-reviewer
```

## Reviewer model

預設使用：

```text
openai-codex/codex-auto-review
```

這是獨立 reviewer，不受 Pi 當前 `/model` 選擇影響。Model 格式必須是 `<provider>/<model>`，且 provider 必須已透過 Pi 完成登入或 API key 設定。找不到模型或認證失敗時，所有 Pi agent bash command 都會被阻擋。

### Global 設定

建立 `~/.pi/agent/codex-guardian.json`：

```json
{
  "model": "llm-esapp/codex-auto-review",
  "timeoutMs": 90000,
  "policy": "禁止任何未經明確授權的 production mutation。"
}
```

### Project-local 設定

建立 `<project>/.pi/codex-guardian.json`：

```json
{
  "model": "llm-esapp/codex-auto-review",
  "policy": "此專案不得執行 terraform destroy。"
}
```

插件只有在 `ctx.isProjectTrusted()` 為 true 時才讀取 project-local 設定。Global 與 project policy 會累加，project 無法移除 global policy。

### 環境變數

```bash
export PI_CODEX_GUARDIAN_MODEL="llm-esapp/codex-auto-review"
export PI_CODEX_GUARDIAN_TIMEOUT_MS="90000"
export PI_CODEX_GUARDIAN_POLICY='只允許讀取 production database。'
```

Model 與 timeout 的優先順序為環境變數、project config、global config、內建預設值。Policy 則依序累加 global、project、環境變數，並放在 reviewer system prompt，不能被 transcript 覆蓋。

可在 Pi 裡檢查實際生效設定：

```text
/codex-guardian
```

## 範例

使用者明確要求刪除單一 generated cache：

```text
使用者：刪除這個專案的 .cache 產物
Pi bash：rm -rf .cache
```

Reviewer 可判定為範圍有限且已授權，因此放行。

未經授權的廣泛刪除：

```text
Pi bash：rm -rf ~
```

Reviewer 應判定為高風險或 critical，插件會回傳 blocked tool result，command 不會執行。

## 開發

需求：Node.js 22.19 以上。

```bash
npm install
npm run check
```

## 專案結構

```text
extensions/index.ts   攔截 bash、呼叫 reviewer、fail-closed gate
src/config.ts         Global/project/env 設定載入與信任檢查
src/review.ts         Guardian policy、context selection、prompt 與 JSON parser
tests/*.test.ts       設定、context 與 parser 測試
package.json          Pi package manifest
```

## 隱私與限制

- Reviewer 會收到有限且經截斷的對話與工具前後文，其中可能包含敏感資訊；請使用你信任的 model provider。
- Reviewer 不具備額外 tools，因此無法像完整 Codex Guardian 一樣主動執行 read-only investigation；它只能根據 Pi 已有的前後文判斷。
- 此插件是 approval gate，不是 sandbox。獲准的 command 仍以 Pi 原本的 bash 執行環境與權限執行。
- 本插件只控制 Pi agent 發出的 bash tool call；使用者直接輸入的 `!`／`!!` shell command、其他程式與另一個 terminal 都不會被攔截。

## License

MIT
