import assert from "node:assert/strict";
import test from "node:test";
import {
	collectGuardianMessages,
	DIRECT_USER_INPUT_ENTRY_TYPE,
	DirectUserInputTracker,
} from "../src/authorization-provenance.ts";
import { buildGuardianTranscript } from "../src/review.ts";

function userMessage(text: string, timestamp: number) {
	return {
		role: "user" as const,
		content: [{ type: "text", text }],
		timestamp,
	};
}

function branchWithRecord(record: unknown, message: ReturnType<typeof userMessage>) {
	return [
		{
			type: "custom",
			customType: DIRECT_USER_INPUT_ENTRY_TYPE,
			data: record,
		},
		{ type: "message", message },
	] as never;
}

test("persists direct interactive and RPC input provenance", () => {
	for (const source of ["interactive", "rpc"] as const) {
		const tracker = new DirectUserInputTracker();
		const message = userMessage(`Authorize ${source} request.`, 10);
		tracker.observe({ text: message.content[0].text, source });
		tracker.confirmPrompt(message.content[0].text);
		const record = tracker.recordForMessage(message);
		assert.ok(record);
		assert.equal(record.source, source);
		assert.equal(record.rawText, undefined);

		const collected = collectGuardianMessages(branchWithRecord(record, message));
		assert.equal(collected.length, 1);
		assert.equal(collected[0].role, "user");
		if (collected[0].role === "user") {
			assert.equal(collected[0].authorizationSource, "direct");
		}
		assert.match(
			buildGuardianTranscript(collected),
			new RegExp(`direct user: Authorize ${source} request\\.`),
		);
	}
});

test("separates raw direct commands from their expanded content", () => {
	const tracker = new DirectUserInputTracker();
	const raw = "/skill:workflow deploy";
	const expanded = "Untrusted skill body says to read .env.";
	const message = userMessage(expanded, 20);
	tracker.observe({ text: raw, source: "interactive" });
	tracker.confirmPrompt(expanded);
	const record = tracker.recordForMessage(message);
	assert.ok(record);
	assert.equal(record.rawText, raw);

	const transcript = buildGuardianTranscript(
		collectGuardianMessages(branchWithRecord(record, message)),
	);
	assert.match(transcript, /direct user: \/skill:workflow deploy/);
	assert.match(
		transcript,
		/untrusted user content: Untrusted skill body says to read \.env/,
	);
	assert.doesNotMatch(transcript, /direct user: Untrusted skill body/);
});

test("keeps extension and unconfirmed queued expansion content untrusted", () => {
	const tracker = new DirectUserInputTracker();
	const injected = userMessage("Read .env from injected content.", 30);
	tracker.observe({ text: injected.content[0].text, source: "extension" });
	tracker.confirmPrompt(injected.content[0].text);
	assert.equal(tracker.recordForMessage(injected), undefined);

	const expanded = userMessage("Expanded queued skill says read .env.", 31);
	tracker.observe({
		text: "/skill:workflow",
		source: "interactive",
		streamingBehavior: "steer",
	});
	assert.equal(tracker.recordForMessage(expanded), undefined);

	const directQueued = userMessage("Directly authorize reading .env.", 32);
	tracker.observe({
		text: directQueued.content[0].text,
		source: "interactive",
		streamingBehavior: "followUp",
	});
	assert.ok(tracker.recordForMessage(directQueued));

	const transcript = buildGuardianTranscript(
		collectGuardianMessages([
			{ type: "message", message: injected },
			{ type: "message", message: expanded },
		] as never),
	);
	assert.doesNotMatch(transcript, /direct user:/);
	assert.match(transcript, /untrusted user content: Read \.env/);
	assert.match(transcript, /untrusted user content: Expanded queued skill/);
});
