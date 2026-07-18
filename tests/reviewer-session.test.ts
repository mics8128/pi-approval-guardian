import assert from "node:assert/strict";
import test from "node:test";
import {
	ReviewerSessionController,
	promptBeforeDeadline,
} from "../src/reviewer-session.ts";

test("prompt deadline returns without waiting for a hung abort", async () => {
	let aborted = 0;
	const session = {
		prompt: () => new Promise<void>(() => undefined),
		abort: async () => {
			aborted++;
			return new Promise<void>(() => undefined);
		},
	};
	const started = Date.now();
	const result = await promptBeforeDeadline(session as never, "review", 20);
	assert.deepEqual(result, {
		kind: "timeout",
		message: "Automatic approval review timed out.",
	});
	assert.equal(aborted, 1);
	assert.ok(Date.now() - started < 500);
});

test("prompt cancellation returns fail closed immediately", async () => {
	let aborted = 0;
	const controller = new AbortController();
	const session = {
		prompt: () => new Promise<void>(() => undefined),
		abort: async () => {
			aborted++;
		},
	};
	const pending = promptBeforeDeadline(
		session as never,
		"review",
		10_000,
		controller.signal,
	);
	controller.abort();
	assert.deepEqual(await pending, {
		kind: "cancelled",
		message: "Guardian review was cancelled.",
	});
	assert.equal(aborted, 1);
});

test("reuses a successful reviewer session with transcript deltas", async () => {
	const prompts: string[] = [];
	let disposed = 0;
	const session = {
		messages: [] as Array<{
			role: "assistant";
			stopReason: "stop";
			content: Array<{ type: "text"; text: string }>;
		}>,
		isStreaming: false,
		prompt: async (prompt: string) => {
			prompts.push(prompt);
			session.messages.push({
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: '{"outcome":"allow"}' }],
			});
		},
		abort: async () => undefined,
		dispose: () => {
			disposed++;
		},
	};
	const controller = new ReviewerSessionController({
		model: { provider: "test", id: "reviewer" } as never,
		modelRegistry: {} as never,
		cwd: "/repo",
		systemPrompt: "Review safely.",
		timeoutMs: 1_000,
	});
	const internals = controller as unknown as {
		session?: typeof session;
		getSession: () => Promise<typeof session>;
	};
	internals.getSession = async () => {
		internals.session = session;
		return session;
	};
	const action = { tool: "bash", cwd: "/repo", payload: { command: "echo ok" } };
	const firstMessage = { role: "user" as const, content: "First request" };
	assert.equal(
		(await controller.review(action, [firstMessage])).kind,
		"allowed",
	);
	assert.equal(
		(
			await controller.review(action, [
				firstMessage,
				{ role: "user", content: "Second request" },
			])
		).kind,
		"allowed",
	);
	assert.equal(prompts.length, 2);
	assert.match(prompts[0], /TRANSCRIPT START/);
	assert.match(prompts[0], /First request/);
	assert.match(prompts[1], /TRANSCRIPT DELTA START/);
	assert.match(prompts[1], /Second request/);
	assert.doesNotMatch(prompts[1], /First request/);
	controller.dispose();
	assert.equal(disposed, 1);
});

test("serializes concurrent reviews within one controller", async () => {
	let activePrompts = 0;
	let maxActivePrompts = 0;
	let promptCount = 0;
	let releaseFirst: (() => void) | undefined;
	let firstEnteredResolve: (() => void) | undefined;
	const firstEntered = new Promise<void>((resolve) => {
		firstEnteredResolve = resolve;
	});
	const firstRelease = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const session = {
		messages: [] as Array<{
			role: "assistant";
			stopReason: "stop";
			content: Array<{ type: "text"; text: string }>;
		}>,
		isStreaming: false,
		prompt: async () => {
			promptCount++;
			activePrompts++;
			maxActivePrompts = Math.max(maxActivePrompts, activePrompts);
			if (promptCount === 1) {
				firstEnteredResolve?.();
				await firstRelease;
			}
			session.messages.push({
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: '{"outcome":"allow"}' }],
			});
			activePrompts--;
		},
		abort: async () => undefined,
		dispose: () => undefined,
	};
	const controller = new ReviewerSessionController({
		model: { provider: "test", id: "reviewer" } as never,
		modelRegistry: {} as never,
		cwd: "/repo",
		systemPrompt: "Review safely.",
		timeoutMs: 1_000,
	});
	const internals = controller as unknown as {
		session?: typeof session;
		getSession: () => Promise<typeof session>;
	};
	internals.getSession = async () => {
		internals.session = session;
		return session;
	};
	const action = { tool: "bash", cwd: "/repo", payload: { command: "echo ok" } };
	const first = controller.review(action, [
		{ role: "user", content: "First request" },
	]);
	const second = controller.review(action, [
		{ role: "user", content: "Second request" },
	]);
	await firstEntered;
	assert.equal(promptCount, 1);
	releaseFirst?.();
	assert.deepEqual(
		(await Promise.all([first, second])).map((result) => result.kind),
		["allowed", "allowed"],
	);
	assert.equal(promptCount, 2);
	assert.equal(maxActivePrompts, 1);
	controller.dispose();
});

test("disposes a late superseded startup without replacing the newer session", async () => {
	type FakeSession = {
		name: string;
		dispose: () => void;
	};
	let firstDisposed = 0;
	let secondDisposed = 0;
	const firstSession: FakeSession = {
		name: "first",
		dispose: () => {
			firstDisposed++;
		},
	};
	const secondSession: FakeSession = {
		name: "second",
		dispose: () => {
			secondDisposed++;
		},
	};
	let resolveFirst!: (session: FakeSession) => void;
	let resolveSecond!: (session: FakeSession) => void;
	const startups = [
		new Promise<FakeSession>((resolve) => {
			resolveFirst = resolve;
		}),
		new Promise<FakeSession>((resolve) => {
			resolveSecond = resolve;
		}),
	];
	const controller = new ReviewerSessionController({
		model: { provider: "test", id: "reviewer" } as never,
		modelRegistry: {} as never,
		cwd: "/repo",
		systemPrompt: "Review safely.",
		timeoutMs: 1_000,
	});
	const internals = controller as unknown as {
		session?: FakeSession;
		instantiateSession: () => Promise<FakeSession>;
		getSession: () => Promise<FakeSession>;
		resetSession: () => void;
	};
	internals.instantiateSession = async () => {
		const startup = startups.shift();
		assert.ok(startup);
		return startup;
	};

	const first = internals.getSession();
	internals.resetSession();
	const second = internals.getSession();
	resolveSecond(secondSession);
	assert.equal(await second, secondSession);
	resolveFirst(firstSession);
	await assert.rejects(first, /startup was superseded/);
	assert.equal(internals.session, secondSession);
	assert.equal(firstDisposed, 1);
	assert.equal(secondDisposed, 0);
	controller.dispose();
	assert.equal(secondDisposed, 1);
});

test("prompt success and failure are distinguished", async () => {
	const success = {
		prompt: async () => undefined,
		abort: async () => undefined,
	};
	assert.equal(
		await promptBeforeDeadline(success as never, "review", 1000),
		undefined,
	);

	const failure = {
		prompt: async () => {
			throw new Error("provider exploded");
		},
		abort: async () => undefined,
	};
	assert.deepEqual(
		await promptBeforeDeadline(failure as never, "review", 1000),
		{
			kind: "failure",
			message: "Automatic approval review failed: provider exploded",
		},
	);
});
