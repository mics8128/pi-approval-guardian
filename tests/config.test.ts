import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadGuardianConfig } from "../src/config.ts";

test("loads global and trusted project config with documented precedence", () => {
	const root = mkdtempSync(join(tmpdir(), "approval-guardian-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "approval-guardian.json"),
		JSON.stringify({
			model: "global/reviewer",
			timeoutMs: 60_000,
			policy: "global policy",
			review: { "grep.path": "outside-or-private", "read.path": "off" },
		}),
	);
	writeFileSync(
		join(cwd, ".pi", "approval-guardian.json"),
		JSON.stringify({
			model: "project/reviewer",
			policy: "project policy",
			review: { "read.path": "private-only" },
		}),
	);

	const config = loadGuardianConfig({
		cwd,
		projectTrusted: true,
		agentDir,
		env: { PI_APPROVAL_GUARDIAN_MODEL: "env/reviewer" },
	});
	assert.equal(config.model, "env/reviewer");
	assert.equal(config.timeoutMs, 60_000);
	assert.equal(config.policy, "global policy\n\nproject policy");
	assert.equal(config.review["bash.command"], "always");
	assert.equal(config.review["read.path"], "private-only");
	assert.equal(config.review["grep.path"], "outside-or-private");
	assert.equal(config.projectConfigLoaded, true);
});

test("trusted project review rules cannot weaken the global floor", () => {
	const root = mkdtempSync(join(tmpdir(), "approval-guardian-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "approval-guardian.json"),
		JSON.stringify({ review: { "bash.command": "always", "read.path": "always" } }),
	);
	writeFileSync(
		join(cwd, ".pi", "approval-guardian.json"),
		JSON.stringify({ review: { "bash.command": "off", "read.path": "off" } }),
	);
	const config = loadGuardianConfig({
		cwd,
		projectTrusted: true,
		agentDir,
		env: {},
	});
	assert.equal(config.review["bash.command"], "always");
	assert.equal(config.review["read.path"], "always");
});

test("reports invalid configured policy instead of silently dropping it", () => {
	const root = mkdtempSync(join(tmpdir(), "approval-guardian-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "approval-guardian.json"),
		JSON.stringify({ policy: [], timeoutMs: 5, model: "" }),
	);
	const config = loadGuardianConfig({
		cwd: join(root, "project"),
		projectTrusted: false,
		agentDir,
		env: {},
	});
	assert.equal(config.warnings.length, 3);
	assert.match(config.warnings.join("\n"), /Invalid policy/);
});

test("reports invalid environment overrides", () => {
	const root = mkdtempSync(join(tmpdir(), "approval-guardian-"));
	const config = loadGuardianConfig({
		cwd: join(root, "project"),
		projectTrusted: false,
		agentDir: join(root, "agent"),
		env: {
			PI_APPROVAL_GUARDIAN_MODEL: "missing-slash",
			PI_APPROVAL_GUARDIAN_TIMEOUT_MS: "5",
		},
	});
	assert.equal(config.warnings.length, 2);
});

test("does not load project config for an untrusted project", () => {
	const root = mkdtempSync(join(tmpdir(), "approval-guardian-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "approval-guardian.json"),
		JSON.stringify({
			model: "project/reviewer",
			policy: "project policy",
		}),
	);

	const config = loadGuardianConfig({
		cwd,
		projectTrusted: false,
		agentDir,
		env: {},
	});
	assert.equal(config.model, "openai-codex/codex-auto-review");
	assert.equal(config.policy, undefined);
	assert.equal(config.review["read.path"], "private-only");
	assert.equal(config.review["grep.path"], "always");
	assert.equal(config.review["find.path"], "private-only");
	assert.equal(config.review["ls.path"], "private-only");
	assert.equal(config.review["hypa_read.path"], undefined);
	assert.equal(config.review["write.path"], "outside-or-private");
	assert.equal(config.projectConfigLoaded, false);
});
