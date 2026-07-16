<div align="center">

# pi-approval-guardian

**A fail-closed, Codex Guardian-style automatic approval gate for Pi.**

Route configured shell actions, private reads/searches, and sensitive/out-of-project mutations through an isolated reviewer model before execution.

[![npm version](https://img.shields.io/npm/v/pi-approval-guardian.svg)](https://www.npmjs.com/package/pi-approval-guardian)
[![CI](https://github.com/mics8128/pi-approval-guardian/actions/workflows/ci.yml/badge.svg)](https://github.com/mics8128/pi-approval-guardian/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Pi package](https://img.shields.io/badge/Pi-package-6c5ce7)](https://pi.dev/)

**English** · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

</div>

> [!IMPORTANT]
> Pi extensions execute with your user permissions. Review this package's source before installation. This extension is an approval gate, not an operating-system sandbox.

## Why this exists

Coding agents need shell access, but an agent can misunderstand scope, follow prompt injection from untrusted output, choose a destructive implementation, or mutate a sensitive file that the user never authorized.

`pi-approval-guardian` adds a separate automatic reviewer between selected Pi tool calls and execution:

```text
Pi agent tool call
        │
        ├─ ordinary read or in-project source edit ───────► execute normally
        │
        └─ configured bash / private read or grep / sensitive mutation
                         │
                         ▼
              isolated Guardian reviewer
              normal: read · grep · find · ls; private-data: no tools
                         │
             ┌───────────┴───────────┐
             ▼                       ▼
       reviewer allow            everything else
          execute                block (fail closed)
```

The reviewer separately evaluates intrinsic risk and user authorization. Only a valid `{"outcome":"allow"}` permits execution.

## Quick start

### Install from npm

```bash
pi install npm:pi-approval-guardian
```

Project-local installation:

```bash
pi install -l npm:pi-approval-guardian
```

### Configure a reviewer model

Create `~/.pi/agent/approval-guardian.json`:

```json
{
  "model": "openai-codex/codex-auto-review",
  "timeoutMs": 90000,
  "policy": "Never mutate production unless the user explicitly approves the exact target and side effects.",
  "review": {
    "bash.command": "always",
    "read.path": "private-only",
    "hypa_read.path": "private-only",
    "grep.path": "always",
    "write.path": "outside-or-private",
    "edit.path": "outside-or-private"
  }
}
```

Authenticate the official Codex channel in Pi with `/login openai-codex` (ChatGPT Plus/Pro). `codex-auto-review` is an OpenAI Codex model marked hidden but `supported_in_api`; Pi does not list it in the normal model catalog, so this extension derives its transport metadata from the registered official `openai-codex` provider while preserving the exact `codex-auto-review` upstream model ID.

A configured channel still takes precedence. For example, a CLIProxyAPI-compatible private provider may expose the same model as:

```json
{
  "model": "llm-esapp/codex-auto-review",
  "timeoutMs": 90000
}
```

Custom providers and model aliases must already exist in Pi's model registry and authentication. Only the official `openai-codex/codex-auto-review` hidden model receives the built-in catalog fallback.

### Verify

Restart Pi or run `/reload`, then check:

```text
/approval-guardian
```

Harmless test:

```text
Ask Pi to run: printf '%s\n' 'guardian-ok'
```

Expected compact notification:

```text
Guardian · allowed · low risk · auth high
```

## Complete feature list

### Interception and enforcement

| Feature | Behavior |
| --- | --- |
| All agent `bash` calls | Every Pi agent-issued `bash` tool call is reviewed before execution. Shell commands that read blacklisted private sources require explicit authorization under the reviewer policy. |
| Private `read`/`hypa_read` calls | Blacklisted private files/directories are sent to the reviewer, which allows only when the transcript contains explicit user authorization. |
| Private `grep` calls | `grep.path`, pattern, glob, and scope are reviewed under the same private-path policy. |
| Sensitive `write` calls | Reviewed when the canonical target is outside the project or matches sensitive-path rules. |
| Sensitive `edit` calls | Reviewed under the same outside-project and sensitive-path rules. |
| Ordinary source edits | Normal in-project `write`/`edit` calls bypass the reviewer to avoid unnecessary latency. |
| Explicit allow contract | Only a parsed reviewer response with `outcome: "allow"` executes. |
| Fail closed | Denial, timeout, provider failure, invalid JSON, cancellation, unavailable model/auth, or open circuit blocks the action. |
| No automatic workaround | A denial tells the agent not to retry through indirect execution or policy circumvention. |
| Direct user shell excluded | Commands entered directly with Pi `!`/`!!`, another terminal, or another process are not intercepted. |
| Other path-based tools | An unconfigured tool with a string `path` parameter defaults to `private-only`; tools without a recognized path remain outside the gate. |

Run `/approval-guardian rules` to display the effective `tool.parameter → reviewer scope` matrix. Supported levels are `always`, `outside-or-private`, `private-only`, and `off`. Every review is performed by the isolated AI reviewer; the extension never displays an approval dialog.

### Private-read blacklist

The blacklist intentionally targets obvious private sources rather than attempting to be a complete data-loss-prevention system. Matching is based on the canonical path.

| Scope | Examples requiring explicit authorization verified by the reviewer |
| --- | --- |
| Project-private files | `.env`, `.env.*`, `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `auth.json`, credentials/secrets files, service-account JSON, `*.secret`, `*.secrets`, private-key/certificate formats |
| Project-private directories | `secrets/`, `credentials/` |
| Linux/Unix private locations | `.ssh/`, `.gnupg/`, `.aws/`, `.azure/`, `.kube/`, `.docker/`, `.password-store/`, keyrings, browser profiles, `/etc/ssl/private/`, WireGuard and NetworkManager secrets |
| macOS private locations | `~/Library/Keychains/`, browser profiles, 1Password/Bitwarden data, signing and provisioning profiles |
| Windows private locations | `%USERPROFILE%\\.ssh`, cloud/CLI credentials, browser user-data stores, Credential Manager files, `System32\\config`, and `%PROGRAMDATA%\\ssh` |
| Authenticated CLI config | `.config/gcloud/`, `.config/gh/`, `.config/glab/`, `.config/op/`, `.config/rclone/` |

Authorization is established from explicit user messages in the transcript. If it is missing, the reviewer denies the action and instructs the agent to explain the exact source and purpose, then wait for the user to authorize it in conversation. The extension does not redact content after an authorized read.

### Sensitive-mutation detection

`write` and `edit` are sent to the reviewer when either condition is true:

1. the canonical path is outside the canonical project root; or
2. the path is classified as sensitive.

The classifier resolves existing directory symlinks and dangling file symlinks before comparing project boundaries.

Sensitive categories include:

| Category | Examples |
| --- | --- |
| Environment/secrets | `.env`, `.env.*`, `credentials.json`, `secrets.json`, `secrets/`, `credentials/` |
| Identity/keys | `.ssh/`, `.gnupg/`, `.aws/`, `.kube/`, `authorized_keys`, `*.pem`, `*.key`, `*.p12`, `*.pfx` |
| Shell persistence | `.zshrc`, `.zprofile`, `.zlogin`, `.bashrc`, `.bash_profile`, `.profile` |
| Git and automation | `.git/`, Git hooks/config, `.github/`, `.gitlab-ci.yml` |
| Pi configuration | `.pi/`, `settings.json`, `approval-guardian.json` |
| Package execution surface | `package.json`, npm/pnpm/Yarn lockfiles |
| Infrastructure/deployment | Terraform (`*.tf`, `*.tfvars`, `terraform/`), Kubernetes directories, Docker Compose files |

A sensitive classification does not automatically deny the mutation. It requires Guardian review.

### Reviewer isolation and investigation

| Feature | Behavior |
| --- | --- |
| Dedicated model | Reviewer model is independent of the model selected for the main Pi conversation. |
| In-memory session | Reviewer history is kept in an isolated in-memory Pi session. |
| Restricted tools | Normal reviews enable only `read`, `grep`, `find`, and `ls`; private-data reviews enable no tools, so the reviewer cannot inspect the pending secret before deciding authorization. |
| No mutation tools | Reviewer receives no `bash`, `write`, or `edit` tool. |
| No extension recursion | Reviewer loads no extensions, skills, prompt templates, themes, or project context files. |
| Low reasoning level | Reviewer session runs with Pi thinking level `low`. |
| Local investigation | Reviewer may inspect scripts, package scripts, mutation targets, configuration, and repository metadata when risk depends on local state. |
| Untrusted evidence | Transcript, tool arguments/results, retry reason, files, and planned action are evidence—not instructions. |

The tool allowlist is **not an OS sandbox**. The reviewer still reads files with the current user's operating-system permissions.

### Prompt and policy

The policy is synchronized to selected concepts from OpenAI Codex Guardian commit [`03bb3b12367397e14a8facc2e018d645ff4d8e83`](https://github.com/openai/codex/tree/03bb3b12367397e14a8facc2e018d645ff4d8e83/codex-rs/core/src/guardian).

Implemented policy features:

- transcript/action separation with explicit delimiters;
- prompt-injection-resistant untrusted-evidence framing;
- four risk levels: `low`, `medium`, `high`, `critical`;
- four authorization levels: `unknown`, `low`, `medium`, `high`;
- low/medium actions normally allowed;
- high-risk actions allowed only with sufficient authorization, narrow scope, and no absolute deny rule;
- critical actions denied;
- secret/private-data exfiltration to untrusted destinations denied even with high authorization;
- credential probing, persistent security weakening, destructive actions, bounded Git operations, and narrow local deletion rules;
- exact informed post-denial user approval handling;
- optional additive organization policy;
- strict JSON final response contract.

Source references:

- [Prompt construction](https://github.com/openai/codex/blob/03bb3b12367397e14a8facc2e018d645ff4d8e83/codex-rs/core/src/guardian/prompt.rs)
- [Policy template](https://github.com/openai/codex/blob/03bb3b12367397e14a8facc2e018d645ff4d8e83/codex-rs/core/src/guardian/policy_template.md)
- [Default tenant policy](https://github.com/openai/codex/blob/03bb3b12367397e14a8facc2e018d645ff4d8e83/codex-rs/core/src/guardian/policy.md)
- [Review flow](https://github.com/openai/codex/blob/03bb3b12367397e14a8facc2e018d645ff4d8e83/codex-rs/core/src/guardian/review.rs)

### Transcript selection and truncation

| Limit | Value |
| --- | ---: |
| Message transcript budget | 40,000 characters |
| Tool transcript budget | 40,000 characters |
| Single message entry | 8,000 characters |
| Single tool entry | 4,000 characters |
| Planned action payload | 64,000 characters |
| Recent non-user entries | 40 |

Selection prioritizes first/latest user intent, other recent user messages when space permits, and recent assistant/tool evidence. Long entries are middle-truncated with explicit markers. Omitted history is disclosed to the reviewer.

### Session reuse and transcript delta

- The initial assessment sends a bounded full transcript.
- Successful assessments advance a parent-history cursor.
- Later assessments reuse the isolated reviewer session and send only new transcript entries plus the new action.
- Calls are serialized, so concurrent tool calls cannot prompt the same reviewer session concurrently.
- If branch history diverges/shrinks, or the working directory, model, timeout, or effective policy changes, the old reviewer session is disposed and a full transcript is sent.
- Failed retry attempts discard reviewer state and retry from a fresh full transcript.
- Session shutdown/reload disposes reviewer state and aborts an active reviewer request.

### Retry and deadline behavior

| Feature | Value |
| --- | ---: |
| Maximum attempts | 3 |
| Initial backoff | 200 ms |
| Backoff factor | 2× |
| Jitter | 0.9–1.1× |
| Default shared deadline | 90 seconds |
| Configurable deadline range | 1–300 seconds |

Retries occur for invalid assessment JSON and provider errors classified by Pi as transient (for example overload, rate limiting, transient HTTP 5xx, transport/fetch/stream failures). Quota/billing exhaustion is not treated as transient.

All attempts, session startup, prompt execution, and retry waits share one deadline. Explicit allow, explicit denial, cancellation, and terminal timeout are not retried.

### Failure classification

The extension does not disguise infrastructure errors as policy denials:

| Result | Meaning | Execution |
| --- | --- | --- |
| `allowed` | Reviewer explicitly returned allow | Execute |
| `denied` | Reviewer explicitly returned deny | Block and provide no-workaround guidance |
| `timeout` | Shared review deadline expired | Block |
| `failure` | Model/auth/session/provider/parser failure | Block |
| `cancelled` | Parent run, reload, or shutdown cancelled review | Block |
| `circuit-open` | Repeated explicit denials exceeded the per-run limit | Block without another reviewer call |

### Denial circuit breaker

Within one Pi agent run:

- 3 consecutive explicit denials open the circuit; or
- 10 explicit denials among the latest 50 recorded reviews open the circuit.

Only valid reviewer `deny` outcomes count as denials. Allow, timeout, failure, and cancellation record non-denials. When the circuit opens, the current run is aborted and later covered actions are blocked without spending another reviewer request.

### Compact UI

| State | Example |
| --- | --- |
| Reviewing | `Guardian · reviewing` |
| Parallel/queued count | `Guardian · reviewing 2` |
| Allowed | `Guardian · allowed · low risk · auth high` |
| Explicit denial | `Guardian · blocked · high risk · auth low` plus rationale/action preview |
| Timeout | `Guardian · timed out · blocked` |
| Operational failure | `Guardian · review failed · blocked` |
| Cancellation | `Guardian · cancelled · blocked` |
| Circuit breaker | `Guardian · circuit open · blocked` |

Run `/approval-guardian` to see the effective reviewer model, deadline, attempt limit, policy state, scope, and configuration warnings.

## Configuration

### Global configuration

`~/.pi/agent/approval-guardian.json`:

```json
{
  "model": "openai-codex/codex-auto-review",
  "timeoutMs": 90000,
  "policy": "Never mutate production without exact informed authorization."
}
```

### Project configuration

`<project>/.pi/approval-guardian.json`:

```json
{
  "model": "openai-codex/codex-auto-review",
  "policy": "Never execute terraform destroy in this repository."
}
```

Project configuration is read only when Pi marks the project trusted.

### Environment variables

```bash
export PI_APPROVAL_GUARDIAN_MODEL="openai-codex/codex-auto-review"
export PI_APPROVAL_GUARDIAN_TIMEOUT_MS="90000"
export PI_APPROVAL_GUARDIAN_POLICY='Only read from production databases.'
```

### Precedence

For `model` and `timeoutMs`:

```text
environment > trusted project config > global config > built-in default
```

Policy is additive:

```text
default tenant policy + global policy + trusted project policy + environment policy
```

Review rules use a monotonic floor: global rules may customize built-in defaults, while trusted project rules may only strengthen them using `off < private-only < outside-or-private < always`. A repository cannot disable a user-configured global gate.

Project policy cannot remove global policy.

## Installation and upgrades

### npm

```bash
pi install npm:pi-approval-guardian
```

Pinned version:

```bash
pi install npm:pi-approval-guardian@0.5.0
```

Upgrade installed Pi packages:

```bash
pi update --extensions
```

Remove:

```bash
pi remove npm:pi-approval-guardian
```

### Git

```bash
pi install git:github.com/mics8128/pi-approval-guardian@v0.5.0
```

### Local development

```bash
git clone https://github.com/mics8128/pi-approval-guardian.git
cd pi-approval-guardian
npm install
pi install "$(pwd)"
```

Direct test run:

```bash
pi -e ./extensions/index.ts
```

After local changes, run `/reload` in Pi.

## Examples

### Narrow requested deletion

```text
User: Delete this project's generated .cache directory.
Pi:   rm -rf .cache
```

The reviewer can inspect `.cache`, determine that the target is narrow/generated and authorized, then allow it.

### Unrequested destructive command

```text
Pi: rm -rf ~
```

Expected: high/critical risk denial and blocked execution.

### Sensitive file edit

```text
User: Add this exact host alias to ~/.ssh/config.
Pi edit: ~/.ssh/config
```

The path is outside the project and under `.ssh`, so it is reviewed. Exact informed authorization may permit the bounded edit.

### Ordinary source edit

```text
Pi edit: src/review.ts
```

If it remains inside the project and does not match a sensitive rule, it executes normally without reviewer latency.

## Comparison

### This plugin vs current Codex Guardian

| Capability | pi-approval-guardian | Codex Guardian |
| --- | --- | --- |
| Runtime | Pi TypeScript extension | Native Codex runtime subsystem |
| Trigger | Every Pi agent `bash`; blacklisted private `read`/`hypa_read`; selected `write`/`edit` | Approval requests routed by Codex approval policy |
| Action types | Bash + reviewer-gated private reads/searches + selective file mutations | Shell, exec, execve, apply patch, network, MCP, permission requests |
| Sandbox integration | None; approval gate only | Integrated with Codex permission/sandbox architecture |
| Reviewer tools | Pi `read`, `grep`, `find`, `ls` | Native read-only permission profile |
| Session reuse | Yes, with Pi branch snapshot/delta | Yes, with native transcript cursor/fork state |
| Retry | Up to 3 for parse/transient provider failures | Up to 3 for selected parse/transient session errors |
| Deadline | Shared configurable deadline | Shared 90-second Guardian deadline |
| Circuit breaker | 3 consecutive or 10-in-50 per Pi agent run | Equivalent upstream denial thresholds within Codex turn state |
| Structured output | Prompt contract + defensive JSON parser | JSON schema plus defensive parser |
| Policy configuration | Global/project/env additive policy | Managed tenant/catalog policy/template |
| Telemetry | No Guardian analytics backend | Native assessment events and analytics |

This project is **Codex Guardian-style**, not an official OpenAI component and not behaviorally identical to Codex.

### This plugin vs Pi project trust vs no guard

| Capability | This plugin | Pi project trust | No guard |
| --- | ---: | ---: | ---: |
| Reviews agent shell actions | ✅ | ❌ | ❌ |
| Requires reviewer authorization for blacklisted private reads | ✅ | ❌ | ❌ |
| Reviews sensitive/outside file mutations | ✅ | ❌ | ❌ |
| Controls loading project-local Pi resources | ❌ | ✅ | ❌ |
| Uses an independent risk reviewer | ✅ | ❌ | ❌ |
| Fails closed when reviewer unavailable | ✅ | N/A | ❌ |
| OS-level containment | ❌ | ❌ | ❌ |

Use Pi project trust and this extension together; they solve different problems.

## Security and privacy model

- Blacklisted `read`, `hypa_read`, `grep`, and generic path-based calls are reviewed before execution; the reviewer requires explicit authorization in the user transcript.
- An authorized private read is not redacted; its result enters the main agent conversation like any other tool result.
- The reviewer provider receives a bounded transcript and planned action.
- The reviewer can use read-only Pi tools to inspect local files with your user permissions.
- Tool/file content may contain sensitive data; use a provider you trust.
- The extension has no telemetry of its own.
- The restricted reviewer tool list is not an operating-system sandbox.
- Approved commands execute with Pi's normal environment and privileges.
- The sensitive-path list is heuristic, not a comprehensive DLP policy.
- Filesystem state may change between path classification and execution.
- Context/action truncation can omit relevant evidence; policy tells the reviewer to become cautious when evidence is missing.
- A model decision is probabilistic. This gate reduces risk; it does not prove safety.

## Known limitations

- Does not intercept direct `!`/`!!` commands, other terminals, or other processes.
- Does not review ordinary in-project source edits.
- Does not currently gate MCP, network, deployment, email, browser, subagent, or arbitrary custom tools other than the recognized `hypa_read` path input.
- Private-read protection is an explicit cross-platform blacklist, not a complete file-read boundary; renamed secrets, unusual credential stores, pathless tools, and indirect reads may fall outside it.
- Shell-based private reads depend on reviewer policy because shell syntax is not fully parsed into a canonical target path.
- Does not enforce an OS sandbox.
- Reviewer session integration paths are harder to unit-test than pure policy/path logic; use controlled smoke tests after upgrades.
- Provider availability becomes an availability dependency because the extension intentionally fails closed.

## Development

Requirements: Node.js 22.19+.

```bash
npm install
npm run check
npm run package:check
```

Current checks:

- strict TypeScript typecheck;
- Node test runner for config precedence/trust;
- prompt, transcript, policy, and parser behavior;
- circuit-breaker thresholds;
- outside/sensitive path classification;
- existing and dangling symlink escape detection;
- npm tarball preview.

Project structure:

```text
extensions/index.ts       Pi hooks, UI, controller wiring, action interception
src/config.ts             Global/project/environment configuration
src/policy.ts             Synced Guardian template/default tenant policy
src/review.ts             Action prompt, transcript budgeting, JSON parser
src/reviewer-session.ts   Isolated session reuse, delta, retry, deadline, cleanup
src/gate.ts               Result types, circuit breaker, sensitive path classifier
tests/*.test.ts           Unit tests
docs/PUBLISHING.md        Maintainer npm release guide
```

## Publishing

The npm name `pi-approval-guardian` was available when last checked, and the local npm identity was authenticated as `mics8128`. No release is performed merely by building this repository.

Maintainers: read [docs/PUBLISHING.md](docs/PUBLISHING.md) before publishing. The repository includes a GitHub Actions trusted-publishing workflow using npm OIDC and provenance.

Useful local release gates:

```bash
npm whoami
npm view pi-approval-guardian name version
npm run check
npm run package:check
npm run publish:check
```

## Contributing

Issues and focused pull requests are welcome. Security-sensitive changes should include tests and should preserve fail-closed behavior.

## License and third-party notices

Original project code is licensed under the [MIT License](LICENSE).

`src/policy.ts` contains modified and adapted portions of OpenAI Codex Guardian policy/prompt materials, which remain subject to the [Apache License 2.0](LICENSES/Apache-2.0.txt). See [NOTICE](NOTICE) for attribution and a description of modifications.

“OpenAI” and “Codex” are used only to identify the upstream source and compatibility inspiration. This project is not affiliated with or endorsed by OpenAI.
