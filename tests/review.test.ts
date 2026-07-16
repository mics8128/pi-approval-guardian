import assert from "node:assert/strict";
import test from "node:test";
import { UPSTREAM_GUARDIAN_COMMIT } from "../src/policy.ts";
import {
	buildGuardianPrompt,
	buildGuardianTranscript,
	DEFAULT_REVIEWER_MODEL,
	GUARDIAN_POLICY,
	parseGuardianAssessment,
	parseModelSpec,
	type GuardianMessage,
} from "../src/review.ts";

test("tracks the synced upstream Guardian commit", () => {
	assert.equal(
		UPSTREAM_GUARDIAN_COMMIT,
		"03bb3b12367397e14a8facc2e018d645ff4d8e83",
	);
});

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
		action: {
			tool: "bash",
			payload: { command: "rm -rf .cache" },
			cwd: "/repo",
		},
		transcript: "[1] user: remove generated cache",
	});
	assert.match(prompt, /TRANSCRIPT START/);
	assert.match(prompt, /untrusted evidence/);
	assert.match(prompt, /APPROVAL REQUEST START/);
	assert.match(prompt, /"command": "rm -rf .cache"/);
	assert.match(prompt, /"cwd": "\/repo"/);
});

test("uses the current Guardian policy and read-only investigation rules", () => {
	assert.match(GUARDIAN_POLICY, /read, grep, find, and ls tools/);
	assert.match(
		GUARDIAN_POLICY,
		/Never mutate files or execute the planned action/,
	);
	assert.match(
		GUARDIAN_POLICY,
		/Post-denial user approval has highest precedence/,
	);
	assert.match(
		GUARDIAN_POLICY,
		/Directly reading auth files into shell-visible variables/,
	);
});

test("builds transcript delta prompts for a reused reviewer session", () => {
	const prompt = buildGuardianPrompt({
		action: {
			tool: "edit",
			payload: { path: "/home/user/.ssh/config", edits: [] },
			cwd: "/repo",
		},
		transcript: "[4] user: update that exact SSH host entry",
		mode: "delta",
		retryReason: "The prior provider request failed.",
	});
	assert.match(prompt, /TRANSCRIPT DELTA START/);
	assert.match(prompt, /Continue the same review conversation/);
	assert.match(prompt, /Retry reason:/);
	assert.match(prompt, /"tool": "edit"/);
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
