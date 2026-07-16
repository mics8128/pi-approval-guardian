<div align="center">

# pi-approval-guardian

**Pi를 위한 fail-closed Codex Guardian 스타일 자동 승인 게이트.**

에이전트가 실행하는 모든 `bash`와 프로젝트 외부/민감 경로의 `write`, `edit`를 독립 reviewer model이 실행 전에 검토합니다.

[![npm version](https://img.shields.io/npm/v/pi-approval-guardian.svg)](https://www.npmjs.com/package/pi-approval-guardian)
[![CI](https://github.com/mics8128/pi-approval-guardian/actions/workflows/ci.yml/badge.svg)](https://github.com/mics8128/pi-approval-guardian/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **한국어** · [Español](README.es.md)

</div>

> [!IMPORTANT]
> Pi extension은 사용자 권한으로 실행됩니다. 설치 전에 소스를 검토하세요. 이 패키지는 승인 게이트이며 OS sandbox가 아닙니다.

## 빠른 시작

```bash
pi install npm:pi-approval-guardian
```

`~/.pi/agent/approval-guardian.json`:

```json
{
  "model": "llm-esapp/codex-auto-review",
  "timeoutMs": 90000,
  "policy": "정확한 대상과 부작용에 대한 명시적 승인이 없으면 production을 변경하지 않는다."
}
```

Pi를 재시작하거나 `/reload` 후 `/approval-guardian`을 실행하세요.

## 동작 방식

```text
Pi agent tool call
  ├─ 일반 프로젝트 내부 source edit ─────────► 정상 실행
  └─ bash / sensitive write / sensitive edit
                  ▼
       isolated Guardian reviewer
       read · grep · find · ls only
                  ▼
       명시적 allow만 실행, 나머지는 block
```

유효한 `{"outcome":"allow"}`만 실행됩니다. deny, timeout, provider failure, 잘못된 JSON, cancellation, model/auth 오류, circuit open은 모두 fail closed입니다.

## 전체 기능

### 보호 범위

| 기능 | 동작 |
| --- | --- |
| 모든 agent `bash` | 실행 전에 항상 검토합니다. |
| 민감 `write` | canonical target이 프로젝트 외부이거나 민감 규칙과 일치할 때 검토합니다. |
| 민감 `edit` | `write`와 같은 경계/민감 규칙을 사용합니다. |
| 일반 source edit | 프로젝트 내부의 비민감 수정은 reviewer 지연 없이 실행합니다. |
| Direct shell 제외 | 사용자의 `!`/`!!`, 다른 terminal/process는 가로채지 않습니다. |
| 기타 tools 제외 | 현재 `bash`, `write`, `edit`만 처리합니다. |

### 민감 경로

다음 범주와 프로젝트 외부 경로가 검토 대상입니다.

- `.env`, credentials, secrets;
- `.ssh/`, `.gnupg/`, `.aws/`, `.kube/`, key/certificate 파일;
- `.zshrc`, `.bashrc`, `.profile` 등 shell persistence;
- `.git/`, hooks/config, `.github/`, GitLab CI;
- `.pi/`, settings, Guardian config;
- `package.json`과 npm/pnpm/Yarn lockfiles;
- Terraform, Kubernetes, Docker Compose.

기존 directory symlink와 dangling file symlink를 해석하여 프로젝트 외부 쓰기를 감지합니다. 민감 판정은 자동 deny가 아니라 reviewer 검토를 요구합니다.

### Reviewer 격리

- 메인 대화와 독립된 model/in-memory session;
- `read`, `grep`, `find`, `ls`만 활성화;
- `bash`, `write`, `edit` 없음;
- extensions, skills, prompt templates, themes, project context files 미로딩;
- `low` thinking level;
- scripts, package scripts, 대상 파일, 설정, repository metadata를 read-only로 조사 가능;
- transcript/tool output/files/retry reason/action을 untrusted evidence로 처리.

도구 제한은 OS sandbox가 아닙니다. Reviewer는 현재 사용자가 읽을 수 있는 파일을 읽을 수 있습니다.

### Policy와 prompt

OpenAI Codex Guardian commit [`03bb3b12367397e14a8facc2e018d645ff4d8e83`](https://github.com/openai/codex/tree/03bb3b12367397e14a8facc2e018d645ff4d8e83/codex-rs/core/src/guardian)의 관련 설계를 동기화합니다.

- risk: `low`, `medium`, `high`, `critical`;
- authorization: `unknown`, `low`, `medium`, `high`;
- low/medium은 일반적으로 allow;
- high는 충분한 authorization, 좁은 범위, absolute deny 없음이 필요;
- critical은 deny;
- 신뢰하지 않는 대상으로 secret/private data 유출은 high authorization이어도 deny;
- prompt injection, credential probing, persistent security weakening, destructive action, Git, 제한된 삭제, informed re-approval 규칙;
- additive organization policy;
- strict JSON response.

### Transcript 제한

| 항목 | 제한 |
| --- | ---: |
| Message transcript | 40,000 chars |
| Tool transcript | 40,000 chars |
| Message entry | 8,000 chars |
| Tool entry | 4,000 chars |
| Planned action | 64,000 chars |
| Recent non-user entries | 40 |

첫/최신 user intent와 최근 assistant/tool evidence를 우선하며 긴 내용은 middle truncation합니다.

### Session reuse / delta

- 첫 검토는 full transcript;
- 성공 후 reviewer session을 재사용하고 새 transcript delta만 전송;
- call 직렬화;
- branch/cwd/model/timeout/policy 변경 시 재생성;
- retry는 새 session과 full transcript;
- reload/shutdown 시 cleanup/cancel.

### Retry / deadline

| 기능 | 값 |
| --- | ---: |
| 최대 attempts | 3 |
| 초기 backoff | 200 ms |
| factor | 2× |
| jitter | 0.9–1.1× |
| 기본 shared deadline | 90초 |
| 설정 범위 | 1–300초 |

잘못된 assessment JSON과 Pi가 transient로 분류하는 overload, rate limit, HTTP 5xx, fetch/transport/stream 오류를 retry합니다. Quota/billing exhaustion은 retry하지 않습니다. Startup, attempts, prompt, waits는 하나의 deadline을 공유합니다.

### Failure 분류

- `allowed`: 실행;
- `denied`: block + workaround 금지;
- `timeout`: block;
- `failure`: block;
- `cancelled`: block;
- `circuit-open`: reviewer 호출 없이 block.

### Denial circuit breaker

하나의 Pi agent run에서 3회 연속 명시적 deny 또는 최근 50 reviews 중 10 deny가 발생하면 circuit이 열립니다. Run을 abort하고 이후 보호 대상 action을 즉시 block합니다.

### UI

`reviewing`, `allowed`, `blocked`, `timed out`, `review failed`, `cancelled`, `circuit open`을 짧은 Guardian 상태 메시지로 표시합니다.

## 설정

Global: `~/.pi/agent/approval-guardian.json`

Project: `<project>/.pi/approval-guardian.json` (trusted project만)

환경 변수:

```bash
PI_APPROVAL_GUARDIAN_MODEL
PI_APPROVAL_GUARDIAN_TIMEOUT_MS
PI_APPROVAL_GUARDIAN_POLICY
```

Model/timeout: `environment > trusted project > global > default`

Policy: `default + global + trusted project + environment`

## 설치/업데이트

```bash
pi install npm:pi-approval-guardian
pi install npm:pi-approval-guardian@0.2.0
pi update --extensions
pi remove npm:pi-approval-guardian
```

Git:

```bash
pi install git:github.com/mics8128/pi-approval-guardian@v0.2.0
```

## Codex Guardian 비교

| 기능 | pi-approval-guardian | Codex Guardian |
| --- | --- | --- |
| Runtime | Pi TypeScript extension | Native Codex subsystem |
| Trigger | 모든 agent bash + 선택적 write/edit | Codex approval policy |
| Actions | Bash + sensitive files | Shell/exec/patch/network/MCP/permissions |
| Sandbox | 없음, approval gate만 | Codex permissions/sandbox 통합 |
| Session delta | 지원 | 지원 |
| Retry | parse/transient provider 최대 3 | selected parse/session 최대 3 |
| Structured output | Prompt + parser | JSON Schema + parser |
| Analytics | 없음 | Native events/analytics |

이 프로젝트는 **Codex Guardian-style**이며 OpenAI 공식 구성요소가 아닙니다.

## 보안, 개인정보, 제한

Reviewer provider는 bounded transcript/action을 받고 read-only tools로 로컬 파일을 읽을 수 있습니다. 신뢰하는 provider를 사용하세요. 자체 telemetry는 없습니다. 승인된 command는 Pi의 일반 권한으로 실행됩니다. 민감 경로 목록은 heuristic이며 완전한 DLP가 아닙니다. LLM 판단은 확률적입니다.

`!`/`!!`, 다른 terminal, MCP, network, deployment, email, browser, subagent, arbitrary custom tools는 현재 범위 밖입니다.

## 개발/배포

Node.js 22.19+:

```bash
npm install
npm run check
npm run package:check
```

npm 배포는 [docs/PUBLISHING.md](docs/PUBLISHING.md)를 참고하세요. GitHub Actions trusted publishing/OIDC workflow가 포함되어 있습니다.

## 라이선스 및 제3자 고지

프로젝트 고유 코드는 [MIT License](LICENSE)를 따릅니다. `src/policy.ts`에는 OpenAI Codex Guardian에서 수정·적용한 내용이 포함되며 해당 부분은 [Apache License 2.0](LICENSES/Apache-2.0.txt)을 따릅니다. 출처와 변경 사항은 [NOTICE](NOTICE)를 참조하세요. 이 프로젝트는 OpenAI의 공식 또는 승인 프로젝트가 아닙니다.
