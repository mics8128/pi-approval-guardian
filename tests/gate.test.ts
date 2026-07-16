import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	AUTO_REVIEW_DENIAL_WINDOW_SIZE,
	DenialCircuitBreaker,
	MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN,
	MAX_RECENT_AUTO_REVIEW_DENIALS_PER_TURN,
	classifyMutationPath,
	shouldReviewMutation,
} from "../src/gate.ts";

test("opens after three consecutive explicit denials", () => {
	const breaker = new DenialCircuitBreaker();
	assert.equal(MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN, 3);
	assert.equal(breaker.record(true), false);
	assert.equal(breaker.record(true), false);
	assert.equal(breaker.record(true), true);
	breaker.reset();
	assert.equal(breaker.isOpen(), false);
});

test("allows reset consecutive denials but retains the recent window", () => {
	const breaker = new DenialCircuitBreaker();
	for (
		let index = 0;
		index < MAX_RECENT_AUTO_REVIEW_DENIALS_PER_TURN - 1;
		index++
	) {
		assert.equal(breaker.record(true), false);
		breaker.record(false);
	}
	assert.equal(breaker.record(true), true);
	assert.equal(AUTO_REVIEW_DENIAL_WINDOW_SIZE, 50);
});

test("reviews writes and edits outside the project", () => {
	assert.equal(shouldReviewMutation("../outside.txt", "/repo/project"), true);
	assert.equal(shouldReviewMutation("src/app.ts", "/repo/project"), false);
});

test("detects project paths that escape through a symlink", () => {
	const root = mkdtempSync(join(tmpdir(), "guardian-path-"));
	const project = join(root, "project");
	const outside = join(root, "outside");
	mkdirSync(project);
	mkdirSync(outside);
	symlinkSync(outside, join(project, "linked"));
	const target = classifyMutationPath("linked/file.txt", project);
	assert.equal(target.outsideProject, true);
});

test("detects a dangling file symlink that writes outside the project", () => {
	const root = mkdtempSync(join(tmpdir(), "guardian-dangling-"));
	const project = join(root, "project");
	const outside = join(root, "outside");
	mkdirSync(project);
	mkdirSync(outside);
	symlinkSync(join(outside, "new-file.txt"), join(project, "output.txt"));
	const target = classifyMutationPath("output.txt", project);
	assert.equal(target.outsideProject, true);
	assert.equal(
		target.absolutePath,
		join(realpathSync(outside), "new-file.txt"),
	);
});

test("reviews sensitive paths inside the project", () => {
	for (const path of [
		".env",
		".github/workflows/deploy.yml",
		".git/hooks/pre-commit",
		"infra/main.tf",
		"package.json",
		"compose.yaml",
		"certs/server.key",
	]) {
		assert.equal(shouldReviewMutation(path, "/repo/project"), true, path);
	}
	const target = classifyMutationPath(".ssh/config", "/repo/project");
	assert.equal(target.sensitive, true);
	assert.deepEqual(target.reasons, ["sensitive path"]);
});
