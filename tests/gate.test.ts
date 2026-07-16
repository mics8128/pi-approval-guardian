// pi-lens-ignore: find-import-file-without-extension
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	AUTO_REVIEW_DENIAL_WINDOW_SIZE,
	DenialCircuitBreaker,
	MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN,
	ReviewBatchTracker,
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

test("counts simultaneous reviewed tool calls as one denial batch", () => {
	const breaker = new DenialCircuitBreaker();
	const batches = new ReviewBatchTracker();
	for (const denied of [true, true, true]) batches.record("assistant-1", denied);
	assert.equal(breaker.record(batches.finish("assistant-1") ?? false), false);
	batches.record("assistant-2", true);
	assert.equal(breaker.record(batches.finish("assistant-2") ?? false), false);
	batches.record("assistant-3", true);
	assert.equal(breaker.record(batches.finish("assistant-3") ?? false), true);
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
	symlinkSync(
		outside,
		join(project, "linked"),
		process.platform === "win32" ? "junction" : "dir",
	);
	const target = classifyMutationPath("linked/file.txt", project);
	assert.equal(target.outsideProject, true);
});

test(
	"detects a Windows junction from the project into a private directory",
	{ skip: process.platform !== "win32" },
	() => {
		const root = mkdtempSync(join(tmpdir(), "guardian-junction-"));
		const project = join(root, "project");
		const privateDir = join(root, ".ssh");
		mkdirSync(project);
		mkdirSync(privateDir);
		symlinkSync(privateDir, join(project, "linked"), "junction");
		const target = classifyReadPath("linked/config", project);
		assert.equal(target.private, true);
		assert.equal(target.outsideProject, true);
	},
);

test("detects a dangling file symlink that writes outside the project", () => {
	const root = mkdtempSync(join(tmpdir(), "guardian-dangling-"));
	const project = join(root, "project");
	const outside = join(root, "outside");
	mkdirSync(project);
	mkdirSync(outside);
	symlinkSync(
		join(outside, "new-file.txt"),
		join(project, "output.txt"),
		"file",
	);
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

test("narrows Pi private reads to known confidential data", () => {
	for (const path of [
		"/home/test/.pi/settings.json",
		"/home/test/.pi/web-search.json",
		"/home/test/.pi/agent/auth.json",
		"/home/test/.pi/agent/settings.json",
		"/home/test/.pi/agent/models.json",
		"/home/test/.pi/agent/approval-guardian.json",
		"/home/test/.pi/agent/llm-provider-api-key",
		"/home/test/.pi/agent/sessions/project/session.jsonl",
		"/home/test/.pi/agent/delegates/jobs/job.json",
		"/home/test/.pi/context-mode/content",
		"/home/test/.pi/context-mode/content/index.db",
		"/home/test/.pi/context-mode/sessions/session.db",
		"/home/test/.pi/memory",
		"/home/test/.pi/memory/memory.db",
		"/home/test/.pi/session-search/config.json",
		"/home/test/.pi/session-search/index",
		"/home/test/.pi/session-search/index/sessions-fts.db",
		"/home/test/.pi/knowledge-search-/kb-fts.db",
		"/home/test/.pi/pi-acp",
		"/home/test/.pi/pi-acp/session-map.json",
		join(
			homedir(),
			".pi/agent/npm/node_modules/example/private/credentials.json",
		),
		join(homedir(), ".pi/agent/npm/node_modules/example/.env"),
		join(
			homedir(),
			".pi/agent/npm/node_modules/example/credentials/account.json",
		),
		join(
			homedir(),
			".pi/agent/npm/node_modules/example/.aws/config",
		),
	]) {
		assert.equal(classifyReadPath(path, "/repo/project").private, true, path);
	}

	for (const path of [
		"/home/test/.pi/exa-usage.json",
		"/home/test/.pi/agent/npm/node_modules/@upstash/context7-pi/skills/context7-docs/SKILL.md",
		join(
			homedir(),
			".pi/agent/npm/node_modules/example/private/README.md",
		),
		"/home/test/.pi/agent/skills/custom/SKILL.md",
		"/home/test/.pi/agent/agents/reviewer.md",
		"/home/test/.pi/agent/extensions/example/index.ts",
		"/home/test/.pi/agent/npm/package.json",
		"/home/test/.pi/agent/git/github.com/public/repo/README.md",
		"/home/test/.pi/context-mode/insight-cache/src/main.ts",
	]) {
		assert.equal(classifyReadPath(path, "/repo/project").private, false, path);
	}
	assert.equal(
		classifyReadPath(
			"/repo/project/.pi/agent/npm/node_modules/pkg/.env",
			"/repo/project",
		).private,
		true,
	);
	assert.equal(
		classifyReadPath(
			"/repo/project/.pi/agent/npm/node_modules/pkg/README.md",
			"/repo/project",
		).private,
		false,
	);
});

test("applies configured path review levels", () => {
	const windowsInside = classifyReadPath(
		"C:\\repo\\project\\README.md",
		"C:\\repo\\project",
	);
	assert.equal(windowsInside.outsideProject, false);
	const windowsOutside = classifyReadPath(
		"C:\\repo\\other\\README.md",
		"C:\\repo\\project",
	);
	assert.equal(windowsOutside.outsideProject, true);
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
	assert.equal(
		classifyMutationPath(".pi/skills/reviewer/SKILL.md", "/repo/project")
			.sensitive,
		true,
	);
	assert.equal(
		classifyMutationPath(".pi/cache/index.json", "/repo/project").sensitive,
		false,
	);
});
