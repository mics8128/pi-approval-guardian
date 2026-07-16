<div align="center">

# pi-approval-guardian

**Pi 向けの fail-closed な Codex Guardian スタイル自動承認ゲート。**

エージェントが発行するすべての `bash` と、プロジェクト外または機密パスへの `write` / `edit` を、実行前に独立 reviewer model で審査します。

[![npm version](https://img.shields.io/npm/v/pi-approval-guardian.svg)](https://www.npmjs.com/package/pi-approval-guardian)
[![CI](https://github.com/mics8128/pi-approval-guardian/actions/workflows/ci.yml/badge.svg)](https://github.com/mics8128/pi-approval-guardian/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko.md) · [Español](README.es.md)

</div>

> [!IMPORTANT]
> Pi extension はユーザー権限で動作します。インストール前にソースを確認してください。本パッケージは承認ゲートであり、OS sandbox ではありません。

## クイックスタート

```bash
pi install npm:pi-approval-guardian
```

`~/.pi/agent/approval-guardian.json`：

```json
{
  "model": "openai-codex/codex-auto-review",
  "timeoutMs": 90000,
  "policy": "本番環境の変更は、対象と副作用について明示的な承認がある場合のみ許可する。"
}
```

Pi を再起動するか `/reload` を実行し、`/approval-guardian` で状態を確認します。

## 仕組み

```text
Pi agent tool call
  ├─ 通常のプロジェクト内 source edit ───────► そのまま実行
  └─ bash / sensitive write / sensitive edit
                  ▼
       isolated Guardian reviewer
       read · grep · find · ls only
                  ▼
       明示的な allow のみ実行、その他は block
```

有効な `{"outcome":"allow"}` だけが実行を許可します。deny、timeout、provider failure、不正 JSON、cancel、model/auth 不備、circuit open はすべて fail closed です。

## 全機能

### 対象アクション

| 機能 | 動作 |
| --- | --- |
| すべての agent `bash` | 実行前に必ず審査。 |
| 機密 `write` | canonical path がプロジェクト外、または機密ルール一致時に審査。 |
| 機密 `edit` | `write` と同じ境界・機密ルール。 |
| 通常の source edit | プロジェクト内かつ非機密なら reviewer を通さない。 |
| Direct shell | ユーザーの `!` / `!!`、別 terminal、別 process は対象外。 |
| その他の tools | 現在は `bash`、`write`、`edit` のみ。 |

### 機密パス

- `.env`、credentials、secrets；
- `.ssh/`、`.gnupg/`、`.aws/`、`.kube/`、鍵/証明書；
- `.zshrc`、`.bashrc`、`.profile` などの shell persistence；
- `.git/`、Git hooks、`.github/`、GitLab CI；
- `.pi/`、Guardian/Pi settings；
- `package.json` と lockfiles；
- Terraform、Kubernetes、Docker Compose。

既存 directory symlink と dangling file symlink を解決し、プロジェクト外への書き込みを検出します。機密判定は自動 deny ではなく、reviewer 審査を要求します。

### Reviewer isolation

- メイン会話とは別の model；
- in-memory session；
- `read`、`grep`、`find`、`ls` のみ；
- `bash`、`write`、`edit` なし；
- extensions、skills、prompt templates、themes、project context files を読み込まない；
- scripts、package scripts、対象ファイル、設定、repository metadata を read-only で調査可能；
- transcript、tool output、file content、retry reason、action はすべて untrusted evidence。

これは OS sandbox ではなく、reviewer は現在ユーザーが読めるファイルを読めます。

### Policy

OpenAI Codex Guardian commit [`03bb3b12367397e14a8facc2e018d645ff4d8e83`](https://github.com/openai/codex/tree/03bb3b12367397e14a8facc2e018d645ff4d8e83/codex-rs/core/src/guardian) を参照しています。

- risk：`low` / `medium` / `high` / `critical`；
- authorization：`unknown` / `low` / `medium` / `high`；
- low/medium は通常 allow；
- high は十分な authorization、狭い範囲、absolute deny なしの場合のみ allow；
- critical は deny；
- untrusted destination への secret/private data 漏えいは high authorization でも deny；
- prompt injection、credential probing、security weakening、destructive action、Git、限定的削除、再承認ルール；
- additive organization policy；
- strict JSON output。

### Transcript limits

| 項目 | 上限 |
| --- | ---: |
| Message transcript | 40,000 chars |
| Tool transcript | 40,000 chars |
| 1 message | 8,000 chars |
| 1 tool entry | 4,000 chars |
| Planned action | 64,000 chars |
| Recent non-user entries | 40 |

長い内容は middle truncation され、省略が明示されます。

### Session reuse / delta

- 初回は full transcript；
- 成功後は reviewer session を再利用し、新しい transcript delta のみ送信；
- call は直列化；
- branch、cwd、model、timeout、policy が変われば再構築；
- retry は新しい session と full transcript；
- reload/shutdown で cleanup と cancel。

### Retry / deadline

| 項目 | 値 |
| --- | ---: |
| 最大 attempts | 3 |
| 初期 backoff | 200 ms |
| factor | 2× |
| jitter | 0.9–1.1× |
| default shared deadline | 90 秒 |
| range | 1–300 秒 |

不正 assessment JSON と、Pi が transient と判定した overload、rate limit、HTTP 5xx、fetch/transport/stream errors を retry します。Quota/billing は retry しません。Startup、attempt、prompt、wait は同じ deadline を共有します。

### Failure classification

- `allowed`：実行；
- `denied`：block、workaround 禁止；
- `timeout`：block；
- `failure`：block；
- `cancelled`：block；
- `circuit-open`：reviewer を呼ばず block。

### Circuit breaker

1 Pi agent run 内で 3 回連続 deny、または直近 50 reviews 中 10 deny で circuit open。run を abort し、以後の対象 action を即時 block します。

### UI

`Guardian · reviewing`、`allowed`、`blocked`、`timed out`、`review failed`、`cancelled`、`circuit open` を短い形式で表示します。

## 設定

Global：`~/.pi/agent/approval-guardian.json`

Project：`<project>/.pi/approval-guardian.json`（trusted project のみ）

環境変数：

```bash
PI_APPROVAL_GUARDIAN_MODEL
PI_APPROVAL_GUARDIAN_TIMEOUT_MS
PI_APPROVAL_GUARDIAN_POLICY
```

Model/timeout：`environment > trusted project > global > default`

Policy：`default + global + trusted project + environment`

## インストール・更新

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

## Codex Guardian との比較

| 能力 | pi-approval-guardian | Codex Guardian |
| --- | --- | --- |
| Runtime | Pi TypeScript extension | Native Codex subsystem |
| Trigger | 全 agent bash、選択的 write/edit | Codex approval policy |
| Actions | Bash + sensitive files | Shell/exec/patch/network/MCP/permissions |
| Sandbox | なし、approval gate のみ | Codex sandbox/permissions と統合 |
| Session delta | あり | あり |
| Retry | parse/transient provider 最大 3 | selected parse/session 最大 3 |
| Structured output | Prompt + parser | JSON Schema + parser |
| Analytics | なし | Native events/analytics |

本プロジェクトは **Codex Guardian-style** であり、OpenAI 公式コンポーネントではありません。

## Security / privacy / limitations

Reviewer provider は bounded transcript/action を受信し、read-only tools でローカルファイルを読めます。信頼できる provider を使用してください。本パッケージ独自の telemetry はありません。許可された command は Pi の通常権限で実行されます。機密パスは heuristic で、完全な DLP ではありません。LLM 判定は確率的です。

`!` / `!!`、別 terminal、MCP、network、deployment、email、browser、subagent、任意 custom tools は現在対象外です。

## 開発・公開

Node.js 22.19+：

```bash
npm install
npm run check
npm run package:check
```

npm 公開手順は [docs/PUBLISHING.md](docs/PUBLISHING.md) を参照してください。GitHub Actions trusted publishing/OIDC workflow を含みます。

## ライセンスと第三者通知

本プロジェクト独自のコードは [MIT License](LICENSE) です。`src/policy.ts` には OpenAI Codex Guardian から変更・適応した内容が含まれ、その部分には [Apache License 2.0](LICENSES/Apache-2.0.txt) が適用されます。出典と変更内容は [NOTICE](NOTICE) を参照してください。本プロジェクトは OpenAI の公式・公認プロジェクトではありません。
