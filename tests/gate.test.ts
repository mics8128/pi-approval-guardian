// pi-lens-ignore: find-import-file-without-extension
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
	classifyReadPath,
	requiresExplicitReadAuthorization,
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

test("requires explicit authorization for project-private reads", () => {
	for (const path of [
		".env",
		".env.local",
		"config/service-account-prod.json",
		"secrets/token.txt",
		"credentials/deploy.json",
		"certs/client.pem",
		"certs/client.key",
	]) {
		assert.equal(
			requiresExplicitReadAuthorization(path, "/repo/project"),
			true,
			path,
		);
	}
	for (const path of ["README.md", "src/config.ts", "package.json"]) {
		assert.equal(
			requiresExplicitReadAuthorization(path, "/repo/project"),
			false,
			path,
		);
	}
});

test("requires explicit authorization for common external private directories", () => {
	for (const path of [
		"/Users/test/.ssh/config",
		"/Users/test/.gnupg/private-keys-v1.d/key",
		"/Users/test/.aws/credentials",
		"/Users/test/.azure/accessTokens.json",
		"/Users/test/.kube/config",
		"/Users/test/.docker/config.json",
		"/Users/test/.pi/agent/auth.json",
		"/Users/test/.config/gcloud/application_default_credentials.json",
		"/Users/test/.config/gh/hosts.yml",
		"/Users/test/Library/Keychains/login.keychain-db",
	]) {
		const target = classifyReadPath(path, "/repo/project");
		assert.equal(target.private, true, path);
		assert.equal(target.outsideProject, true, path);
	}
	assert.equal(
		requiresExplicitReadAuthorization(
			"/Users/test/Documents/notes.txt",
			"/repo/project",
		),
		false,
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
