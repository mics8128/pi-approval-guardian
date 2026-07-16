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
	shouldReviewPath,
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

test("requires review for common Linux, macOS, and Windows private locations", () => {
	for (const path of [
		"/home/test/.ssh/config",
		"/home/test/.gnupg/private-keys-v1.d/key",
		"/home/test/.aws/credentials",
		"/home/test/.azure/accessTokens.json",
		"/home/test/.kube/config",
		"/home/test/.docker/config.json",
		"/home/test/.pi/agent/auth.json",
		"/home/test/.config/gcloud/application_default_credentials.json",
		"/home/test/.config/gh/hosts.yml",
		"/home/test/.password-store/work.gpg",
		"/etc/ssl/private/server.key",
		"/Users/test/Library/Keychains/login.keychain-db",
		"/Users/test/Library/Application Support/Google/Chrome/Default/Login Data",
		"C:\\Users\\test\\.ssh\\id_ed25519",
		"C:\\Users\\test\\AppData\\Roaming\\Microsoft\\Credentials\\token",
		"C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data",
		"C:\\Windows\\System32\\config\\SAM",
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

test("applies configured path review levels", () => {
	const windowsInside = classifyReadPath(
		"C:\\repo\\project\\README.md",
		"C:\\repo\\project",
	);
	assert.equal(windowsInside.outsideProject, false);
	const ordinaryOutside = classifyReadPath("../other/README.md", "/repo/project");
	const privateInside = classifyReadPath(".env", "/repo/project");
	assert.equal(shouldReviewPath("always", ordinaryOutside), true);
	assert.equal(shouldReviewPath("outside-or-private", ordinaryOutside), true);
	assert.equal(shouldReviewPath("private-only", ordinaryOutside), false);
	assert.equal(shouldReviewPath("private-only", privateInside), true);
	assert.equal(shouldReviewPath("off", privateInside), false);
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
