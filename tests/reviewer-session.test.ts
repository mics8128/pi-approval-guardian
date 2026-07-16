import assert from "node:assert/strict";
import test from "node:test";
import { promptBeforeDeadline } from "../src/reviewer-session.ts";

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
