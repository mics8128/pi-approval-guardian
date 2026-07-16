# pi-approval-guardian

**A fail-closed approval gate for Pi tool calls.**

It reviews agent shell commands, private-data access, and sensitive file mutations with an isolated reviewer model before execution.

[![npm version](https://img.shields.io/npm/v/pi-approval-guardian.svg)](https://www.npmjs.com/package/pi-approval-guardian)
[![CI](https://github.com/mics8128/pi-approval-guardian/actions/workflows/ci.yml/badge.svg)](https://github.com/mics8128/pi-approval-guardian/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Pi package](https://img.shields.io/badge/Pi-package-6c5ce7)](https://pi.dev/packages/pi-approval-guardian)

**English** · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

> [!IMPORTANT]
> Pi extensions run with your user permissions. Review the source before installation. Approval Guardian reduces risk but is not an operating-system sandbox.

## Install

```bash
pi install npm:pi-approval-guardian
```

The built-in defaults use `openai-codex/codex-auto-review` with a 90-second deadline. If the official Codex provider is not authenticated yet, run:

```text
/login openai-codex
/reload
/approval-guardian
```

No configuration file is required for the default setup.

## What it protects

| Tool/action | Default review scope |
| --- | --- |
| `bash.command` | Always reviewed |
| `grep.path` | Reviewed outside the project or when path/pattern/glob/effective scope may expose private data |
| `read.path` | Reviewed for known private data |
| `find.path` / `ls.path` | Reviewed for known private paths |
| `write.path` / `edit.path` | Reviewed outside the project or on private/sensitive paths |
| Other tools with a string `path` | Default to `private-only` |

Ordinary clean in-project source edits and searches run without reviewer latency. Commands entered directly through Pi `!`/`!!`, another terminal, or another process are not intercepted.

## How it works

```text
Pi agent tool call
        │
        ├─ ordinary action ───────────────────────────────► execute
        │
        └─ covered action
               │
               ▼
      isolated Guardian reviewer
      normal review: read · grep · find · ls
      private-data review: no tools
               │
         ┌─────┴─────┐
         ▼           ▼
       allow      anything else
       execute     block
```

Only a valid reviewer response with `outcome: "allow"` permits execution. Denials, timeouts, invalid output, missing authentication, provider failures, cancellation, and an open circuit all fail closed.

Private-data access additionally requires explicit authorization in the user transcript and reviewer `user_authorization: "high"`. The reviewer cannot inspect the pending private target while deciding whether access is authorized.

## Private-data rules

The classifier targets common credential and private-data locations without attempting to be a full DLP system.

Examples include:

- `.env`, `.npmrc`, `.netrc`, `.pypirc`, Git credentials, service-account files, and credential/secret directories;
- SSH/GPG keys, cloud CLI credentials, Kubernetes and Docker authentication;
- browser login stores, password managers, keychains/keyrings, VPN material, private certificates and Terraform credentials;
- common Linux, macOS, and Windows credential locations;
- Pi authentication, settings/model/Guardian/trust files, API-key files, run/session/delegate history, memory, context/session databases, and search indexes.

The entire `.pi/` directory is **not** treated as private. Installed package code and skill documentation under `.pi/agent/npm/node_modules/`, plus user skill/agent/extension source, are not private solely because they are stored under `.pi/`. Individual files may still match another private rule.

Read classification and mutation classification are separate: project `.pi/skills`, `.pi/agents`, `.pi/extensions`, prompts, themes, chains, and package metadata remain sensitive mutation surfaces because changing them can alter Pi behavior. They are reviewed before mutation, not treated as confidential merely when read.

Canonical paths and symlink targets are checked before project-boundary decisions.

## Reviewer behavior

- Keeps reviewer state in an isolated in-memory session; the final fallback may use the main session's model identity but never its conversation state.
- Provides only read-only investigation tools for normal reviews.
- Provides no tools for private-data authorization reviews.
- Never provides `bash`, `write`, or `edit` to the reviewer.
- Treats transcript, files, tool output, and planned actions as untrusted evidence.
- Reuses each distinct channel's reviewer session with bounded full-to-delta transcript updates.
- Retries malformed output and selected transient provider failures up to three attempts within one shared deadline per reviewer channel.

Three consecutive adverse batches, or ten adverse batches among the latest fifty reviews, open the per-run circuit. Denials, timeouts, and failures are adverse; allows and cancellations are not. Sibling tool calls emitted by one assistant message form one batch.

## Optional configuration

Global configuration:

```text
~/.pi/agent/approval-guardian.json
```

Trusted project configuration:

```text
<project>/.pi/approval-guardian.json
```

Minimal example:

```json
{
  "model": "openai-codex/codex-auto-review",
  "fallbackModel": "openai-codex/codex-auto-review",
  "timeoutMs": 90000,
  "policy": "Never mutate production without exact informed authorization."
}
```

Custom reviewer channels are supported when the provider/model is already registered and authenticated in Pi. After deduplication, Guardian tries the configured primary, configured `fallbackModel`, and finally the current Pi session model. It advances only after a missing model, unusable authentication, or explicit failure. A timeout is terminal for that action and fails closed without trying another channel; allow, explicit deny, and cancellation also stop the chain. Each channel uses its own isolated, incrementally reused reviewer session, and switch notices are UI-only.

### Review scopes

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

Available levels:

- `always`
- `outside-or-private`
- `private-only`
- `off`

Trusted project rules may strengthen, but cannot weaken, the effective global floor:

```text
off < private-only < outside-or-private < always
```

The defaults review every agent-issued `bash` command, while ordinary in-project `grep` searches bypass reviewer latency unless their path, selector, or effective scope may expose private data. Set `grep.path` to `always` for a stricter profile. Disabling `bash.command` removes a major security boundary and is appropriate only when another trusted shell gate or sandbox provides equivalent enforcement.

### Environment variables

```bash
export PI_APPROVAL_GUARDIAN_MODEL="openai-codex/codex-auto-review"
export PI_APPROVAL_GUARDIAN_FALLBACK_MODEL="openai-codex/codex-auto-review"
export PI_APPROVAL_GUARDIAN_TIMEOUT_MS="90000"
export PI_APPROVAL_GUARDIAN_POLICY="Only perform the explicitly requested production action."
```

Primary model, fallback model, and timeout precedence:

```text
environment > trusted project > global > built-in default
```

Policy is additive across global, trusted-project, and environment configuration.

Run `/approval-guardian` to inspect primary, configured-fallback, and current-model readiness plus effective config sources, or `/approval-guardian rules` for the rule matrix.

## Update and remove

Update this package:

```bash
pi update npm:pi-approval-guardian
```

Reload the active Pi session:

```text
/reload
```

Remove it:

```bash
pi remove npm:pi-approval-guardian
```

Project-local installation and removal:

```bash
pi install -l npm:pi-approval-guardian
pi remove -l npm:pi-approval-guardian
```

Run `/reload` after removal to unload it from the current session.

A versioned install such as `npm:pi-approval-guardian@<version>` is pinned. Install a newer explicit version to move that pin.

## Security and limitations

- Approved actions execute with Pi's normal user permissions.
- Reviewer decisions are probabilistic and can be wrong.
- The reviewer provider receives a bounded transcript and planned-action metadata.
- An authorized private read is not redacted from the main conversation.
- Paths use Pi-compatible `~`, `@`, `file://`, and Unicode-space normalization before classification, but the rules remain heuristic; unusual or renamed secrets may not be detected.
- Shell syntax is not fully parsed; Guardian uses bounded glob matching for common private targets, so indirect shell reads may still fall outside deterministic detection.
- After an allow, Guardian validates and locks JSON-like tool input against later `tool_call` handler mutation; exotic runtime values fail closed. It does not observe commandPrefix, spawnHook, custom-tool internals, or filesystem changes after dispatch.
- Arbitrary pathless or nested-path custom tools, MCP, network, browser, email, deployment, and subagent actions are not automatically gated; they need dedicated enforcement.
- Filesystem state can change between review and execution.
- If the configured primary, configured fallback, and distinct current-model fallback are all unavailable, protected actions fail closed.
- Use Pi project trust and OS/container sandboxing separately; they solve different security layers.

For the full behavior and configuration contract, see [docs/REFERENCE.md](docs/REFERENCE.md).

## Development

Requires Node.js 22.19 or newer.

```bash
npm install
npm run check
npm run package:check
```

Test the local package without installing it:

```bash
pi -e .
```

Issues and focused pull requests are welcome. Security-sensitive changes should include regression tests and preserve fail-closed behavior.

Maintainers: see [docs/PUBLISHING.md](docs/PUBLISHING.md).

## License and attribution

Original project code is licensed under the [MIT License](LICENSE).

Modified and adapted OpenAI Codex Guardian policy/prompt material remains subject to the [Apache License 2.0](LICENSES/Apache-2.0.txt). See [NOTICE](NOTICE) for attribution and modification details.

This project is Guardian-inspired and is not affiliated with or endorsed by OpenAI.
