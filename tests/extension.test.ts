import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import approvalGuardian, {
	actionFromToolCall,
	enforceActionRequirements,
	guardianHealth,
	lockAllowedToolInput,
	lockReviewedToolInput,
	reviewerToolsForAction,
	runReviewWithFallback,
	shouldFallbackReview,
	toolCallBatchInfo,
} from "../extensions/index.ts";
import { DEFAULT_REVIEW_RULES, loadGuardianConfig } from "../src/config.ts";
import { DenialCircuitBreaker, ReviewBatchTracker } from "../src/gate.ts";
import { ReviewerSessionController } from "../src/reviewer-session.ts";

function event(toolName: string, input: Record<string, unknown>): ToolCallEvent {
	return { toolName, input, toolCallId: "test" } as unknown as ToolCallEvent;
}

test("routes private read and grep paths to the reviewer", () => {
	const read = actionFromToolCall(
		event("read", { path: ".env" }),
		"/repo/project",
		{ ...DEFAULT_REVIEW_RULES },
	);
	assert.equal(read?.tool, "read");
	assert.equal(read?.payload.private_data_read, true);

	const grep = actionFromToolCall(
		event("grep", { path: "/home/test/.aws", pattern: "token" }),
		"/repo/project",
		{ ...DEFAULT_REVIEW_RULES },
	);
	assert.equal(grep?.tool, "grep");
	assert.equal(grep?.payload.pattern, "token");

	const project = mkdtempSync(join(tmpdir(), "guardian-grep-"));
	writeFileSync(join(project, ".env"), "TOKEN=test");
	const broad = actionFromToolCall(
		event("grep", { pattern: "token" }),
		project,
		{ ...DEFAULT_REVIEW_RULES },
	);
	assert.equal(broad?.tool, "grep");
	assert.equal(broad?.payload.private_data_read, true);

	const globbed = actionFromToolCall(
		event("grep", { path: ".", pattern: "token", glob: "**/.env*" }),
		"/repo/project",
		{ ...DEFAULT_REVIEW_RULES },
	);
	assert.equal(globbed?.payload.private_data_read, true);
	for (const glob of ["*", "**/*", "**/{.env,.npmrc}"]) {
		const broadGlob = actionFromToolCall(
			event("grep", { path: ".", pattern: "token", glob }),
			project,
			{ ...DEFAULT_REVIEW_RULES },
		);
		assert.equal(broadGlob?.payload.private_data_read, true, glob);
	}
});

test("defaults unconfigured path-based tools to private-only", () => {
	const privateAction = actionFromToolCall(
		event("custom_reader", { path: "C:\\Users\\test\\.ssh\\config" }),
		"/repo/project",
		{ ...DEFAULT_REVIEW_RULES },
	);
	assert.equal(privateAction?.tool, "custom_reader");
	assert.equal(
		actionFromToolCall(
			event("custom_reader", { path: "docs/guide.md" }),
			"/repo/project",
			{ ...DEFAULT_REVIEW_RULES },
		),
		undefined,
	);
});

test("marks obvious shell private-data access for high authorization", () => {
	for (const command of [
		"cat .env",
		"cat ~/.ssh/config",
		"cat /home/test/.aws/credentials",
		"cat $HOME/.kube/config",
		"type C:\\Users\\test\\.ssh\\config",
		"cat .npmrc",
		"cat credentials.json",
		"grep -R token ~/.ssh",
		"find ~/.aws -type f",
		"tar czf /tmp/kube.tgz $HOME/.kube",
		"type C:\\Users\\test\\.ssh",
		"cat ~/.[s]sh/config",
		"cat ~/.ssh/id_*",
		"cat se[ck]rets/token",
		"cat .env*",
		"cat .??v",
		"cat .{env,npmrc}",
		"cat certs/*.pem",
	]) {
		const action = actionFromToolCall(
			event("bash", { command }),
			"/repo/project",
			{ ...DEFAULT_REVIEW_RULES },
		);
		assert.equal(action?.payload.private_data_read, true, command);
	}
});

test("does not treat ordinary shell source globs as private data", () => {
	for (const command of [
		"cat src/*.ts",
		"find src -name '*.test.ts'",
		"find src -name '*'",
		"printf '%s\\n' *",
	]) {
		const action = actionFromToolCall(
			event("bash", { command }),
			"/repo/project",
			{ ...DEFAULT_REVIEW_RULES },
		);
		assert.equal(action?.payload.private_data_read, false, command);
	}
});

test("does not route installed Pi package docs through private-read review", () => {
	const packageSkill = actionFromToolCall(
		event("read", {
			path: join(
				homedir(),
				".pi/agent/npm/node_modules/@upstash/context7-pi/skills/context7-docs/SKILL.md",
			),
		}),
		"/repo/project",
		{ ...DEFAULT_REVIEW_RULES },
	);
	assert.equal(packageSkill, undefined);

	const settings = actionFromToolCall(
		event("read", { path: "/home/test/.pi/agent/settings.json" }),
		"/repo/project",
		{ ...DEFAULT_REVIEW_RULES },
	);
	assert.equal(settings?.payload.private_data_read, true);
});

test("only marks known confidential Pi paths as private shell access", () => {
	for (const command of [
		"cat ~/.pi/agent/auth.json",
		"cat $HOME/.pi/agent/settings.json",
		"cat ~/.pi/agent/sessions/project/session.jsonl",
		"cat ~/.pi/memory/memory.db",
		"cat ~/.pi/agent/*",
		"cat ~/.pi/agent/{auth.json,settings.json}",
		"cat ~/.pi/agent/auth.*",
		'P=$HOME/.pi; A=auth; cat "$P/agent/$A.json"',
	]) {
		const action = actionFromToolCall(
			event("bash", { command }),
			"/repo/project",
			{ ...DEFAULT_REVIEW_RULES },
		);
		assert.equal(action?.payload.private_data_read, true, command);
	}

	for (const command of [
		"cat ~/.pi/agent/npm/node_modules/@upstash/context7-pi/skills/context7-docs/SKILL.md",
		"cat ~/.pi/agent/skills/custom/SKILL.md",
		"cat ~/.pi/agent/extensions/example/index.ts",
	]) {
		const action = actionFromToolCall(
			event("bash", { command }),
			"/repo/project",
			{ ...DEFAULT_REVIEW_RULES },
		);
		assert.equal(action?.payload.private_data_read, false, command);
	}
});

test("reviews broad find and ls scopes that contain private descendants", () => {
	const project = mkdtempSync(join(tmpdir(), "guardian-list-"));
	writeFileSync(join(project, ".env"), "TOKEN=test");
	for (const [toolName, input] of [
		["find", { path: project, pattern: "*" }],
		["ls", { path: project }],
	] as const) {
		const action = actionFromToolCall(
			event(toolName, input),
			project,
			{ ...DEFAULT_REVIEW_RULES },
		);
		assert.equal(action?.payload.private_data_read, true, toolName);
	}
});

test("groups sibling tool calls from one assistant message", () => {
	const branch = [
		{
			type: "message",
			id: "assistant-batch",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call-1" },
					{ type: "toolCall", id: "call-2" },
					{ type: "toolCall", id: "call-3" },
				],
			},
		},
	];
	assert.deepEqual(toolCallBatchInfo("call-1", branch), {
		id: "assistant-batch",
		isLast: false,
	});
	assert.deepEqual(toolCallBatchInfo("call-2", branch), {
		id: "assistant-batch",
		isLast: false,
	});
	assert.deepEqual(toolCallBatchInfo("call-3", branch), {
		id: "assistant-batch",
		isLast: true,
	});
});

test("finalizes a denial batch when the final sibling has no tool-call review", () => {
	const branch = [
		{
			type: "message",
			id: "assistant-with-invalid-final-tool",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "reviewed-denial" },
					{ type: "toolCall", id: "invalid-final-tool" },
				],
			},
		},
	];
	const tracker = new ReviewBatchTracker();
	const breaker = new DenialCircuitBreaker();
	const first = toolCallBatchInfo("reviewed-denial", branch);
	tracker.record(first.id, true);
	const fallback = toolCallBatchInfo("invalid-final-tool", branch);
	assert.equal(fallback.isLast, true);
	assert.equal(breaker.record(tracker.finish(fallback.id) ?? false), false);
});

test("honors always rules when an optional path is omitted or empty", () => {
	const action = actionFromToolCall(
		event("find", { pattern: "**/*.pem" }),
		"/repo/project",
		{ ...DEFAULT_REVIEW_RULES, "find.path": "always" },
	);
	assert.equal(action?.tool, "find");
	assert.match(
		String(action?.payload.path).replace(/\\/g, "/"),
		/repo\/project/,
	);
	const emptyPath = actionFromToolCall(
		event("ls", { path: "" }),
		"/repo/project",
		{ ...DEFAULT_REVIEW_RULES, "ls.path": "always" },
	);
	assert.equal(emptyPath?.tool, "ls");
});

test("falls back only for reviewer failure or timeout", () => {
	const assessment = {
		risk_level: "low" as const,
		user_authorization: "unknown" as const,
		outcome: "allow" as const,
		rationale: "",
	};
	assert.equal(shouldFallbackReview({ kind: "failure", message: "failed" }), true);
	assert.equal(shouldFallbackReview({ kind: "timeout", message: "timed out" }), true);
	assert.equal(shouldFallbackReview({ kind: "allowed", assessment }), false);
	assert.equal(
		shouldFallbackReview({
			kind: "denied",
			assessment: { ...assessment, outcome: "deny" },
		}),
		false,
	);
	assert.equal(
		shouldFallbackReview({ kind: "cancelled", message: "cancelled" }),
		false,
	);
});

test("runs the fallback channel only after primary failure", async () => {
	const calls: string[] = [];
	let notices = 0;
	const assessment = {
		risk_level: "low" as const,
		user_authorization: "unknown" as const,
		outcome: "allow" as const,
		rationale: "",
	};
	const recovered = await runReviewWithFallback(
		"custom/reviewer",
		"openai-codex/codex-auto-review",
		async (model) => {
			calls.push(model);
			return model === "custom/reviewer"
				? { kind: "failure", message: "unavailable" }
				: { kind: "allowed", assessment };
		},
		() => notices++,
	);
	assert.deepEqual(calls, [
		"custom/reviewer",
		"openai-codex/codex-auto-review",
	]);
	assert.equal(notices, 1);
	assert.equal(recovered.usedFallback, true);
	assert.equal(recovered.primaryResult.kind, "failure");
	assert.equal(recovered.result.kind, "allowed");

	calls.length = 0;
	const denied = await runReviewWithFallback(
		"custom/reviewer",
		"openai-codex/codex-auto-review",
		async (model) => {
			calls.push(model);
			return {
				kind: "denied",
				assessment: { ...assessment, outcome: "deny" },
			};
		},
		() => notices++,
	);
	assert.deepEqual(calls, ["custom/reviewer"]);
	assert.equal(notices, 1);
	assert.equal(denied.usedFallback, false);

	const bothFailed = await runReviewWithFallback(
		"custom/reviewer",
		"openai-codex/codex-auto-review",
		async (model) => ({ kind: "failure", message: `${model} failed` }),
		() => notices++,
	);
	assert.equal(bothFailed.usedFallback, true);
	assert.equal(bothFailed.primaryResult.kind, "failure");
	assert.equal(bothFailed.result.kind, "failure");

	const fallbackTimedOut = await runReviewWithFallback(
		"custom/reviewer",
		"openai-codex/codex-auto-review",
		async (model) =>
			model === "custom/reviewer"
				? { kind: "failure", message: "primary failed" }
				: { kind: "timeout", message: "fallback timed out" },
		() => notices++,
	);
	assert.equal(fallbackTimedOut.usedFallback, true);
	assert.equal(fallbackTimedOut.result.kind, "timeout");
});

test("keeps success, denial, cancellation, and identical models on the primary channel", async () => {
	const assessment = {
		risk_level: "low" as const,
		user_authorization: "unknown" as const,
		outcome: "allow" as const,
		rationale: "",
	};
	for (const primaryResult of [
		{ kind: "allowed", assessment } as const,
		{
			kind: "denied",
			assessment: { ...assessment, outcome: "deny" as const },
		} as const,
		{ kind: "cancelled", message: "cancelled" } as const,
	]) {
		const calls: string[] = [];
		const result = await runReviewWithFallback(
			"custom/reviewer",
			"openai-codex/codex-auto-review",
			async (model) => {
				calls.push(model);
				return primaryResult;
			},
			() => assert.fail("fallback must not run"),
		);
		assert.deepEqual(calls, ["custom/reviewer"]);
		assert.equal(result.usedFallback, false);
		assert.equal(result.result.kind, primaryResult.kind);
	}

	const calls: string[] = [];
	const identical = await runReviewWithFallback(
		"custom/reviewer",
		"custom/reviewer",
		async (model) => {
			calls.push(model);
			return { kind: "failure", message: "unavailable" };
		},
		() => assert.fail("identical fallback must not run"),
	);
	assert.deepEqual(calls, ["custom/reviewer"]);
	assert.equal(identical.usedFallback, false);
});

test("wires primary failure through fallback and keeps fallback diagnostics UI-only", async () => {
	const handlers = new Map<string, (event: unknown, ctx: never) => unknown>();
	approvalGuardian({
		on: (name: string, handler: (event: unknown, ctx: never) => unknown) => {
			handlers.set(name, handler);
		},
		registerCommand: () => undefined,
	} as never);
	const originalReview = ReviewerSessionController.prototype.review;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousPrimary = process.env.PI_APPROVAL_GUARDIAN_MODEL;
	const previousFallback = process.env.PI_APPROVAL_GUARDIAN_FALLBACK_MODEL;
	const root = mkdtempSync(join(tmpdir(), "guardian-wiring-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PI_APPROVAL_GUARDIAN_MODEL = "custom/reviewer";
	process.env.PI_APPROVAL_GUARDIAN_FALLBACK_MODEL =
		"openai-codex/codex-auto-review";
	let mode: "recover" | "fail" = "recover";
	const reviewCalls: string[] = [];
	ReviewerSessionController.prototype.review = async function (
		this: ReviewerSessionController,
	) {
		const options = (
			this as unknown as {
				options: { model: { provider: string; id: string } };
			}
		).options;
		const model = `${options.model.provider}/${options.model.id}`;
		reviewCalls.push(model);
		if (model === "custom/reviewer") {
			return { kind: "failure", message: "primary channel failed" };
		}
		return mode === "recover"
			? {
					kind: "allowed",
					assessment: {
						risk_level: "low",
						user_authorization: "unknown",
						outcome: "allow",
						rationale: "Safe test action.",
					},
				}
			: { kind: "failure", message: "secondary channel failed" };
	} as typeof originalReview;

	const notices: string[] = [];
	let branch: unknown[] = [];
	const primary = { provider: "custom", id: "reviewer" };
	const fallback = {
		provider: "openai-codex",
		id: "codex-auto-review",
	};
	const ctx = {
		cwd: join(root, "project"),
		isProjectTrusted: () => false,
		modelRegistry: {
			find: (provider: string, model: string) =>
				provider === primary.provider && model === primary.id
					? primary
					: provider === fallback.provider && model === fallback.id
						? fallback
						: undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
		},
		sessionManager: { getBranch: () => branch },
		signal: undefined,
		abort: () => undefined,
		ui: {
			setStatus: () => undefined,
			notify: (message: string) => notices.push(message),
		},
	} as never;

	try {
		branch = [
			{ type: "message", message: { role: "user", content: "Run the test." } },
			{
				type: "message",
				id: "batch-1",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1" }],
				},
			},
		];
		const recovered = event("bash", { command: "echo safe" });
		(recovered as { toolCallId: string }).toolCallId = "call-1";
		assert.equal(await handlers.get("tool_call")?.(recovered, ctx), undefined);
		assert.deepEqual(reviewCalls, [
			"custom/reviewer",
			"openai-codex/codex-auto-review",
		]);
		assert.equal(Object.isFrozen(recovered.input), true);
		assert.match(notices.join("\n"), /using fallback/);

		mode = "fail";
		branch = [
			{ type: "message", message: { role: "user", content: "Run again." } },
			{
				type: "message",
				id: "batch-2",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-2" }],
				},
			},
		];
		const failed = event("bash", { command: "echo again" });
		(failed as { toolCallId: string }).toolCallId = "call-2";
		const blocked = (await handlers.get("tool_call")?.(failed, ctx)) as
			| { block: boolean; reason: string }
			| undefined;
		assert.equal(blocked?.block, true);
		assert.doesNotMatch(
			blocked?.reason ?? "",
			/fallback|openai-codex|custom\/reviewer|secondary channel/i,
		);
		assert.match(notices.join("\n"), /primary and fallback reviewers both failed/);
		assert.match(notices.join("\n"), /primary channel failed/);
		assert.match(notices.join("\n"), /secondary channel failed/);
	} finally {
		ReviewerSessionController.prototype.review = originalReview;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousPrimary === undefined)
			delete process.env.PI_APPROVAL_GUARDIAN_MODEL;
		else process.env.PI_APPROVAL_GUARDIAN_MODEL = previousPrimary;
		if (previousFallback === undefined)
			delete process.env.PI_APPROVAL_GUARDIAN_FALLBACK_MODEL;
		else process.env.PI_APPROVAL_GUARDIAN_FALLBACK_MODEL = previousFallback;
	}
});

test("locks approved tool arguments against later handlers", () => {
	const input = { path: "src/app.ts", nested: { value: "approved" } };
	const guarded = event("custom_reader", input);
	lockReviewedToolInput(guarded);
	assert.equal(Object.isFrozen(guarded.input), true);
	assert.equal(Object.isFrozen((guarded.input as typeof input).nested), true);
	assert.throws(() => {
		(guarded as { input: unknown }).input = { path: "other.ts" };
	}, TypeError);
	assert.throws(() => {
		(guarded.input as typeof input).nested.value = "changed";
	}, TypeError);
});

test("fails closed when an allowed input contains exotic runtime values", () => {
	const assessment = {
		risk_level: "low" as const,
		user_authorization: "unknown" as const,
		outcome: "allow" as const,
		rationale: "",
	};
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	const accessor = Object.defineProperty({}, "secret", {
		enumerable: true,
		get: () => "value",
	});
	const customPrototypeArray: unknown[] = [];
	Object.setPrototypeOf(customPrototypeArray, Object.create(Array.prototype));
	const arrayWithProperty = [] as unknown[] & { metadata?: string };
	arrayWithProperty.metadata = "not serialized";
	for (const [exotic, expected] of [
		[new Map([["key", "value"]]), /non-plain object/],
		[new Set(["value"]), /non-plain object/],
		[new Uint8Array([1]), /non-plain object/],
		[cyclic, /cyclic object graph/],
		[accessor, /non-JSON property/],
		[customPrototypeArray, /custom prototype/],
		[new Array(1), /sparse array/],
		[arrayWithProperty, /non-JSON array property/],
	] as const) {
		const guarded = event("custom_reader", {
			path: "src/app.ts",
			exotic,
		});
		assert.throws(() => lockReviewedToolInput(guarded), expected);
		const result = lockAllowedToolInput(guarded, {
			kind: "allowed",
			assessment,
		});
		assert.equal(result.kind, "failure");
		if (result.kind === "failure") assert.match(result.message, /could not be locked/);
	}
});

test("reports unavailable configured auth in health status", () => {
	const config = loadGuardianConfig({
		cwd: "/repo/project",
		projectTrusted: false,
		agentDir: "/missing-agent-dir",
		env: { PI_APPROVAL_GUARDIAN_MODEL: "custom/reviewer" },
	});
	const model = {
		provider: "custom",
		id: "reviewer",
	} as never;
	const registry = {
		find: (provider: string, modelId: string) =>
			provider === "custom" && modelId === "reviewer" ? model : undefined,
		hasConfiguredAuth: () => false,
	};
	assert.deepEqual(guardianHealth(config, registry as never), {
		ready: false,
		reason:
			"Reviewer authentication is unavailable for custom. Fallback unavailable: Reviewer model not found: openai-codex/codex-auto-review.",
	});
});

test("uses the default Codex fallback when a custom primary is unavailable", () => {
	const config = loadGuardianConfig({
		cwd: "/repo/project",
		projectTrusted: false,
		agentDir: "/missing-agent-dir",
		env: { PI_APPROVAL_GUARDIAN_MODEL: "custom/reviewer" },
	});
	const fallback = {
		provider: "openai-codex",
		id: "codex-auto-review",
	} as never;
	const registry = {
		find: (provider: string, model: string) =>
			provider === "openai-codex" && model === "codex-auto-review"
				? fallback
				: undefined,
		hasConfiguredAuth: () => true,
	};
	assert.deepEqual(guardianHealth(config, registry as never), {
		ready: true,
		reason: "Reviewer model not found: custom/reviewer.",
		usingFallback: true,
	});
});

test("reports a degraded fallback while the primary remains ready", () => {
	const config = loadGuardianConfig({
		cwd: "/repo/project",
		projectTrusted: false,
		agentDir: "/missing-agent-dir",
		env: {
			PI_APPROVAL_GUARDIAN_MODEL: "custom/reviewer",
			PI_APPROVAL_GUARDIAN_FALLBACK_MODEL: "missing/fallback",
		},
	});
	const primary = { provider: "custom", id: "reviewer" } as never;
	const registry = {
		find: (provider: string, model: string) =>
			provider === "custom" && model === "reviewer" ? primary : undefined,
		hasConfiguredAuth: () => true,
	};
	assert.deepEqual(guardianHealth(config, registry as never), {
		ready: true,
		reason: "Fallback unavailable: Reviewer model not found: missing/fallback.",
		fallbackUnavailable: true,
	});
});

test("registers lifecycle health and verifies command authentication", async () => {
	const handlers = new Map<string, (event: unknown, ctx: never) => unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: never) => unknown }>();
	approvalGuardian({
		on: (name: string, handler: (event: unknown, ctx: never) => unknown) => {
			handlers.set(name, handler);
		},
		registerCommand: (
			name: string,
			options: { handler: (args: string, ctx: never) => unknown },
		) => commands.set(name, options),
	} as never);
	assert.equal(handlers.has("session_start"), true);
	assert.equal(handlers.has("tool_call"), true);
	assert.equal(commands.has("approval-guardian"), true);
	const calls: Array<[string, string | undefined]> = [];
	const notices: string[] = [];
	const model = { provider: "openai-codex", id: "codex-auto-review" };
	await handlers.get("session_start")?.({}, {
		cwd: "/repo/project",
		isProjectTrusted: () => false,
		modelRegistry: {
			find: () => model,
			hasConfiguredAuth: () => false,
		},
		ui: {
			setStatus: (key: string, value: string | undefined) =>
				calls.push([key, value]),
			notify: (message: string) => notices.push(message),
		},
	} as never);
	assert.deepEqual(calls, [["approval-guardian", "Guardian · needs attention"]]);
	assert.match(notices.join("\n"), /authentication is unavailable/);

	calls.length = 0;
	notices.length = 0;
	await commands.get("approval-guardian")?.handler("", {
		cwd: "/repo/project",
		isProjectTrusted: () => false,
		modelRegistry: {
			find: () => model,
			hasConfiguredAuth: () => true,
			getApiKeyAndHeaders: async () => ({ ok: false, error: "missing" }),
		},
		ui: {
			setStatus: (key: string, value: string | undefined) =>
				calls.push([key, value]),
			notify: (message: string) => notices.push(message),
		},
	} as never);
	assert.deepEqual(calls, [["approval-guardian", "Guardian · needs attention"]]);
	assert.match(notices.join("\n"), /authentication is unavailable/);
	assert.match(notices.join("\n"), /same as primary \(no separate fallback\)/);
	assert.doesNotMatch(notices.join("\n"), /Fallback unavailable:/);
});

test("private-data reviews expose no investigation tools", () => {
	assert.deepEqual(
		reviewerToolsForAction({
			tool: "read",
			cwd: "/repo",
			payload: { private_data_read: true },
		}),
		[],
	);
	assert.equal(
		reviewerToolsForAction({ tool: "bash", cwd: "/repo", payload: {} }),
		undefined,
	);
});

test("requires a high-authorization reviewer decision for private reads", () => {
	const action = {
		tool: "read",
		cwd: "/repo/project",
		payload: { path: "/repo/project/.env", private_data_read: true },
	};
	const blocked = enforceActionRequirements(action, {
		kind: "allowed",
		assessment: {
			risk_level: "low",
			user_authorization: "unknown",
			outcome: "allow",
			rationale: "",
		},
	});
	assert.equal(blocked.kind, "denied");

	const allowed = enforceActionRequirements(action, {
		kind: "allowed",
		assessment: {
			risk_level: "high",
			user_authorization: "high",
			outcome: "allow",
			rationale: "Explicitly authorized.",
		},
	});
	assert.equal(allowed.kind, "allowed");
});

test("fails closed on contradictory high and critical allow decisions", () => {
	const action = { tool: "bash", cwd: "/repo", payload: { command: "deploy" } };
	for (const assessment of [
		{
			risk_level: "critical" as const,
			user_authorization: "high" as const,
			outcome: "allow" as const,
			rationale: "",
		},
		{
			risk_level: "high" as const,
			user_authorization: "unknown" as const,
			outcome: "allow" as const,
			rationale: "",
		},
	]) {
		assert.equal(
			enforceActionRequirements(action, { kind: "allowed", assessment }).kind,
			"denied",
		);
	}
});
