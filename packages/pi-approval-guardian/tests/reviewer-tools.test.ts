// pi-lens-ignore: find-import-file-without-extension
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createReviewerToolDefinitions,
	reviewerInvestigationTouchesPrivateData,
	reviewerToolSessionOptions,
} from "../src/reviewer-tools.ts";

test("configures guarded reviewer tools without enabling unrestricted built-ins", () => {
	const normal = reviewerToolSessionOptions("/repo");
	assert.equal(normal.noTools, "builtin");
	assert.deepEqual(normal.tools, ["read", "grep", "find", "ls"]);
	assert.deepEqual(
		normal.customTools?.map((tool) => tool.name),
		["read", "grep", "find", "ls"],
	);

	const privateReview = reviewerToolSessionOptions("/repo", []);
	assert.deepEqual(privateReview, { tools: [], noTools: "all" });
});

test("blocks classified private reviewer investigations while preserving narrow source access", () => {
	const project = mkdtempSync(join(tmpdir(), "guardian-reviewer-tools-"));
	mkdirSync(join(project, "src"));
	writeFileSync(join(project, "src", "app.ts"), "export const ready = true;\n");
	writeFileSync(join(project, ".env"), "TOKEN=test\n");

	assert.equal(
		reviewerInvestigationTouchesPrivateData(
			"read",
			{ path: join(project, ".env") },
			project,
		),
		true,
	);
	assert.equal(
		reviewerInvestigationTouchesPrivateData(
			"read",
			{ path: join(project, "src", "app.ts") },
			project,
		),
		false,
	);
	assert.equal(
		reviewerInvestigationTouchesPrivateData(
			"grep",
			{ path: project, pattern: "TOKEN" },
			project,
		),
		true,
	);
	assert.equal(
		reviewerInvestigationTouchesPrivateData(
			"grep",
			{ path: project, pattern: "ready", glob: "src/**/*.ts" },
			project,
		),
		false,
	);
	assert.equal(
		reviewerInvestigationTouchesPrivateData(
			"find",
			{ path: project, pattern: "*" },
			project,
		),
		true,
	);
	assert.equal(
		reviewerInvestigationTouchesPrivateData(
			"ls",
			{ path: project },
			project,
		),
		true,
	);
	assert.equal(
		reviewerInvestigationTouchesPrivateData(
			"ls",
			{ path: join(project, "src") },
			project,
		),
		false,
	);
});

test("guarded reviewer definitions reject private reads before built-in execution", async () => {
	const project = mkdtempSync(join(tmpdir(), "guardian-reviewer-read-"));
	const source = join(project, "app.ts");
	const privateFile = join(project, ".env");
	writeFileSync(source, "export const value = 1;\n");
	writeFileSync(privateFile, "TOKEN=test\n");
	const read = createReviewerToolDefinitions(project, ["read"])[0];
	assert.ok(read);

	await assert.rejects(
		read.execute(
			"private-read",
			{ path: privateFile },
			undefined,
			undefined,
			{} as never,
		),
		(error: Error) => {
			assert.equal(
				error.message,
				"Reviewer investigation blocked because the requested scope may contain private local data.",
			);
			assert.doesNotMatch(error.message, /TOKEN|\.env/);
			return true;
		},
	);

	const result = await read.execute(
		"source-read",
		{ path: source },
		undefined,
		undefined,
		{} as never,
	);
	assert.match(
		result.content
			.flatMap((item) => (item.type === "text" ? [item.text] : []))
			.join("\n"),
		/export const value/,
	);
});
