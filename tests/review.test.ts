import assert from "node:assert/strict";
import test from "node:test";
import {
	buildGuardianPrompt,
	buildGuardianTranscript,
	DEFAULT_REVIEWER_MODEL,
	parseGuardianAssessment,
	parseModelSpec,
	type GuardianMessage,
} from "../src/review.ts";

test("parses the dedicated reviewer model", () => {
	assert.deepEqual(parseModelSpec(undefined), {
		provider: "openai-codex",
		model: "codex-auto-review",
	});
	assert.deepEqual(parseModelSpec("custom/guardian-v2"), {
		provider: "custom",
		model: "guardian-v2",
	});
	assert.equal(parseModelSpec("missing-provider"), undefined);
	assert.equal(DEFAULT_REVIEWER_MODEL, "openai-codex/codex-auto-review");
});

test("builds a bounded transcript with intent and tool evidence", () => {
	const messages: GuardianMessage[] = [
		{ role: "user", content: "Delete only the generated cache directory." },
		{
			role: "assistant",
			content: [
				{
					type: "text",
					text: "I will inspect and remove the generated cache.",
				},
				{ type: "toolCall", name: "read", arguments: { path: ".cache" } },
			],
		},
		{
			role: "toolResult",
			toolName: "read",
			content: [{ type: "text", text: "generated files only" }],
		},
	];
	const transcript = buildGuardianTranscript(messages);
	assert.match(transcript, /Delete only the generated cache/);
	assert.match(transcript, /tool read call/);
	assert.match(transcript, /generated files only/);
});

test("separates untrusted transcript from the exact planned action", () => {
	const prompt = buildGuardianPrompt({
		command: "rm -rf .cache",
		cwd: "/repo",
		transcript: "[1] user: remove generated cache",
	});
	assert.match(prompt, /TRANSCRIPT START/);
	assert.match(prompt, /untrusted evidence/);
	assert.match(prompt, /APPROVAL REQUEST START/);
	assert.match(prompt, /"command": "rm -rf .cache"/);
	assert.match(prompt, /"cwd": "\/repo"/);
});

test("accepts strict and prose-wrapped JSON", () => {
	assert.deepEqual(parseGuardianAssessment('{"outcome":"allow"}'), {
		risk_level: "low",
		user_authorization: "unknown",
		outcome: "allow",
		rationale: "Auto-review returned a low-risk allow decision.",
	});
	assert.deepEqual(
		parseGuardianAssessment(
			'Assessment: {"risk_level":"high","user_authorization":"low","outcome":"deny","rationale":"Broad deletion was not authorized."}',
		),
		{
			risk_level: "high",
			user_authorization: "low",
			outcome: "deny",
			rationale: "Broad deletion was not authorized.",
		},
	);
});

test("rejects malformed reviewer output", () => {
	assert.throws(() => parseGuardianAssessment("allow"), /valid JSON/);
	assert.throws(
		() => parseGuardianAssessment('{"outcome":"maybe"}'),
		/valid outcome/,
	);
});
