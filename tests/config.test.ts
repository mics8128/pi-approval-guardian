import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadGuardianConfig } from "../src/config.ts";

test("loads global and trusted project config with documented precedence", () => {
	const root = mkdtempSync(join(tmpdir(), "codex-guardian-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "codex-guardian.json"), JSON.stringify({
		model: "global/reviewer",
		timeoutMs: 60_000,
		policy: "global policy",
	}));
	writeFileSync(join(cwd, ".pi", "codex-guardian.json"), JSON.stringify({
		model: "project/reviewer",
		policy: "project policy",
	}));

	const config = loadGuardianConfig({
		cwd,
		projectTrusted: true,
		agentDir,
		env: { PI_CODEX_GUARDIAN_MODEL: "env/reviewer" },
	});
	assert.equal(config.model, "env/reviewer");
	assert.equal(config.timeoutMs, 60_000);
	assert.equal(config.policy, "global policy\n\nproject policy");
	assert.equal(config.projectConfigLoaded, true);
});

test("does not load project config for an untrusted project", () => {
	const root = mkdtempSync(join(tmpdir(), "codex-guardian-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(cwd, ".pi", "codex-guardian.json"), JSON.stringify({
		model: "project/reviewer",
		policy: "project policy",
	}));

	const config = loadGuardianConfig({ cwd, projectTrusted: false, agentDir, env: {} });
	assert.equal(config.model, "openai-codex/codex-auto-review");
	assert.equal(config.policy, undefined);
	assert.equal(config.projectConfigLoaded, false);
});
