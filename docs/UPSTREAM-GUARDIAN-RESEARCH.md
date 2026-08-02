# Upstream Codex Guardian research

Date: 2026-08-02

## Scope

This note compares the local source point `03bb3b12367397e14a8facc2e018d645ff4d8e83` with OpenAI Codex stable `rust-v0.146.0` at `e363b08c9175ac1cbe5893615dd2cb9ddf95043b` and the examined `main` snapshot `2b5bdcf67547860f2e5c5a605009a70026796b2b`. Only primary OpenAI sources were used.

The important post-source change is not a replacement of `codex-rs/core/src/guardian/policy*.md`. [PR #34687](https://github.com/openai/codex/pull/34687), merged as [`6e5a2d6b`](https://github.com/openai/codex/commit/6e5a2d6b8d148a5554fdceb6f399ca45bd1c78d9), installs the effective action-risk template and generic security policy in the `codex-auto-review` model-catalog entry. That catalog policy/template is byte-identical at the merge commit, stable `0.146.0`, and the examined `main` snapshot.

Primary checkpoints:

- [Baseline `03bb3b`](https://github.com/openai/codex/commit/03bb3b12367397e14a8facc2e018d645ff4d8e83)
- [Catalog integration `6e5a2d6b`](https://github.com/openai/codex/commit/6e5a2d6b8d148a5554fdceb6f399ca45bd1c78d9)
- [Stable release `rust-v0.146.0`](https://github.com/openai/codex/releases/tag/rust-v0.146.0) and [commit `e363b08`](https://github.com/openai/codex/commit/e363b08c9175ac1cbe5893615dd2cb9ddf95043b)
- [`models.json` at stable `e363b08`](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/models-manager/models.json)
- [Examined main `2b5bdcf`](https://github.com/openai/codex/commit/2b5bdcf67547860f2e5c5a605009a70026796b2b)

## Adopted selectively

### Authorization provenance

The current catalog template distinguishes direct user authority from assistant text, tool output, file content, and other untrusted evidence. The local adaptation makes the same boundary explicit and enforces it with Pi's pre-expansion `input` source: only input Pi reports as interactive or RPC establishes authorization. Expanded skill/template bodies, extension-injected user-role messages, later input transforms, and unmarked legacy messages remain untrusted. Earlier-loaded input transformers are part of Pi's trusted-extension control plane because Pi does not expose immutable original text or its transform chain. Reviewer transcript entries are JSON Lines, and only a controlled top-level `provenance: "direct_user"` field carries authority; evidence text remains JSON-escaped content and cannot forge another entry. A user can deliberately delegate implementation scope to a named file or ticket, but that source cannot itself authorize private-data access, external egress, or unrelated risky side effects. Exact private-source authorization must appear in the captured direct input.

This reduces prompt-injection authority without treating ordinary implementation details from files or tools as malicious by default.

### Egress payload and destination

The catalog policy evaluates the actual payload and destination, including artifacts, derived outputs, and links that grant access. The local adaptation adds the narrow transferable rules:

- authorization to create, read, or process data does not itself authorize export;
- authorization for sensitive egress must cover both payload and destination;
- an artifact or access-granting link is disclosure when it contains or exposes private data;
- a credibly private or mixed payload is not assumed safe when available evidence cannot bound it.

The existing stricter local private-data-read contract remains unchanged.

### Destructive target resolution

The catalog policy calls out actual shell target resolution and dangerous shadowing of common variables such as `HOME`. The local adaptation requires the reviewer to resolve destructive targets and variable expansion, and to reject a destructive form that relies on a shadowed common location variable in favor of an unambiguous literal or purpose-specific variable.

### Reviewer/action boundary and investigation budget

The effective template distinguishes the reviewer's restrictions from the coding agent's execution environment. The local adaptation now states that the reviewer's read-only tools do not imply that the reviewed action is read-only or sandboxed. Investigation tools should be used only when a missing local fact could materially change allow/deny.

### Bounded rejection details

[PR #34400](https://github.com/openai/codex/pull/34400), merged as [`e52c35b0`](https://github.com/openai/codex/commit/e52c35b0001ea3e4a1744b99c4250a5b1a09e44d), propagates specific denial reasons while truncating oversized rejection text before returning it to model context. The local adaptation similarly flattens and bounds reviewer/provider details before placing a blocked result back in the main agent context.

### Cancellation regression coverage

[PR #35267](https://github.com/openai/codex/pull/35267), merged as [`63fe5a6b`](https://github.com/openai/codex/commit/63fe5a6b71d45dfff24a6a1e5da0699e054f145d), ties pending approvals to their owner and tests cancellation of abandoned Guardian work. Pi's `tool_call` hook already owns each awaited review and supplies an abort signal; the local implementation already generation-guards session startup. A regression test now verifies that a late provider completion after cancellation cannot advance transcript state or affect the next review.

## Already present

The project already has the transferable parts of several later Codex changes:

- fail-closed timeout, provider, parse, cancellation, and contradictory-assessment handling;
- isolated reviewer sessions with restricted tools and no extensions, skills, templates, themes, or project context;
- shared per-channel deadlines, bounded retry, cancellation, serialized review calls, and late-startup disposal;
- direct propagation of a denial rationale to the blocked tool result;
- model-specific reviewer session creation rather than inheriting the main session object;
- approved-input locking and batch-aware circuit accounting.

[PR #34847](https://github.com/openai/codex/pull/34847) fixes Guardian model-limit inheritance in Codex. The Pi implementation already creates a separate session using the selected reviewer model object, so no parent context-window override is copied.

## Deferred

### Codex sandbox and permission messages

The catalog's `never`, `danger_full_access`, `workspace_write`, and `read_only` messages describe Codex-native sandbox modes. Pi Approval Guardian does not own an equivalent sandbox contract and must not imply one.

### Network/MCP approval ownership

Codex's network approval cache, coalescing, policy amendments, and MCP elicitation authority are host-runtime features. This package does not broadly intercept network, browser, MCP, email, deployment, or pathless custom tools. Adding those mechanisms here would exceed the documented low-friction approval-gate scope.

### Dynamic model-catalog policy loading

The local policy stays package-controlled and reviewable. Dynamically importing model-owned catalog policy would let behavior drift outside this package's normal review and release boundary, and could weaken the explicit private-read rule.

### Plugin attribution and visible tool-call IDs

[PR #35029](https://github.com/openai/codex/pull/35029) propagates runtime-validated plugin attribution. Pi's current `tool_call` event does not expose equivalent runtime-validated plugin provenance, so command text or paths must not be treated as plugin-origin evidence.

Pi does expose an opaque `toolCallId`, but displaying it would not reproduce Codex's owner-scoped approval machinery: each Pi hook is already awaited for its exact event and this package has no approval cache. Adding IDs to every notification or denial would add noise without a proportional safety gain, so it is deferred.

### Per-action model labels

The status command and fallback notices already show configured and selected fallback models. Repeating the model on every allow/block notification would add routine UI noise. It can be reconsidered if Pi later exposes structured review telemetry.

## Local invariants retained

Wholesale replacement is intentionally rejected because it could weaken or blur these contracts:

- private-data reads require explicit authorization for the exact source and deterministic `user_authorization: "high"`;
- private-data reviews receive no investigation tools;
- normal project work should not gain broad new interception, serialization, or extra user turns;
- this package is an approval gate, not a sandbox, DLP system, or comprehensive policy engine;
- upstream policy changes are reviewed and pinned to an immutable commit before adoption.
