import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
	actionFromToolCall,
	enforceActionRequirements,
	reviewerToolsForAction,
} from "../extensions/index.ts";
import { DEFAULT_REVIEW_RULES } from "../src/config.ts";

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
	]) {
		const action = actionFromToolCall(
			event("bash", { command }),
			"/repo/project",
			{ ...DEFAULT_REVIEW_RULES },
		);
		assert.equal(action?.payload.private_data_read, true, command);
	}
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
