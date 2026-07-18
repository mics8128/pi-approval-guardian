# pi-approval-guardian

**Pi の tool call を default fail-closed で自動審査します。**

Agent が shell command、private data read、プロジェクト外または sensitive file の変更を実行する前に、隔離 reviewer model が評価します。

[![npm version](https://img.shields.io/npm/v/pi-approval-guardian.svg)](https://www.npmjs.com/package/pi-approval-guardian)
[![CI](https://github.com/mics8128/pi-approval-guardian/actions/workflows/ci.yml/badge.svg)](https://github.com/mics8128/pi-approval-guardian/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Pi package](https://img.shields.io/badge/Pi-package-6c5ce7)](https://pi.dev/packages/pi-approval-guardian)

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko.md) · [Español](README.es.md)

> [!IMPORTANT]
> Pi extension は現在の user 権限で動作します。インストール前に source を確認してください。本 package は approval gate であり、OS sandbox ではありません。

## インストール

```bash
pi install npm:pi-approval-guardian
```

Default reviewer は `openai-codex/codex-auto-review`、shared deadline は 90 秒です。公式 Codex provider に未ログインの場合：

```text
/login openai-codex
/reload
/approval-guardian
```

Default setup では設定ファイルは不要です。

## Default protection

| Tool/action | Default scope |
| --- | --- |
| `bash.command` | 常に審査 |
| `grep.path` | プロジェクト外、または path/pattern/glob/effective scope が private data を含み得る場合に審査 |
| `read.path` | 既知の private data |
| `find.path` / `ls.path` | 既知の private path |
| `write.path` / `edit.path` | プロジェクト外または private/sensitive path |
| String `path` を持つ他の tool | Default `private-only` |

通常の clean なプロジェクト内 source edit と search は reviewer latency なしで実行します。ユーザーが直接入力する `!` / `!!`、別 terminal、別 process は対象外です。

## 動作

```text
Pi agent tool call
        │
        ├─ 通常 action ────────────────────────────► execute
        │
        └─ protected action
               │
               ▼
        isolated Guardian reviewer
        normal: read · grep · find · ls
        private-data: tools なし
               │
          ┌────┴────┐
          ▼         ▼
        allow     その他
        execute   block
```

Guardian が enabled の間、protected action は reviewer が有効な `outcome: "allow"` を返した場合のみ実行されます。Deny、timeout、不正 output、auth/model/provider failure、cancel、circuit open はすべて fail closed です。

Private data access には user transcript 上の明示承認と reviewer の `user_authorization: "high"` が必要です。

## Private data rules

主な対象：

- `.env`、`.npmrc`、`.netrc`、`.pypirc`、Git credential、service-account、credential/secret directory;
- SSH/GPG key、cloud CLI、Kubernetes、Docker auth;
- browser login store、password manager、keychain/keyring、VPN、private certificate、Terraform credential;
- Linux、macOS、Windows の一般的な credential location;
- Pi の auth、settings/model/Guardian/trust、API key、run/session/delegate history、memory、context/session database、search index。

`.pi/` 全体を private とは扱いません。`.pi/agent/npm/node_modules/` の installed package code/skill docs と、user skill/agent/extension source は、`.pi/` 配下という理由だけでは private authorization を要求しません。個別ファイルが別の private rule に一致する場合は保護されます。

Read と mutation は別分類です。Project `.pi/skills`、`.pi/agents`、`.pi/extensions`、prompts、themes、chains、package settings は Pi behavior を変更できるため sensitive mutation surface として審査しますが、read だけで confidential 扱いにはしません。

Canonical path と symlink target を確認します。

## Reviewer behavior

- Reviewer state は独立した in-memory session を使用します。最後の fallback は main session の model identity を使う場合がありますが、conversation state は再利用しません。
- Normal review は `read`、`grep`、`find`、`ls` のみ。
- Private-data authorization review は tools なし。
- Reviewer に `bash`、`write`、`edit` を渡しません。
- Transcript、file、tool output、planned action は untrusted evidence。
- Reviewer channel ごとの shared deadline 内で invalid assessment と一部 transient provider failure を最大 3 attempts。

3 consecutive adverse batches、または最新 50 review batches 中 10 adverse batches で circuit open。Deny、timeout、failure は adverse、allow と cancel は対象外です。同じ assistant message の sibling tool calls は 1 batch として扱います。

## Optional configuration

Global：`~/.pi/agent/approval-guardian.json`

Trusted project：`<project>/.pi/approval-guardian.json`

```json
{
  "model": "openai-codex/codex-auto-review",
  "fallbackModel": "openai-codex/codex-auto-review",
  "timeoutMs": 90000,
  "policy": "Exact authorization なしで production を変更しない。"
}
```

Pi model registry に登録・認証済みの custom reviewer channel も使用できます。重複 model を除外した後、Guardian は primary、設定済み `fallbackModel`、最後に現在の Pi session model の順で試します。model/auth unavailable または明確な failure の場合だけ次へ進みます。Timeout はその action の terminal fail-closed result となり、別 channel は試しません。Allow、明示的 deny、cancel でも直ちに停止します。各 channel は独立して incremental reuse される reviewer session を使い、切り替え通知は UI のみに表示します。

Default review matrix：

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

Levels：`always`、`outside-or-private`、`private-only`、`off`。

Trusted project は global protection を強化のみ可能です：

```text
off < private-only < outside-or-private < always
```

Default では agent の `bash` を毎回 review します。一方、通常の project 内 `grep` は path、selector、effective scope が private data を含まない場合、reviewer latency を追加しません。より厳格な profile では `grep.path` を `always` にできます。同等の shell gate または sandbox がない限り、`bash.command` の無効化は推奨しません。

Environment variables：`PI_APPROVAL_GUARDIAN_MODEL`、`PI_APPROVAL_GUARDIAN_FALLBACK_MODEL`、`PI_APPROVAL_GUARDIAN_TIMEOUT_MS`、`PI_APPROVAL_GUARDIAN_POLICY`。

Primary model/fallback model/timeout precedence：`environment > trusted project > global > built-in default`。Policy は global、trusted project、environment の設定を加算します。

Malformed または unsupported な設定は UI warning を表示して無視され、残りの valid settings と built-in defaults が有効なままなので、config typo が tools を global に block することはありません。一時 bypass が inactive の間、protected action は reviewer が valid allow を返さない限り引き続き fail closed です。

`/approval-guardian` で primary、configured fallback、current-model fallback の readiness と config source、`/approval-guardian rules` で effective rules を確認できます。

### 一時 bypass

現在の Pi runtime で review を短時間だけ停止する場合：

```text
/approval-guardian bypass
```

footer には `Guardian · BYPASSED` が継続表示され、editor 下にも one-line warning が残るため、別 extension が footer を置き換えても warning は表示されます。bypass 中の protected agent tool call は Guardian classification、reviewer inference、approved-input lock、circuit enforcement を skip しますが、other extension と tool-internal check は引き続き有効です。Protection を戻すには：

```text
/approval-guardian enable
```

Command は active agent run が完全に settle するまで待ってから state を切り替えます。すでに block された call を release/retry せず、新しい agent turn を開始せず、agent への追加 authorization にもなりません。bypass は memory-only で、`/reload`、`/new`、`/resume`、`/fork`、process restart で自動的に解除されます。Interactive TUI mode でのみ有効化でき、persistent warning を保証できない RPC、JSON、print mode では拒否されます。

bypass/enable notice は UI-only です。Guardian はこの control state を agent context に意図的に注入しません。永続化された「bypassed」message は再有効化後に stale になったり、permission と誤解されたりする可能性があります。実行してほしい作業は agent に別途明示してください。

これは重要な security boundary を外すため、明確で短い時間窓だけで使用してください。

## Update / remove

```bash
pi update npm:pi-approval-guardian
```

更新後に `/reload`。

```bash
pi remove npm:pi-approval-guardian
```

Project-local install / remove：

```bash
pi install -l npm:pi-approval-guardian
pi remove -l npm:pi-approval-guardian
```

Remove 後に `/reload` を実行してください。

Versioned npm spec は pin されます。Pin を進めるには新しい explicit version を install してください。

## Security limitations

- Approved action は Pi の通常 user 権限で実行されます。
- Reviewer decision は probabilistic です。
- Reviewer provider は bounded transcript と planned-action metadata を受け取ります。
- Authorized private read は main conversation で redaction されません。
- Path classification は Pi 互換の `~`、`@`、`file://`、Unicode space normalization を先に適用しますが、rules は heuristic で、すべての renamed/indirect secret を検出できません。
- Shell は完全な AST として解析されません。Guardian は common private target にだけ bounded glob matching を行うため、indirect read は漏れる可能性があります。
- allow 後、Guardian は JSON-like tool input を検証して lock し、後続 `tool_call` handler の変更を防ぎます。Exotic runtime value は fail closed になります。commandPrefix、spawnHook、custom tool internal behavior、dispatch 後の filesystem は観測できません。
- Pathless または nested-path custom tools、MCP、network、browser、email、deployment、subagent action は自動的にすべて保護されず、dedicated enforcement が必要です。
- Filesystem state は review と execution の間に変化する可能性があります。
- Guardian が enabled の間、Primary、configured fallback、distinct current-model fallback がすべて unavailable の場合、protected action は fail closed で block されます。
- User-enabled temporary bypass は、再有効化または自動 reset まで Guardian review、input lock、circuit enforcement を意図的に停止します。

詳細は [docs/REFERENCE.md](docs/REFERENCE.md) を参照してください。

## Development

Node.js 22.19 以上が必要です。

```bash
npm install
npm run check
npm run package:check
pi -e .
```

Maintainer release guide：[docs/PUBLISHING.md](docs/PUBLISHING.md)

## License / attribution

Original code は [MIT License](LICENSE)。変更・適応した OpenAI Codex Guardian policy/prompt material は [Apache License 2.0](LICENSES/Apache-2.0.txt) の対象です。詳細は [NOTICE](NOTICE)。

本 project は Guardian-inspired であり、OpenAI との提携・endorsement はありません。
