import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadGuardianConfig } from "../src/config.ts";
import { parseModelSpec } from "../src/review.ts";

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
			fallbackModel: "global/fallback",
			timeoutMs: 60_000,
			policy: "global policy",
			review: { "grep.path": "outside-or-private", "read.path": "off" },
		}),
	);
	writeFileSync(
		join(cwd, ".pi", "approval-guardian.json"),
		JSON.stringify({
			model: "project/reviewer",
			fallbackModel: "project/fallback",
			policy: "project policy",
			review: { "read.path": "private-only" },
		}),
	);

	const config = loadGuardianConfig({
		cwd,
		projectTrusted: true,
		agentDir,
		env: {
			PI_APPROVAL_GUARDIAN_MODEL: "env/reviewer",
			PI_APPROVAL_GUARDIAN_FALLBACK_MODEL: "openrouter/openai/gpt-5-mini",
		},
	});
	assert.equal(config.model, "env/reviewer");
	assert.equal(config.fallbackModel, "openrouter/openai/gpt-5-mini");
	assert.equal(config.fallbackModelSource, "environment");
	assert.equal(config.timeoutMs, 60_000);
	assert.equal(config.policy, "global policy\n\nproject policy");
	assert.equal(config.review["bash.command"], "always");
	assert.equal(config.review["read.path"], "private-only");
	assert.equal(config.review["grep.path"], "outside-or-private");
	assert.equal(config.globalConfigPresent, true);
	assert.equal(config.projectConfigPresent, true);
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

test("warns and falls back to defaults for invalid configured values", () => {
	const root = mkdtempSync(join(tmpdir(), "approval-guardian-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "approval-guardian.json"),
		JSON.stringify({
			policy: [],
			timeoutMs: 5,
			model: "",
			fallbackModel: "missing-slash",
		}),
	);
	const config = loadGuardianConfig({
		cwd: join(root, "project"),
		projectTrusted: false,
		agentDir,
		env: {},
	});
	assert.equal(config.warnings.length, 4);
	assert.match(config.warnings.join("\n"), /Invalid policy/);
	assert.match(config.warnings.join("\n"), /fallbackModel/);
	assert.equal(config.model, "openai-codex/codex-auto-review");
	assert.equal(config.modelSource, "default");
	assert.equal(config.fallbackModel, "openai-codex/codex-auto-review");
	assert.equal(config.fallbackModelSource, "default");
	assert.equal(config.timeoutMs, 90_000);
	assert.equal(config.timeoutSource, "default");
	assert.equal(config.policy, undefined);
});

test("accepts nested model IDs and reports config typos without rejecting custom path rules", () => {
	const root = mkdtempSync(join(tmpdir(), "approval-guardian-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "approval-guardian.json"),
		JSON.stringify({
			model: "openrouter/anthropic/claude-sonnet-4",
			unknownSetting: true,
			review: {
				"custom-reader.path": "always",
				"functions.reader.path": "outside-or-private",
				"custom-reader.target": "off",
			},
		}),
	);
	const config = loadGuardianConfig({
		cwd: join(root, "project"),
		projectTrusted: false,
		agentDir,
		env: {},
	});
	assert.equal(config.model, "openrouter/anthropic/claude-sonnet-4");
	assert.equal(config.modelSource, "global");
	assert.equal(config.review["custom-reader.path"], "always");
	assert.equal(config.review["functions.reader.path"], "outside-or-private");
	assert.match(config.warnings.join("\n"), /unknownSetting/);
	assert.match(config.warnings.join("\n"), /custom-reader.target/);
	assert.deepEqual(parseModelSpec("openrouter/anthropic/claude-sonnet-4"), {
		provider: "openrouter",
		model: "anthropic/claude-sonnet-4",
	});
});

test("warns and skips invalid environment overrides", () => {
	const root = mkdtempSync(join(tmpdir(), "approval-guardian-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "approval-guardian.json"),
		JSON.stringify({
			model: "global/reviewer",
			fallbackModel: "global/fallback",
			timeoutMs: 45_000,
		}),
	);
	const config = loadGuardianConfig({
		cwd: join(root, "project"),
		projectTrusted: false,
		agentDir,
		env: {
			PI_APPROVAL_GUARDIAN_MODEL: "missing-slash",
			PI_APPROVAL_GUARDIAN_FALLBACK_MODEL: "also-missing-slash",
			PI_APPROVAL_GUARDIAN_TIMEOUT_MS: "5",
		},
	});
	assert.equal(config.warnings.length, 3);
	assert.equal(config.model, "global/reviewer");
	assert.equal(config.modelSource, "global");
	assert.equal(config.fallbackModel, "global/fallback");
	assert.equal(config.fallbackModelSource, "global");
	assert.equal(config.timeoutMs, 45_000);
	assert.equal(config.timeoutSource, "global");
});

test("uses an environment model ID containing nested slashes", () => {
	const root = mkdtempSync(join(tmpdir(), "approval-guardian-"));
	const config = loadGuardianConfig({
		cwd: join(root, "project"),
		projectTrusted: false,
		agentDir: join(root, "agent"),
		env: { PI_APPROVAL_GUARDIAN_MODEL: "openrouter/anthropic/claude-sonnet-4" },
	});
	assert.equal(config.modelSource, "environment");
	assert.equal(config.warnings.length, 0);
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
	assert.equal(config.fallbackModel, "openai-codex/codex-auto-review");
	assert.equal(config.fallbackModelSource, "default");
	assert.equal(config.policy, undefined);
	assert.equal(config.review["read.path"], "private-only");
	assert.equal(config.review["grep.path"], "outside-or-private");
	assert.equal(config.review["find.path"], "private-only");
	assert.equal(config.review["ls.path"], "private-only");
	assert.equal(config.review["hypa_read.path"], undefined);
	assert.equal(config.review["write.path"], "outside-or-private");
	assert.equal(config.projectConfigPresent, true);
});
