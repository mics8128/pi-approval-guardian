import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import approvalGuardian, * as piEntryPoint from "../extensions/index.ts";
import {
	decideGuardianAction,
	guardianInputIdentity,
	normalizePiToolAction,
	type NormalizedGuardianAction,
} from "../extensions/index.ts";
import { ReviewerSessionController } from "../src/reviewer-session.ts";

test("public Pi adapter exposes no superseded composition entry points", () => {
	for (const removed of [
		"enforceActionRequirements",
		"lockAllowedToolInput",
		"lockReviewedToolInput",
		"normalizePiBashAction",
	]) {
		assert.equal(removed in piEntryPoint, false, removed);
	}
	assert.equal(typeof piEntryPoint.normalizePiToolAction, "function");
	assert.equal(typeof piEntryPoint.decideGuardianAction, "function");
});

function bashEvent(command: string, toolCallId: string): ToolCallEvent {
	return {
		toolName: "bash",
		toolCallId,
		input: { command },
	} as unknown as ToolCallEvent;
}

test("routes a Pi bash allow through the normalized action-to-decision seam", async () => {
	const handlers = new Map<string, (event: unknown, ctx: never) => unknown>();
	approvalGuardian({
		on: (name: string, handler: (event: unknown, ctx: never) => unknown) =>
			handlers.set(name, handler),
		registerCommand: () => undefined,
	} as never);
	const originalReview = ReviewerSessionController.prototype.review;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const root = mkdtempSync(join(tmpdir(), "guardian-normalized-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	const reviewed: NormalizedGuardianAction[] = [];
	ReviewerSessionController.prototype.review = async (action) => {
		reviewed.push(action as NormalizedGuardianAction);
		return {
			kind: "allowed",
			assessment: {
				risk_level: "low",
				user_authorization: "unknown",
				outcome: "allow",
				rationale: "Representative benign shell command.",
			},
		};
	};
	const model = { provider: "openai-codex", id: "codex-auto-review" };
	const event = bashEvent("printf safe", "normalized-allow");
	const ctx = {
		cwd: root,
		isProjectTrusted: () => false,
		model,
		modelRegistry: {
			find: () => model,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
		},
		sessionManager: {
			getBranch: () => [{
				type: "message",
				id: "normalized-batch",
				message: { role: "assistant", content: [{ type: "toolCall", id: "normalized-allow" }] },
			}],
		},
		signal: undefined,
		abort: () => undefined,
		ui: { notify: () => undefined },
	} as never;

	try {
		assert.equal(await handlers.get("tool_call")?.(event, ctx), undefined);
		assert.equal(Object.isFrozen(event.input), true);
		assert.equal(reviewed.length, 1);
		assert.match(reviewed[0]?.inputIdentity ?? "", /^sha256:[a-f0-9]{64}$/);
		const { inputIdentity: _inputIdentity, ...action } = reviewed[0];
		assert.deepEqual(action, {
			host: "pi",
			tool: "bash",
			operation: "execute",
			payload: { command: "printf safe", private_data_read: false },
			cwd: realpathSync(root),
			reviewReasons: ["bash.command configured for review"],
			privacy: { privateDataRead: false },
			payloadState: {
				complete: true,
				originalChars: "printf safe".length,
				retainedChars: "printf safe".length,
			},
		});
	} finally {
		ReviewerSessionController.prototype.review = originalReview;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});


test("routes a Pi bash denial through the normalized action-to-decision seam", async () => {
	const handlers = new Map<string, (event: unknown, ctx: never) => unknown>();
	approvalGuardian({
		on: (name: string, handler: (event: unknown, ctx: never) => unknown) => handlers.set(name, handler),
		registerCommand: () => undefined,
	} as never);
	const originalReview = ReviewerSessionController.prototype.review;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const root = mkdtempSync(join(tmpdir(), "guardian-normalized-deny-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	let reviewed: NormalizedGuardianAction | undefined;
	ReviewerSessionController.prototype.review = async (action) => {
		reviewed = action as NormalizedGuardianAction;
		return {
			kind: "denied",
			assessment: {
				risk_level: "high",
				user_authorization: "unknown",
				outcome: "deny",
				rationale: "The private read was not authorized.",
			},
		};
	};
	const model = { provider: "openai-codex", id: "codex-auto-review" };
	const event = bashEvent("cat .env", "normalized-deny");
	const ctx = {
		cwd: root,
		isProjectTrusted: () => false,
		model,
		modelRegistry: {
			find: () => model,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
		},
		sessionManager: {
			getBranch: () => [{
				type: "message",
				id: "normalized-deny-batch",
				message: { role: "assistant", content: [{ type: "toolCall", id: "normalized-deny" }] },
			}],
		},
		signal: undefined,
		abort: () => undefined,
		ui: { notify: () => undefined },
	} as never;

	try {
		const decision = await handlers.get("tool_call")?.(event, ctx) as
			| { block: boolean; reason: string }
			| undefined;
		assert.equal(decision?.block, true);
		assert.match(decision?.reason ?? "", /private read was not authorized/i);
		assert.equal(Object.isFrozen(event.input), false);
		assert.deepEqual(reviewed?.privacy, { privateDataRead: true });
		assert.deepEqual(reviewed?.reviewReasons, [
			"bash.command configured for review",
			"private data read",
		]);
	} finally {
		ReviewerSessionController.prototype.review = originalReview;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});



test("routes a non-shell Pi action through the normalized decision seam", async () => {
	const handlers = new Map<string, (event: unknown, ctx: never) => unknown>();
	approvalGuardian({
		on: (name: string, handler: (event: unknown, ctx: never) => unknown) => handlers.set(name, handler),
		registerCommand: () => undefined,
	} as never);
	const originalReview = ReviewerSessionController.prototype.review;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const root = mkdtempSync(join(tmpdir(), "guardian-normalized-read-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	writeFileSync(join(root, ".env"), "TOKEN=test");
	let reviewed: NormalizedGuardianAction | undefined;
	ReviewerSessionController.prototype.review = async (action) => {
		reviewed = action as NormalizedGuardianAction;
		return {
			kind: "allowed",
			assessment: {
				risk_level: "low",
				user_authorization: "unknown",
				outcome: "allow",
				rationale: "Reviewer attempted to allow the private read.",
			},
		};
	};
	const model = { provider: "openai-codex", id: "codex-auto-review" };
	const event = {
		toolName: "read",
		toolCallId: "normalized-read",
		input: { path: ".env" },
	} as unknown as ToolCallEvent;
	const ctx = {
		cwd: root,
		isProjectTrusted: () => false,
		model,
		modelRegistry: {
			find: () => model,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
		},
		sessionManager: {
			getBranch: () => [{
				type: "message",
				id: "normalized-read-batch",
				message: { role: "assistant", content: [{ type: "toolCall", id: "normalized-read" }] },
			}],
		},
		signal: undefined,
		abort: () => undefined,
		ui: { notify: () => undefined },
	} as never;

	try {
		const result = await handlers.get("tool_call")?.(event, ctx) as
			| { block: boolean; reason: string }
			| undefined;
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /private-data read lacks explicit high/i);
		assert.equal(reviewed?.host, "pi");
		assert.equal(reviewed?.tool, "read");
		assert.equal(reviewed?.operation, "read");
		assert.deepEqual(reviewed?.privacy, { privateDataRead: true });
		assert.match(reviewed?.inputIdentity ?? "", /^sha256:[a-f0-9]{64}$/);
		assert.equal(reviewed?.payloadState.complete, true);
	} finally {
		ReviewerSessionController.prototype.review = originalReview;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});


test("snapshots nested non-shell input before asynchronous review", async () => {
	const handlers = new Map<string, (event: unknown, ctx: never) => unknown>();
	approvalGuardian({
		on: (name: string, handler: (event: unknown, ctx: never) => unknown) => handlers.set(name, handler),
		registerCommand: () => undefined,
	} as never);
	const originalReview = ReviewerSessionController.prototype.review;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const root = mkdtempSync(join(tmpdir(), "guardian-normalized-edit-aba-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	let reviewerStarted!: () => void;
	const started = new Promise<void>((resolve) => { reviewerStarted = resolve; });
	let finishReview!: (result: never) => void;
	const pendingReview = new Promise<never>((resolve) => { finishReview = resolve; });
	let reviewed: NormalizedGuardianAction | undefined;
	ReviewerSessionController.prototype.review = async (action) => {
		reviewed = action as NormalizedGuardianAction;
		reviewerStarted();
		return pendingReview;
	};
	const model = { provider: "openai-codex", id: "codex-auto-review" };
	const input = {
		path: join(root, "..", "outside.txt"),
		edits: [{ oldText: "old", newText: "initial-A" }],
	};
	const event = { toolName: "edit", toolCallId: "normalized-edit-aba", input } as unknown as ToolCallEvent;
	const ctx = {
		cwd: root,
		isProjectTrusted: () => false,
		model,
		modelRegistry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }) },
		sessionManager: { getBranch: () => [{ type: "message", id: "edit-aba-batch", message: { role: "assistant", content: [{ type: "toolCall", id: "normalized-edit-aba" }] } }] },
		signal: undefined,
		abort: () => undefined,
		ui: { notify: () => undefined },
	} as never;
	try {
		const handling = handlers.get("tool_call")?.(event, ctx) as Promise<{ block: boolean; reason: string } | undefined>;
		await started;
		input.edits[0]!.newText = "temporary-B";
		assert.equal((reviewed?.payload.edits as typeof input.edits)[0]!.newText, "initial-A");
		input.edits[0]!.newText = "initial-A";
		finishReview({ kind: "allowed", assessment: { risk_level: "low", user_authorization: "unknown", outcome: "allow", rationale: "Exact edit allowed." } } as never);
		assert.equal(await handling, undefined);
		assert.equal(Object.isFrozen(input.edits[0]), true);
	} finally {
		ReviewerSessionController.prototype.review = originalReview;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("preserves review and allow behavior for a classified non-shell payload over 64K", async () => {
	const handlers = new Map<string, (event: unknown, ctx: never) => unknown>();
	approvalGuardian({ on: (name: string, handler: (event: unknown, ctx: never) => unknown) => handlers.set(name, handler), registerCommand: () => undefined } as never);
	const originalReview = ReviewerSessionController.prototype.review;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const root = mkdtempSync(join(tmpdir(), "guardian-normalized-large-write-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	const content = "x".repeat(70_000);
	let reviewed: NormalizedGuardianAction | undefined;
	ReviewerSessionController.prototype.review = async (action) => {
		reviewed = action as NormalizedGuardianAction;
		return { kind: "allowed", assessment: { risk_level: "low", user_authorization: "unknown", outcome: "allow", rationale: "Write allowed." } };
	};
	const model = { provider: "openai-codex", id: "codex-auto-review" };
	const input = { path: join(root, "..", "large.txt"), content };
	const event = { toolName: "write", toolCallId: "normalized-large-write", input } as unknown as ToolCallEvent;
	const ctx = {
		cwd: root, isProjectTrusted: () => false, model,
		modelRegistry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }) },
		sessionManager: { getBranch: () => [{ type: "message", id: "large-write-batch", message: { role: "assistant", content: [{ type: "toolCall", id: "normalized-large-write" }] } }] },
		signal: undefined, abort: () => undefined, ui: { notify: () => undefined },
	} as never;
	try {
		assert.equal(await handlers.get("tool_call")?.(event, ctx), undefined);
		assert.equal(reviewed?.payloadState.complete, true);
		assert.equal(reviewed?.payload.content, content);
		assert.equal(Object.isFrozen(input), true);
	} finally {
		ReviewerSessionController.prototype.review = originalReview;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("fails closed before review when the normalized bash payload is incomplete", async () => {
	const command = `side_effect ${"x".repeat(64_001)}`;
	const input = { command };
	const action = normalizePiToolAction(
		{ tool: "bash", payload: { command, private_data_read: false }, cwd: "/repo" },
		input,
	);
	assert.equal(action.payloadState.complete, false);
	assert.equal(action.payloadState.originalChars, command.length);
	assert.ok(String(action.payload.command).length <= 64_000);
	assert.match(String(action.payload.command), /guardian_action_truncated/);
	let reviewerCalled = false;
	let sideEffect = false;
	const circuitOutcomes: boolean[] = [];

	const decision = await decideGuardianAction(action, {
		isCircuitOpen: () => false,
		review: async () => {
			reviewerCalled = true;
			return {
				kind: "allowed",
				assessment: {
					risk_level: "low",
					user_authorization: "unknown",
					outcome: "allow",
					rationale: "Must not be reached.",
				},
			};
		},
		protectInput: () => Object.freeze(input),
		recordCircuitOutcome: (adverse) => circuitOutcomes.push(adverse),
	});
	if (decision.verdict === "allow") sideEffect = true;

	assert.equal(decision.verdict, "block");
	assert.equal(decision.result.kind, "failure");
	if (decision.result.kind === "failure") {
		assert.match(decision.result.message, /incomplete|truncated|payload limit/i);
	}
	assert.equal(reviewerCalled, false);
	assert.equal(Object.isFrozen(input), false);
	assert.equal(sideEffect, false);
	assert.deepEqual(circuitOutcomes, [true]);
	assert.deepEqual(decision.audit, {
		host: "pi",
		tool: "bash",
		operation: "execute",
		inputIdentity: action.inputIdentity,
		outcome: "failure",
	});
});


test("blocks a Pi bash input that changes while its normalized action is reviewed", async () => {
	const handlers = new Map<string, (event: unknown, ctx: never) => unknown>();
	approvalGuardian({
		on: (name: string, handler: (event: unknown, ctx: never) => unknown) => handlers.set(name, handler),
		registerCommand: () => undefined,
	} as never);
	const originalReview = ReviewerSessionController.prototype.review;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const root = mkdtempSync(join(tmpdir(), "guardian-normalized-mutation-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	let reviewedCommand: unknown;
	let reviewerStarted!: () => void;
	const started = new Promise<void>((resolve) => { reviewerStarted = resolve; });
	let finishReview!: (result: never) => void;
	const pendingReview = new Promise<never>((resolve) => { finishReview = resolve; });
	ReviewerSessionController.prototype.review = async (action) => {
		reviewedCommand = action.payload.command;
		reviewerStarted();
		return pendingReview;
	};
	const model = { provider: "openai-codex", id: "codex-auto-review" };
	const event = bashEvent("printf reviewed-A", "normalized-mutation");
	const ctx = {
		cwd: root,
		isProjectTrusted: () => false,
		model,
		modelRegistry: {
			find: () => model,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
		},
		sessionManager: {
			getBranch: () => [{
				type: "message",
				id: "normalized-mutation-batch",
				message: { role: "assistant", content: [{ type: "toolCall", id: "normalized-mutation" }] },
			}],
		},
		signal: undefined,
		abort: () => undefined,
		ui: { notify: () => undefined },
	} as never;

	try {
		const handling = handlers.get("tool_call")?.(event, ctx) as Promise<
			{ block: boolean; reason: string } | undefined
		>;
		await started;
		(event.input as { command: string }).command = "printf mutated-B";
		finishReview({
			kind: "allowed",
			assessment: {
				risk_level: "low",
				user_authorization: "unknown",
				outcome: "allow",
				rationale: "Allowed reviewed input A.",
			},
		} as never);
		const result = await handling;
		let executed = false;
		if (!result?.block) executed = true;

		assert.equal(reviewedCommand, "printf reviewed-A");
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /input.*changed|identity/i);
		assert.equal(executed, false);
		assert.equal(Object.isFrozen(event.input), false);
	} finally {
		ReviewerSessionController.prototype.review = originalReview;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});



test("blocks exotic Pi input without invoking proxy traps or getters", async () => {
	const handlers = new Map<string, (event: unknown, ctx: never) => unknown>();
	approvalGuardian({ on: (name: string, handler: (event: unknown, ctx: never) => unknown) => handlers.set(name, handler), registerCommand: () => undefined } as never);
	let trapCalls = 0;
	let getterCalls = 0;
	const inputs = [
		new Proxy({ path: ".env" }, { ownKeys: () => { trapCalls++; return ["path"]; } }),
		Object.defineProperty({}, "path", { enumerable: true, get: () => { getterCalls++; return ".env"; } }),
	];
	for (const [index, input] of inputs.entries()) {
		const event = { toolName: "read", toolCallId: `exotic-${index}`, input } as unknown as ToolCallEvent;
		const result = await handlers.get("tool_call")?.(event, {
			cwd: "/repo", isProjectTrusted: () => false,
			sessionManager: { getBranch: () => [] },
			ui: { notify: () => undefined }, abort: () => undefined,
		} as never) as { block: boolean; reason: string } | undefined;
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /malformed|unsafe/i);
	}
	assert.equal(trapCalls, 0);
	assert.equal(getterCalls, 0);
});

test("computes deterministic identities only for complete JSON-like input", () => {
	assert.equal(
		guardianInputIdentity({ second: [2, true], first: "value" }),
		guardianInputIdentity({ first: "value", second: [2, true] }),
	);
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	assert.throws(() => guardianInputIdentity(cyclic), /cyclic input/);
	let proxyTrapCalls = 0;
	const proxy = new Proxy({}, { ownKeys: () => { proxyTrapCalls++; return []; } });
	assert.throws(() => guardianInputIdentity({ nested: proxy }), /proxy/i);
	assert.equal(proxyTrapCalls, 0, "proxy traps must not run during rejection");
	assert.throws(
		() => guardianInputIdentity(new Map([["key", "value"]])),
		/not a plain object/,
	);
	assert.throws(
		() =>
			guardianInputIdentity(
				Object.defineProperty({}, "secret", {
					enumerable: true,
					get: () => "value",
				}),
			),
		/invalid input property/,
	);
	let getterCalls = 0;
	const accessorArray: unknown[] = [];
	accessorArray.length = 1;
	Object.defineProperty(accessorArray, "0", {
		enumerable: true,
		get: () => {
			getterCalls++;
			return "value";
		},
	});
	assert.throws(() => guardianInputIdentity(accessorArray), /invalid input array entry/);
	assert.equal(getterCalls, 0, "input identity must never invoke an array accessor");
	assert.notEqual(
		guardianInputIdentity({ value: -0 }),
		guardianInputIdentity({ value: 0 }),
		"negative zero must retain its exact numeric identity",
	);
	const sharedChild = { value: "same" };
	assert.throws(
		() => guardianInputIdentity({ first: sharedChild, second: sharedChild }),
		/repeated input reference/,
	);
	assert.doesNotThrow(() =>
		guardianInputIdentity({ first: { value: "same" }, second: { value: "same" } }),
	);
	const sparseArray: unknown[] & { extra?: string } = [];
	sparseArray.length = 1;
	sparseArray.extra = "not-an-index";
	assert.throws(() => guardianInputIdentity(sparseArray), /invalid input array entry/);
});
