# pi-approval-guardian

**Pi tool call을 기본 fail-closed 방식으로 자동 검토합니다.**

Agent가 shell command, private data read, 프로젝트 외부 또는 sensitive file 수정을 실행하기 전에 격리 reviewer model이 평가합니다.

[![npm version](https://img.shields.io/npm/v/pi-approval-guardian.svg)](https://www.npmjs.com/package/pi-approval-guardian)
[![CI](https://github.com/mics8128/pi-approval-guardian/actions/workflows/ci.yml/badge.svg)](https://github.com/mics8128/pi-approval-guardian/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Pi package](https://img.shields.io/badge/Pi-package-6c5ce7)](https://pi.dev/packages/pi-approval-guardian)

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **한국어** · [Español](README.es.md)

> [!IMPORTANT]
> Pi extension은 현재 사용자 권한으로 실행됩니다. 설치 전에 source를 검토하세요. 이 package는 approval gate이며 OS sandbox가 아닙니다.

## 설치

```bash
pi install npm:pi-approval-guardian
```

Default reviewer는 `openai-codex/codex-auto-review`, shared deadline은 90초입니다. 공식 Codex provider에 로그인하지 않았다면:

```text
/login openai-codex
/reload
/approval-guardian
```

Default setup에는 설정 파일이 필요하지 않습니다.

## 기본 보호 범위

| Tool/action | Default scope |
| --- | --- |
| `bash.command` | 항상 검토 |
| `grep.path` | 프로젝트 외부이거나 path/pattern/glob/effective scope가 private data를 노출할 수 있을 때 검토 |
| `read.path` | 알려진 private data |
| `find.path` / `ls.path` | 알려진 private path |
| `write.path` / `edit.path` | 프로젝트 외부 또는 private/sensitive path |
| 문자열 `path`를 가진 다른 tool | 기본 `private-only` |

일반적인 clean 프로젝트 내부 source edit와 search는 reviewer 지연 없이 실행됩니다. 사용자가 직접 입력한 `!`/`!!`, 다른 terminal, 다른 process는 가로채지 않습니다.

## 작동 방식

```text
Pi agent tool call
        │
        ├─ 일반 action ─────────────────────────────► execute
        │
        └─ protected action
               │
               ▼
        isolated Guardian reviewer
        normal: read · grep · find · ls
        private-data: tools 없음
               │
          ┌────┴────┐
          ▼         ▼
        allow     그 외
        execute   block
```

Guardian이 enabled인 동안 protected action은 reviewer가 유효한 `outcome: "allow"`를 반환한 경우에만 실행됩니다. Deny, timeout, invalid output, auth/model/provider failure, cancel, circuit open은 모두 fail closed입니다.

Private data access에는 user transcript의 명시적 승인과 reviewer의 `user_authorization: "high"`가 필요합니다.

## Private data rules

주요 보호 대상:

- `.env`, `.npmrc`, `.netrc`, `.pypirc`, Git credential, service-account, credential/secret directory;
- SSH/GPG key, cloud CLI, Kubernetes, Docker auth;
- browser login store, password manager, keychain/keyring, VPN, private certificate, Terraform credential;
- Linux, macOS, Windows의 일반적인 credential location;
- Pi auth, settings/model/Guardian/trust, API key, run/session/delegate history, memory, context/session database, search index.

`.pi/` 전체를 private으로 취급하지 않습니다. `.pi/agent/npm/node_modules/`의 설치된 package code/skill 문서와 사용자 skill/agent/extension source는 `.pi/` 아래에 있다는 이유만으로 private authorization을 요구하지 않습니다. 개별 파일이 다른 private rule과 일치하면 보호됩니다.

Read와 mutation은 별도로 분류합니다. Project `.pi/skills`, `.pi/agents`, `.pi/extensions`, prompts, themes, chains, package settings는 Pi behavior를 바꿀 수 있으므로 sensitive mutation surface로 검토하지만, read만으로 confidential 처리하지 않습니다.

Canonical path와 symlink target을 확인합니다.

## Reviewer behavior

- Reviewer state는 독립된 in-memory session을 사용합니다. 마지막 fallback은 main session의 model identity를 사용할 수 있지만 conversation state는 재사용하지 않습니다.
- Normal review는 `read`, `grep`, `find`, `ls`만 제공.
- Private-data authorization review는 tools 없음.
- Reviewer에 `bash`, `write`, `edit`를 제공하지 않음.
- Transcript, file, tool output, planned action은 untrusted evidence.
- 각 reviewer channel의 shared deadline 안에서 invalid assessment와 일부 transient provider failure를 최대 3 attempts.

3 consecutive adverse batches 또는 최근 50 review batches 중 10 adverse batches이면 circuit이 열립니다. Deny, timeout, failure는 adverse이며 allow와 cancel은 제외됩니다. 같은 assistant message의 sibling tool calls는 한 batch로 계산합니다.

## 선택 설정

Global: `~/.pi/agent/approval-guardian.json`

Trusted project: `<project>/.pi/approval-guardian.json`

```json
{
  "model": "openai-codex/codex-auto-review",
  "fallbackModel": "openai-codex/codex-auto-review",
  "timeoutMs": 90000,
  "policy": "정확한 승인 없이 production을 수정하지 않는다."
}
```

Pi model registry에 등록되고 인증된 custom reviewer channel도 사용할 수 있습니다. 중복 model을 제거한 뒤 Guardian은 primary, 설정된 `fallbackModel`, 마지막으로 현재 Pi session model 순서로 시도합니다. model/auth unavailable 또는 명시적 failure일 때만 다음 channel로 진행합니다. Timeout은 해당 action의 terminal fail-closed result이며 다른 channel을 시도하지 않습니다. Allow, 명시적 deny, cancel도 즉시 중단합니다. 각 channel은 독립적으로 incremental reuse되는 reviewer session을 사용하고 전환 알림은 UI에만 표시됩니다.

Default review matrix:

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

Levels: `always`, `outside-or-private`, `private-only`, `off`.

Trusted project는 global protection을 강화만 할 수 있습니다:

```text
off < private-only < outside-or-private < always
```

Default에서는 agent의 모든 `bash`를 review합니다. 일반 project 내부 `grep`은 path, selector, effective scope가 private data를 포함하지 않으면 reviewer latency를 추가하지 않습니다. 더 엄격한 profile에서는 `grep.path`를 `always`로 설정할 수 있습니다. 동등한 shell gate 또는 sandbox가 없다면 `bash.command` 비활성화는 권장하지 않습니다.

Environment variables: `PI_APPROVAL_GUARDIAN_MODEL`, `PI_APPROVAL_GUARDIAN_FALLBACK_MODEL`, `PI_APPROVAL_GUARDIAN_TIMEOUT_MS`, `PI_APPROVAL_GUARDIAN_POLICY`.

Primary model/fallback model/timeout precedence: `environment > trusted project > global > built-in default`. Policy는 global, trusted project, environment 설정을 합산합니다.

Malformed 또는 unsupported 설정은 UI warning을 표시한 뒤 무시되며, 나머지 valid settings와 built-in defaults는 계속 적용됩니다. 따라서 config typo가 tools 전체를 block하지 않습니다. 임시 bypass가 inactive인 동안 protected action은 reviewer가 valid allow를 반환하지 않으면 계속 fail closed입니다.

`/approval-guardian`으로 primary, configured fallback, current-model fallback의 readiness와 config source를, `/approval-guardian rules`로 effective rules를 확인할 수 있습니다.

### 임시 bypass

현재 Pi runtime에서 review를 잠시 중단해야 할 때:

```text
/approval-guardian bypass
```

bypass가 활성화된 동안 editor 아래에 한 줄 warning이 계속 표시됩니다. bypass 중 protected agent tool call은 Guardian classification, reviewer inference, approved-input lock, circuit enforcement를 건너뛰지만 other extension과 tool-internal check는 계속 적용됩니다. Protection을 복구하려면:

```text
/approval-guardian enable
```

Command는 active agent run이 완전히 settle될 때까지 기다린 뒤 state를 전환합니다. 이미 block된 call을 release/retry하지 않고, 새 agent turn을 시작하지 않으며, agent에 추가 authorization을 부여하지도 않습니다. bypass는 memory-only이며 `/reload`, `/new`, `/resume`, `/fork`, process restart 시 자동으로 해제됩니다. Interactive TUI mode에서만 활성화할 수 있으며 persistent warning을 보장할 수 없는 RPC, JSON, print mode에서는 거부됩니다.

bypass/enable 알림은 UI-only입니다. Guardian은 이 control state를 agent context에 의도적으로 주입하지 않습니다. 영구적인 “bypassed” message는 재활성화 후 stale해지거나 permission으로 오해될 수 있습니다. 수행할 작업은 agent에 별도로 명확히 지시해야 합니다.

중요한 security boundary를 제거하므로 명확하고 짧은 시간 범위에서만 사용하세요.

## 업데이트 / 제거

```bash
pi update npm:pi-approval-guardian
```

업데이트 후 `/reload`를 실행합니다.

```bash
pi remove npm:pi-approval-guardian
```

Project-local install / remove:

```bash
pi install -l npm:pi-approval-guardian
pi remove -l npm:pi-approval-guardian
```

제거 후 `/reload`를 실행하세요.

Versioned npm spec은 pin됩니다. Pin을 변경하려면 새로운 explicit version을 설치하세요.

## Security limitations

- Approved action은 Pi의 일반 사용자 권한으로 실행됩니다.
- Reviewer decision은 probabilistic합니다.
- Reviewer provider는 bounded transcript와 planned-action metadata를 받습니다.
- Authorized private read는 main conversation에서 redaction되지 않습니다.
- Path classification은 Pi 호환 `~`, `@`, `file://`, Unicode space normalization을 먼저 적용하지만 rules는 heuristic이며 모든 renamed/indirect secret을 감지하지 못합니다.
- Shell은 완전한 AST로 파싱되지 않습니다. Guardian은 common private target에 대해서만 bounded glob matching을 하므로 indirect read는 누락될 수 있습니다.
- allow 후 Guardian은 JSON-like tool input을 검증하고 lock하여 이후 `tool_call` handler 변경을 막습니다. Exotic runtime value는 fail closed 처리됩니다. commandPrefix, spawnHook, custom tool internal behavior, dispatch 후 filesystem은 관찰하지 못합니다.
- Pathless 또는 nested-path custom tools, MCP, network, browser, email, deployment, subagent action은 자동으로 모두 보호되지 않으며 dedicated enforcement가 필요합니다.
- Filesystem state는 review와 execution 사이에 변경될 수 있습니다.
- Guardian이 enabled인 동안 Primary, configured fallback, distinct current-model fallback을 모두 사용할 수 없으면 protected action은 fail closed로 block됩니다.
- User-enabled temporary bypass는 재활성화 또는 자동 reset까지 Guardian review, input lock, circuit enforcement를 의도적으로 중단합니다.

전체 기술 설명: [docs/REFERENCE.md](docs/REFERENCE.md)

## Development

Node.js 22.19 이상이 필요합니다.

```bash
npm install
npm run check
npm run package:check
pi -e .
```

Maintainer release guide: [docs/PUBLISHING.md](docs/PUBLISHING.md)

## License / attribution

Original code는 [MIT License](LICENSE)입니다. 수정·적용한 OpenAI Codex Guardian policy/prompt material은 [Apache License 2.0](LICENSES/Apache-2.0.txt)의 적용을 받습니다. 자세한 내용은 [NOTICE](NOTICE)를 참조하세요.

이 project는 Guardian-inspired이며 OpenAI와 제휴하거나 보증받지 않았습니다.
