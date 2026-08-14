# prime-approval-guardian

This private alpha package provides a fail-closed whole-cell Approval Guardian for Prime Agent 0.7.x. It is not a Pi extension and is not published yet.

The explicit Prime adapter intercepts every Prime Agent `ipython` call, normalizes the exact complete cell, and sends it through the shared fail-closed Guardian decision contract before execution. It uses an explicitly registered reviewer model when supplied by the host adapter, otherwise it falls back to Prime’s current registered model. Authentication failure, provider failure, timeout, malformed input, incomplete input, and invalid or denying assessments all block the cell.

## Compatibility

- Prime Agent: `>=0.7.2 <0.8.0`
- Node.js: `>=22.8.0`

## Reviewer isolation

The reviewer receives only a new context containing the Guardian system prompt and the normalized whole-cell action. It receives no main-conversation messages and no tools, extensions, skills, project context, IPython, shell, or write capability. Reviewer output must be one strict assessment object.

## Advisory capability analysis

Before review, a pure bounded lexical pass annotates the normalized action with closed, categorical indicators for filesystem, process, shell magic, network, deployment, skill, RLM/subagent, and dynamic execution capabilities. Unknown, dynamic, unsupported, truncated, and failed analysis remain explicit uncertainties. The pass retains no snippets, arguments, paths, identifiers, environment values, secrets, or raw errors. Its source prefix, aliases, findings, rules, and output schema are fixed-size.

These indicators are advisory evidence only. They do not authorize an action, claim containment, or replace review of the exact complete cell. If annotation fails, the failure uncertainty and unchanged whole cell still go to the reviewer; normal deny/failure/timeout behavior remains fail closed.

## Prime configuration and status

Guardian reads `approval-guardian.json` from Prime Agent’s `getAgentDir()` (normally `~/.prime/agent`) and considers a project candidate only at `<cwd>/.prime/agent/approval-guardian.json`. It never reads Pi configuration locations.

Global configuration may set `reviewerModel` (`provider/model`), `timeoutMs` (1,000–300,000), `policy`, and the fixed `review.ipython.cell` floor. Project configuration is strengthening-only: it may extend the global deadline, but cannot select a reviewer, shorten the deadline, inject policy, create grants, weaken whole-cell review, or request bypass. Such entries are rejected and reported.

Run `/approval-guardian` to report the Prime configuration sources, rejected/weakened controls, reviewer readiness, deadline source, and unsupported controls. Status never prints policy contents, credentials, authentication errors, or configuration values from unknown keys.

Temporary bypass is deliberately unavailable in interactive, print, RPC, and daemon operation. `hasUI` only describes presentation and is not treated as a bypass capability.

## Security scope

This alpha covers Prime Agent’s built-in whole-cell IPython preflight only. It is an approval gate, not an OS sandbox. It does not provide Pi shell/path-tool coverage or grants. Authentication failure, malformed configuration, unavailable optional host context, capability-analysis failure, and preflight errors remain fail-closed.

## Native verification

From the repository root, with Prime Agent 0.7.x installed:

```bash
npm run test:prime-native
```

The smoke test packs and installs the artifact into isolated temporary package storage, then exercises Prime’s actual tool-call seam. It verifies injected and nested real-reviewer allow, deny, unavailable authentication, provider failure, timeout, and invalid-assessment paths, plus RPC and daemon-backed blocking. Allowed cells must create the exact expected marker; every blocked path must leave no side effect. Versions outside `>=0.7.2 <0.8.0` fail explicitly.
