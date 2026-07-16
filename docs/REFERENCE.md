# Approval Guardian reference

This document defines the runtime behavior and configuration contract for `pi-approval-guardian`.

## Interception matrix

| Rule | Default | Behavior |
| --- | --- | --- |
| `bash.command` | `always` | Reviews every Pi agent-issued shell command. |
| `grep.path` | `always` | Reviews path, pattern, glob, and effective search scope. Empty paths fall back to the current working directory. |
| `read.path` | `private-only` | Reviews canonical targets classified as private. |
| `find.path` | `private-only` | Reviews known private targets. |
| `ls.path` | `private-only` | Reviews known private targets. |
| `write.path` | `outside-or-private` | Reviews targets outside the project and private/sensitive mutations. |
| `edit.path` | `outside-or-private` | Uses the same boundary and sensitivity rules as `write`. |

An unconfigured tool with a top-level string `path` parameter defaults to `private-only`. Tools without that recognized top-level path, including nested-path and pathless custom tools, remain outside the gate unless they have dedicated enforcement.

Direct user shell commands entered with `!`/`!!` do not pass through the agent `tool_call` hook.

## Review levels

- `always`: review every matching action.
- `outside-or-private`: review paths outside the canonical project root or classified as private/sensitive.
- `private-only`: review only paths classified as private.
- `off`: do not review that configured tool parameter.

Global rules layer over built-in defaults. Trusted project rules use a monotonic floor and may only strengthen effective protection:

```text
off < private-only < outside-or-private < always
```

## Configuration

Global file:

```text
~/.pi/agent/approval-guardian.json
```

Trusted project file:

```text
<project>/.pi/approval-guardian.json
```

Schema:

```json
{
  "model": "provider/model",
  "fallbackModel": "openai-codex/codex-auto-review",
  "timeoutMs": 90000,
  "policy": "Additional policy text",
  "review": {
    "custom-tool.path": "always | outside-or-private | private-only | off"
  }
}
```

Environment variables:

- `PI_APPROVAL_GUARDIAN_MODEL`
- `PI_APPROVAL_GUARDIAN_FALLBACK_MODEL`
- `PI_APPROVAL_GUARDIAN_TIMEOUT_MS`
- `PI_APPROVAL_GUARDIAN_POLICY`

Primary model, fallback model, and timeout precedence:

```text
environment > trusted project > global > default
```

Policy composition:

```text
default policy + global policy + trusted-project policy + environment policy
```

Malformed primary/fallback model, timeout, policy, review container, review level, unknown top-level key, or unsupported review-rule key produces a fatal diagnostic and blocks covered tool execution fail-closed. The schema is intentionally strict so a misspelled policy or rule cannot be silently ignored; remove obsolete metadata keys when upgrading. Review rules allow the documented built-in keys and arbitrary custom `<tool>.path` keys; other parameter names cannot be consumed at runtime. Model IDs may contain additional slashes after the provider separator.

`fallbackModel` defaults to `openai-codex/codex-auto-review`. It is attempted only when it differs from the primary and that primary is missing, lacks usable authentication, returns a terminal failure, or times out. When both settings resolve to the same spec—the default—there is no separate fallback attempt. An explicit deny or cancellation never triggers fallback. Each reviewer channel receives the configured deadline and its own retry budget. When fallback activates, Guardian emits a UI-only warning and does not inject a fallback message into agent context.

`/approval-guardian` reports primary/fallback model, timeout, policy sources, and config-file state. It resolves usable request authentication but does not send a reviewer inference. Startup health performs only the faster configured-auth check, including a degraded warning when a distinct fallback is unavailable.

## Private-read classification

Classification normalizes leading `~`, `@`, `file://` URLs, and Pi's Unicode-space variants before resolving against the current directory. It then uses canonical paths and resolves existing symlinks. It is an explicit heuristic blacklist, not a complete DLP boundary.

### Common private files

- `.env` and `.env.*`
- `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`
- authentication, token, credential, secret, and service-account files
- SSH private keys and authorized-key material
- private certificate/keystore formats
- Terraform variable credentials

### Common private directories

- SSH, GPG, cloud, Kubernetes, and Docker credential stores
- password stores, keychains, keyrings, password managers, and browser login stores
- VPN and system credential locations
- authenticated CLI configuration such as gcloud, GitHub CLI, GitLab CLI, 1Password CLI, and rclone
- project `secrets/` and `credentials/` directories (not a generic project `private/` directory)

### Pi data

The `.pi/` directory is not blanket-private.

Known private Pi data includes:

- `auth.json`, settings/model/Guardian/trust files, API-key files, and selected backups/logs;
- run history, agent sessions, and delegate job data;
- memory databases;
- context/session databases;
- session-search, knowledge-search, and ACP session indexes/maps.

Installed package contents under these paths are exempt from the `.pi/` location rule:

```text
.pi/agent/npm/node_modules/
.pi/npm/node_modules/
.pi/context-mode/insight-cache/node_modules/
```

User skill, agent, extension, and installed-package source is not private solely because it is under `.pi/`. Canonical targets and individual filenames can still match another private rule.

## Broad search handling

`grep` defaults to `always` because a broad or omitted path can recursively search private descendants.

The classifier checks:

- omitted and empty paths;
- `*`, `**`, `**/*`, and `*.*`;
- private selector globs such as `.env`, credentials, key, and certificate patterns;
- private descendants within the selected directory;
- a conservative scan limit that returns private when the directory cannot be bounded safely.

Common dependency/build directories are skipped during descendant scanning.

## Mutation classification

`write` and `edit` are reviewed when the canonical target is outside the canonical project root or matches a sensitive mutation category.

Sensitive categories include:

- environment and credential files;
- identity/key directories and certificate formats;
- shell startup and persistence files;
- Git metadata, hooks, and CI configuration;
- Pi project behavior surfaces such as `.pi/skills`, `.pi/agents`, `.pi/extensions`, prompts, themes, chains, and package sources;
- package manifests and lockfiles;
- Terraform, Kubernetes, and Docker Compose files.

Read and mutation classification are intentionally separate. Pi skill/agent/extension source is not confidential solely because it is under `.pi/`, but modifying that source is reviewed because it can change agent behavior.

Sensitive classification requires review; it does not automatically deny the action.

## Reviewer isolation

The reviewer uses an independent in-memory Pi session.

Normal reviews provide only:

```text
read · grep · find · ls
```

Private-data reviews provide no investigation tools. Authorization must be decided from the existing user transcript and planned-action metadata.

The reviewer never receives `bash`, `write`, or `edit`, and it loads no extensions, skills, prompt templates, themes, or project context files.

Transcript, tool output, file content, retry reasons, and planned actions are framed as untrusted evidence rather than instructions.

## Authorization contract

A covered action executes only when the reviewer returns a valid assessment with `outcome: "allow"`. Before allowing execution, Guardian validates the input as JSON-like data, deeply freezes it, and makes `event.input` non-writable/non-configurable, so later `tool_call` handlers cannot replace or mutate approved arguments. Exotic runtime values such as typed arrays, `Map`, `Set`, accessors, symbol-keyed properties, sparse arrays, or arrays with custom prototypes/properties fail closed instead of receiving a misleading lock guarantee. Extensions that need to rewrite a covered action must run before Guardian; they cannot rely on post-approval rewriting.

Additional deterministic requirements:

- `critical` actions cannot be automatically allowed.
- `high` risk with `unknown` or `low` authorization is denied.
- Private-data access requires `user_authorization: "high"`.
- Contradictory or malformed assessments are rejected.

A private-data denial instructs the main agent to explain the exact source and purpose and wait for a new explicit user message. It must not retry through bash, another path, an alias, a symlink, or another tool.

Authorized private-read output is not redacted.

## Transcript and prompt limits

| Item | Limit |
| --- | ---: |
| Message transcript | 40,000 characters |
| Tool transcript | 40,000 characters |
| Single message | 8,000 characters |
| Single tool entry | 4,000 characters |
| Planned action | 64,000 characters |
| Recent non-user entries | 40 |

Selection prioritizes the first and latest user intent, other user messages that fit, and recent assistant/tool evidence. Long entries use marked middle truncation.

## Session reuse

- The first review sends a bounded full transcript.
- Successful assessments advance the reviewer transcript cursor.
- Later reviews send only new transcript entries and the new planned action.
- Reviewer calls are serialized.
- Branch divergence, cwd/model/fallback-model/timeout/policy changes, channel switches, reload, or shutdown dispose the old reviewer session.
- Retry attempts use a fresh reviewer session and full bounded transcript.

## Retry and deadline

| Setting | Value |
| --- | ---: |
| Maximum attempts | 3 |
| Initial backoff | 200 ms |
| Backoff factor | 2× |
| Jitter | 0.9–1.1× |
| Default shared deadline per reviewer channel | 90 seconds |
| Allowed timeout range per reviewer channel | 1–300 seconds |

Retries apply to malformed assessment output and selected transient provider failures such as overload, rate limiting, HTTP 5xx, and transport/stream errors. Quota and billing exhaustion are terminal.

Within one reviewer channel, session startup, attempts, prompts, backoff, and cleanup share one deadline. A distinct fallback channel receives a fresh configured deadline. Explicit allow/deny and cancellation are not retried through fallback; primary failure and timeout may activate it.

## Adverse-outcome circuit breaker

Within one Pi agent run, the circuit opens after:

- three consecutive adverse batches; or
- ten adverse batches among the latest fifty recorded review batches.

Denied, timeout, and failure results are adverse; allowed and cancelled results are not. Sibling tool calls from the same assistant message share one batch, so multiple simultaneous adverse results count once.

When the circuit opens, the current run is aborted and later covered actions are blocked without another reviewer call.

## Result classes

| Result | Execution |
| --- | --- |
| `allowed` | Execute |
| `denied` | Block with no-workaround guidance |
| `timeout` | Block |
| `failure` | Block |
| `cancelled` | Block |
| `circuit-open` | Block without another review |

## Limitations

- This package is an approval gate, not an OS sandbox.
- Direct shell commands and actions from other processes are outside the extension hook.
- Ordinary in-project source edits are intentionally not reviewed.
- Path detection is heuristic and cannot identify every renamed or indirect secret.
- Shell commands are not parsed as a complete shell AST.
- Arbitrary pathless or nested-path custom tools and unrelated MCP/network/browser/email/deployment/subagent actions are not automatically covered; they need dedicated enforcement.
- Guardian locks approved `event.input` against later `tool_call` handlers, but cannot observe command prefixes, spawn hooks, or a custom tool's internal behavior after dispatch.
- Filesystem state may change between classification and execution.
- Reviewer decisions are probabilistic.
- At least one configured reviewer channel must be available because failure of both primary and fallback blocks covered actions.
