# Approval Guardian reference

This document defines the runtime behavior and configuration contract for `pi-approval-guardian`.

## Design scope

Approval Guardian provides a low-friction baseline that validates and reviews higher-risk agent actions before execution. Its purpose is to stop an agent from freely issuing unchecked shell actions, private-data reads, and sensitive mutations while leaving ordinary project work practical. It is intentionally not a comprehensive policy engine, filesystem snapshot, DLP system, or OS sandbox. New deterministic restrictions should address a concrete bypass or recurring false-negative pattern and should not broadly serialize, block, or add user turns to normal workflows without proportional benefit.

## Interception matrix

| Rule | Default | Behavior |
| --- | --- | --- |
| `bash.command` | `always` | Reviews every Pi agent-issued shell command. |
| `grep.path` | `outside-or-private` | Reviews outside-project searches plus selectors/scopes that may expose private data. Ordinary clean in-project source searches bypass reviewer latency. Empty paths fall back to the current working directory. |
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

Malformed primary/fallback model, timeout, policy, review container, review level, unknown top-level key, or unsupported review-rule key produces a UI warning. Invalid fields and rules are ignored while the remaining valid configuration stays active; for primary model, fallback model, and timeout, precedence continues to the next valid source and then the built-in default. A malformed or unreadable config file is ignored as a unit. Configuration warnings do not globally block agent `tool_call` execution. Review rules allow the documented built-in keys and arbitrary custom `<tool>.path` keys; other parameter names cannot be consumed at runtime. Model IDs may contain additional slashes after the provider separator. While temporary bypass is inactive, covered actions still fail closed when no reviewer returns a valid allow decision.

Reviewer channels are tried in this order after deduplicating equivalent model identities: configured primary, configured `fallbackModel`, then the current Pi session model as the final fallback. `fallbackModel` defaults to `openai-codex/codex-auto-review`. Guardian advances only when the prior channel is missing, lacks usable authentication, or returns an explicit failure. A timeout is terminal for the action and blocks fail-closed without trying another channel. An explicit allow, deny, or cancellation also stops the chain immediately. Each distinct reviewer channel that is reached receives the configured deadline and its own retry budget. The current model is used only as the model identity for a new isolated reviewer session; Guardian never reuses the main conversation session as reviewer state. Channel switches emit UI-only warnings and are not injected into agent context.

`/approval-guardian` reports the primary, configured fallback, current-model fallback, timeout, policy sources, config-file state, and temporary-bypass state. It resolves usable request authentication but does not send a reviewer inference. Startup health performs only the faster configured-auth check, including degraded and active-fallback status.

## Temporary runtime bypass

`/approval-guardian bypass` enables an explicit, in-memory bypass after waiting for the current agent run and queued continuations to settle. `/approval-guardian enable` ends it. Both commands are idempotent. Activation is restricted to interactive TUI mode; RPC, JSON, and print modes are refused because their clients can ignore or fail to retain fire-and-forget status updates, so a persistent warning cannot be guaranteed.

While bypass is active:

- a persistent one-line `belowEditor` widget remains visible for the entire bypass; toggle and status-detail notifications are UI-only;
- the `tool_call` hook returns before batch lookup, configuration loading, classification, reviewer inference, deterministic allow checks, approved-input locking, and circuit enforcement;
- no per-action Guardian allow/block notification is emitted because the action was not reviewed;
- other extensions and tool-internal checks remain active; bypass disables only Approval Guardian's hook;
- cached reviewer controllers are disposed and circuit/batch state is reset across each mode transition;
- `/approval-guardian` reports `reviews disabled` plus the underlying reviewer readiness, without claiming that current execution is fail-closed.

The bypass does not release or retry an already blocked/in-flight tool call, trigger an agent turn, or grant task authorization. It is not persisted to the session file and resets on every `session_start` lifecycle, including startup/reload/new/resume/fork, as well as process restart.

Guardian intentionally does not inject bypass or re-enable state into agent messages, the system prompt, or other model context. A one-shot persisted “bypassed” message could remain stale after re-enabling and could be misread as permission; the user must separately instruct the agent what work to perform. The persistent below-editor widget is the user-facing safety signal.

## Private-read classification

Classification normalizes leading `~`, `@`, `file://` URLs, and Pi's Unicode-space variants before resolving against the current directory. It then uses canonical paths and resolves existing symlinks. It is an explicit heuristic blacklist, not a complete DLP boundary.

The auditable rule catalogs live in [`src/path-rules.ts`](../src/path-rules.ts). Structured path tools and literal path candidates extracted from `bash` commands both use the same `classifyReadPath()` implementation. Shell token and glob recognition remains conservative and heuristic, but its representative glob candidates are derived from the same catalog instead of maintaining a separate private-path list.

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

`grep` defaults to `outside-or-private`: ordinary clean in-project searches bypass reviewer latency, while a broad or omitted path is still reviewed when its effective scope can reach private descendants.

Recursive `grep` and `find` classification checks:

- omitted and empty paths;
- `*`, `**`, `**/*`, and `*.*`;
- private selector globs such as `.env`, credentials, key, and certificate patterns;
- private descendants within the selected directory;
- a conservative scan limit that returns private when the directory cannot be bounded safely.

Common dependency/build directories are skipped during recursive descendant scanning. `ls` follows Pi's non-recursive behavior instead: it checks the requested directory canonically, then classifies the visible lexical names of sorted direct entries within the requested entry limit without following a direct child's symlink target. A private descendant below an ordinary direct child does not by itself turn `ls` of the parent into a private-data read; byte-level output truncation is intentionally not reproduced, so this remains a conservative approximation of visible output.

Recursive directory-scope scan results use a process-local, memory-only LRU cache with a monotonic one-second TTL and at most 128 query keys. Cache keys include the canonical root, selector glob, and scan limit. The cache is cleared on session lifecycle resets, before each agent run, across temporary-bypass transitions, and after `bash`, `write`, `edit`, or any other tool not known to be read-only. Repeated `grep` and `find` classifications may reuse an unexpired result; direct `ls` checks are inexpensive and are not cached. Nothing is written to disk, and the short TTL bounds staleness from filesystem changes made by other processes.

### Accepted risk: parallel filesystem TOCTOU

Pi's default parallel tool mode emits and awaits each sibling's preflight in assistant source order before it starts any prepared tool execution. This ordering was verified against [Pi 0.80.7's agent loop](https://github.com/earendil-works/pi/blob/818d67457cdd6b60bce6b121d16b23141c252dd8/packages/agent/src/agent-loop.ts#L491-L544). A mutating sibling therefore cannot already be running while a later sibling is still in `tool_call` classification, so the directory cache is not stale from that sibling during preflight. After every sibling is prepared, Pi may execute allowed reads and mutations concurrently.

The filesystem can consequently change after a fresh classification but before or during the corresponding read. Earlier cache invalidation, a shorter TTL, or disabling the cache would not remove this check-to-use gap. Approval Guardian accepts this residual risk because potentially mutating built-in actions are independently reviewed, meaningful disclosure of previously unknown private data generally requires another classifier/reviewer/custom-tool boundary to fail, and blocking all mixed read/mutation batches would add routine false positives and extra agent turns. This package remains a low-friction approval gate rather than a filesystem snapshot or sandbox.

Reconsider this decision if Pi changes sibling preflight ordering, exposes a low-friction API for dynamically serializing only mixed filesystem batches, the supported threat model expands to untrusted custom-tool internals, or practical evidence shows the gap being exploited. OS/container isolation remains the appropriate boundary when atomic filesystem guarantees are required.

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

The reviewer never receives `bash`, `write`, or `edit`, and it loads no extensions, skills, prompt templates, themes, or project context files. Its normal investigation tools are reviewer-only wrappers that deterministically reject paths, selectors, and effective scopes classified as private before delegating to Pi's built-in read-only implementations. This containment uses the same heuristic path rules as the main gate and retains their documented limits.

Transcript, tool output, file content, retry reasons, and planned actions are framed as untrusted evidence rather than instructions.

## Authorization contract

When temporary bypass is inactive, a covered action executes only when the reviewer returns a valid assessment with `outcome: "allow"`. Before allowing execution, Guardian validates the input as JSON-like data, deeply freezes it, and makes `event.input` non-writable/non-configurable, so later `tool_call` handlers cannot replace or mutate approved arguments. Exotic runtime values such as typed arrays, `Map`, `Set`, accessors, symbol-keyed properties, sparse arrays, or arrays with custom prototypes/properties fail closed instead of receiving a misleading lock guarantee. Extensions that need to rewrite a covered action must run before Guardian; they cannot rely on post-approval rewriting.

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

- Each distinct reviewer channel and review mode (normal versus private-data authorization) keeps its own isolated controller/session.
- The first review on that channel sends a bounded full transcript.
- Successful assessments advance that channel's reviewer transcript cursor.
- Later reviews on the same channel send only new transcript entries and the new planned action.
- Reviewer calls are serialized within each controller; Pi's current `tool_call` preflight contract also invokes sibling handlers sequentially.
- Switching channels preserves the other channels' incremental reviewer state.
- Branch divergence resets the affected reviewer session. Cwd/current-model/primary/fallback/timeout/policy changes, reload, or shutdown dispose all cached reviewer sessions.
- Retry attempts use a fresh reviewer session and full bounded transcript.
- Session startup is generation-guarded: a late completion from a timed-out, cancelled, reset, or disposed startup is discarded and cannot replace a newer reviewer session.

## Retry and deadline

| Setting | Value |
| --- | ---: |
| Maximum attempts | 3 |
| Initial backoff | 200 ms |
| Backoff factor | 2× |
| Jitter | 0.9–1.1× |
| Default shared deadline per distinct reviewer channel | 90 seconds |
| Allowed timeout range per distinct reviewer channel | 1–300 seconds |

Retries apply to malformed assessment output and selected transient provider failures such as overload, rate limiting, HTTP 5xx, and transport/stream errors. Quota and billing exhaustion are terminal.

Within one reviewer channel, session startup, attempts, prompts, backoff, and cleanup share one deadline. Authentication resolution and time spent waiting behind an earlier serialized review currently occur before that controller deadline, so wall-clock latency can exceed the displayed value. A reached fallback channel receives a fresh configured deadline only when the preceding channel returned an explicit failure. Allow, deny, cancellation, and timeout are terminal and never activate another channel. Consequently, a reviewer that consumes the full 90-second default without producing a valid assessment blocks the action immediately instead of starting another 90-second fallback review. Missing-model and authentication failures normally switch quickly; other explicit failures may occur after provider/session work but before the deadline.

## Usability and review frequency

The default profile reviews every agent-issued `bash` command because arbitrary shell syntax cannot be safely reduced to a broad deterministic allowlist. `grep.path` defaults to `outside-or-private`, so an ordinary clean in-project source search bypasses reviewer inference; private selectors, private effective scopes, and outside-project searches still trigger review. Set `grep.path` to `always` for a stricter profile. Disabling `bash.command` removes a major security boundary and is recommended only when another trusted shell-approval or sandbox layer provides equivalent enforcement.

Every allow or block result remains visible through a per-action UI notification so users can tell which calls were actually reviewed. Timeouts, channel switches, health problems, and configuration warnings are also reported. Private-data reads intentionally require a new explicit user message identifying the exact path or clearly named private source and purpose. This extra turn is considered acceptable friction because it prevents broad project requests from silently authorizing credential access. Invalid configuration entries are ignored instead of globally blocking tools; `/approval-guardian` shows the warnings and effective fallback values after configuration edits.

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
- Filesystem state may change between classification and execution; the parallel sibling case is an explicitly accepted risk documented under broad search handling.
- Reviewer decisions are probabilistic.
- A user-enabled temporary bypass intentionally removes Guardian classification, review, input locking, and circuit enforcement until it is re-enabled or automatically reset.
- While Guardian is enabled, at least one distinct reviewer channel must be available; failure of the configured primary, configured fallback, and current-model fallback blocks covered actions.
