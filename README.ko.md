# pi-approval-guardian

**Pi tool call을 fail-closed 방식으로 자동 검토합니다.**

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
| `grep.path` | broad/pathless search를 포함해 항상 검토 |
| `read.path` | 알려진 private data |
| `find.path` / `ls.path` | 알려진 private path |
| `write.path` / `edit.path` | 프로젝트 외부 또는 private/sensitive path |
| 문자열 `path`를 가진 다른 tool | 기본 `private-only` |

일반적인 프로젝트 내부 source edit는 reviewer 지연 없이 실행됩니다. 사용자가 직접 입력한 `!`/`!!`, 다른 terminal, 다른 process는 가로채지 않습니다.

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

유효한 `outcome: "allow"`만 실행됩니다. Deny, timeout, invalid output, auth/model/provider failure, cancel, circuit open은 모두 fail closed입니다.

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

- 메인 대화와 분리된 model/in-memory session.
- Normal review는 `read`, `grep`, `find`, `ls`만 제공.
- Private-data authorization review는 tools 없음.
- Reviewer에 `bash`, `write`, `edit`를 제공하지 않음.
- Transcript, file, tool output, planned action은 untrusted evidence.
- Shared deadline 안에서 invalid assessment와 일부 transient provider failure를 최대 3 attempts.

3 consecutive explicit-denial batches 또는 최근 50 review batches 중 10 denial이면 circuit이 열립니다. 같은 assistant message의 sibling tool calls는 한 batch이므로 여러 동시 denial은 한 번만 계산합니다.

## 선택 설정

Global: `~/.pi/agent/approval-guardian.json`

Trusted project: `<project>/.pi/approval-guardian.json`

```json
{
  "model": "openai-codex/codex-auto-review",
  "timeoutMs": 90000,
  "policy": "정확한 승인 없이 production을 수정하지 않는다."
}
```

Pi model registry에 등록되고 인증된 custom reviewer channel도 사용할 수 있습니다.

Default review matrix:

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

Levels: `always`, `outside-or-private`, `private-only`, `off`.

Trusted project는 global protection을 강화만 할 수 있습니다:

```text
off < private-only < outside-or-private < always
```

Environment variables: `PI_APPROVAL_GUARDIAN_MODEL`, `PI_APPROVAL_GUARDIAN_TIMEOUT_MS`, `PI_APPROVAL_GUARDIAN_POLICY`.

Model/timeout precedence: `environment > trusted project > global > built-in default`. Policy는 global, trusted project, environment 설정을 합산합니다.

`/approval-guardian rules`로 effective rules를 확인할 수 있습니다.

## 업데이트 / 제거

```bash
pi update npm:pi-approval-guardian
```

업데이트 후 `/reload`를 실행합니다.

```bash
pi remove npm:pi-approval-guardian
```

Project-local install:

```bash
pi install -l npm:pi-approval-guardian
```

Versioned npm spec은 pin됩니다. Pin을 변경하려면 새로운 explicit version을 설치하세요.

## Security limitations

- Approved action은 Pi의 일반 사용자 권한으로 실행됩니다.
- Reviewer decision은 probabilistic합니다.
- Reviewer provider는 bounded transcript와 planned-action metadata를 받습니다.
- Authorized private read는 main conversation에서 redaction되지 않습니다.
- Path rules는 heuristic이며 모든 renamed/indirect secret을 감지하지 못합니다.
- Shell은 완전한 AST로 파싱되지 않습니다.
- Filesystem state는 review와 execution 사이에 변경될 수 있습니다.
- Pathless custom tools, MCP, network, browser, email, deployment, subagent action이 자동으로 모두 보호되지는 않습니다.
- Reviewer/provider를 사용할 수 없으면 protected action을 block합니다.

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
