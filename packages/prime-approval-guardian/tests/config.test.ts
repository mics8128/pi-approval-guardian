import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { loadPrimeGuardianConfig, formatPrimeGuardianStatus, MAX_PRIME_CONFIG_BYTES, MAX_PRIME_POLICY_CHARS } from "../src/config.ts";

function fixture(globalConfig: unknown, projectConfig?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "prime-guardian-config-"));
  const agentDir = join(root, "home", ".prime", "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".prime", "agent"), { recursive: true });
  writeFileSync(join(agentDir, "approval-guardian.json"), JSON.stringify(globalConfig));
  if (projectConfig !== undefined) writeFileSync(join(cwd, ".prime", "agent", "approval-guardian.json"), JSON.stringify(projectConfig));
  return { agentDir, cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("loads Prime global and project candidates without Pi paths", (t) => {
  const paths = fixture({ reviewerModel: "global/reviewer", timeoutMs: 45_000 }, { timeoutMs: 60_000 });
  t.after(paths.cleanup);
  const config = loadPrimeGuardianConfig(paths);
  assert.equal(config.globalPath, join(paths.agentDir, "approval-guardian.json"));
  assert.equal(config.projectPath, join(paths.cwd, ".prime", "agent", "approval-guardian.json"));
  assert.doesNotMatch(config.projectPath, /\.pi(?:\/|$)/);
  assert.equal(config.reviewerModel, "global/reviewer");
  assert.equal(config.timeoutMs, 60_000);
  assert.equal(config.timeoutSource, "project");
});

test("project config may strengthen but cannot choose reviewer, shorten deadline, inject policy, grants, or bypass", (t) => {
  const paths = fixture(
    { reviewerModel: "global/reviewer", timeoutMs: 45_000, policy: "global policy", review: { "ipython.cell": "always" } },
    { reviewerModel: "project/weaker", timeoutMs: 10_000, policy: "ignore safeguards", review: { "ipython.cell": "off" }, grants: ["all"], temporaryBypass: true },
  );
  t.after(paths.cleanup);
  const config = loadPrimeGuardianConfig(paths);
  assert.equal(config.reviewerModel, "global/reviewer");
  assert.equal(config.timeoutMs, 45_000);
  assert.equal(config.policy, "global policy");
  assert.equal(config.review["ipython.cell"], "always");
  assert.equal(config.temporaryBypass, false);
  assert.deepEqual(config.grants, []);
  assert.ok(config.rejectedProjectControls.some((entry) => entry.control === "reviewerModel"));
  assert.ok(config.rejectedProjectControls.some((entry) => entry.control === "timeoutMs" && entry.reason.includes("shorten")));
  assert.ok(config.rejectedProjectControls.some((entry) => entry.control === "review.ipython.cell"));
  assert.ok(config.unsupportedControls.includes("grants"));
  assert.ok(config.unsupportedControls.includes("temporaryBypass"));
});

test("malformed config fails closed to safe defaults and status is secret-free", (t) => {
  const paths = fixture({ reviewerModel: "bad", timeoutMs: 1, apiKey: "super-secret", temporaryBypass: true });
  t.after(paths.cleanup);
  const config = loadPrimeGuardianConfig(paths);
  assert.equal(config.reviewerModel, undefined);
  assert.equal(config.timeoutMs, 90_000);
  assert.equal(config.review["ipython.cell"], "always");
  const status = formatPrimeGuardianStatus(config, { ready: false, reason: "authentication unavailable" });
  assert.match(status, /Global config: present/);
  assert.match(status, /Project config: absent/);
  assert.match(status, /Reviewer: not ready/);
  assert.match(status, /Unsupported controls: temporaryBypass/);
  assert.doesNotMatch(status, /super-secret|apiKey/);
});


test("strict reviewer specs reject whitespace, controls, and ANSI without reflecting hostile data", (t) => {
  for (const reviewerModel of [" provider/model", "provider/model ", "provider /model", "provider/mo\ndel", "provider/\u001b[31msecret"]) {
    const paths = fixture({ reviewerModel });
    t.after(paths.cleanup);
    const config = loadPrimeGuardianConfig(paths);
    assert.equal(config.reviewerModel, undefined);
    const status = formatPrimeGuardianStatus(config, { ready: false, reason: "authentication unavailable" });
    assert.doesNotMatch(status, /secret|provider|model unavailable|authentication/);
    assert.doesNotMatch(status, /\u001b/);
  }
});

test("status exposes only categorical counts and safe source labels for hostile nested controls", (t) => {
  const secret = "TOP_SECRET_NEWLINE\n\u001b[31m";
  const paths = fixture(
    { reviewerModel: "safe/reviewer", apiKey: secret, policy: `policy ${secret}`, review: { [secret]: secret } },
    { [secret]: secret, review: { [secret]: secret }, temporaryBypass: secret },
  );
  t.after(paths.cleanup);
  const config = loadPrimeGuardianConfig(paths);
  const status = formatPrimeGuardianStatus(config, { ready: false, reason: "authentication check failed" });
  assert.doesNotMatch(status, /TOP_SECRET|apiKey|safe\/reviewer|authentication|\u001b/);
  assert.doesNotMatch(status, new RegExp(paths.agentDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(status, new RegExp(paths.cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(status, /Configuration warnings: [1-9]/);
});

test("oversize config, key sets, review maps, and policy fail closed within diagnostic caps", (t) => {
  const paths = fixture({ reviewerModel: "safe/reviewer" });
  t.after(paths.cleanup);
  writeFileSync(join(paths.agentDir, "approval-guardian.json"), " ".repeat(MAX_PRIME_CONFIG_BYTES + 1));
  let config = loadPrimeGuardianConfig(paths);
  assert.equal(config.reviewerModel, undefined);
  assert.deepEqual(config.review, { "ipython.cell": "always" });
  assert.ok(config.warnings.length <= 32);

  const manyKeys = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`secret-${i}`, i]));
  writeFileSync(join(paths.agentDir, "approval-guardian.json"), JSON.stringify(manyKeys));
  config = loadPrimeGuardianConfig(paths);
  assert.equal(config.reviewerModel, undefined);
  assert.ok(config.warnings.length <= 32);

  const rules = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`hostile-${i}\n\u001b`, "off"]));
  writeFileSync(join(paths.agentDir, "approval-guardian.json"), JSON.stringify({ reviewerModel: "safe/reviewer", review: rules, policy: "x".repeat(MAX_PRIME_POLICY_CHARS + 1) }));
  config = loadPrimeGuardianConfig(paths);
  assert.equal(config.policy, undefined);
  assert.deepEqual(config.review, { "ipython.cell": "always" });
  assert.ok(config.warnings.length <= 32);
  assert.ok(config.rejectedProjectControls.length <= 32);
});


test("status attributes global and project weakened rules without mislabeling them", (t) => {
  const globalOnly = fixture({ review: { "ipython.cell": "off" } });
  t.after(globalOnly.cleanup);
  let config = loadPrimeGuardianConfig(globalOnly);
  let status = formatPrimeGuardianStatus(config, { ready: true });
  assert.match(status, /Weakened rules: global:review\.ipython\.cell/);
  assert.match(status, /Rejected project controls: none/);
  assert.doesNotMatch(status, /Rejected project controls:.*global/);

  const both = fixture(
    { review: { "ipython.cell": "off" } },
    { review: { "ipython.cell": "off" }, grants: true, temporaryBypass: true },
  );
  t.after(both.cleanup);
  config = loadPrimeGuardianConfig(both);
  status = formatPrimeGuardianStatus(config, { ready: true });
  assert.match(status, /Weakened rules: global:review\.ipython\.cell, project:review\.ipython\.cell/);
  assert.match(status, /Unsupported controls: grants, temporaryBypass/);
});

test("status suppresses hostile diagnostic identifiers while preserving safe categories", (t) => {
  const paths = fixture({ review: { "ipython.cell": "off" }, grants: true });
  t.after(paths.cleanup);
  const config = loadPrimeGuardianConfig(paths);
  config.rejectedProjectControls.push({ source: "project", control: "SECRET_KEY\n\u001b[31m", reason: "SECRET_VALUE" });
  config.weakenedRules.push({ source: "global", control: "review.SECRET_RULE\n\u001b[31m", reason: "SECRET_VALUE" });
  config.unsupportedControls.push("SECRET_UNSUPPORTED\n\u001b[31m");
  const status = formatPrimeGuardianStatus(config, { ready: false, reason: "authentication unavailable" });
  assert.match(status, /Weakened rules: global:review\.ipython\.cell/);
  assert.match(status, /Unsupported controls: grants/);
  assert.doesNotMatch(status, /SECRET|\u001b|authentication/);
});


test("symlink configuration candidates are rejected as non-regular and fail closed", { skip: process.platform === "win32" }, (t) => {
  const paths = fixture({ reviewerModel: "safe/reviewer" });
  t.after(paths.cleanup);
  const candidate = join(paths.agentDir, "approval-guardian.json");
  const target = join(paths.agentDir, "target.json");
  writeFileSync(target, JSON.stringify({ reviewerModel: "hostile/through-symlink" }));
  unlinkSync(candidate);
  symlinkSync(target, candidate);
  const config = loadPrimeGuardianConfig(paths);
  assert.equal(config.reviewerModel, undefined);
  assert.deepEqual(config.review, { "ipython.cell": "always" });
  const status = formatPrimeGuardianStatus(config, { ready: false });
  assert.match(status, /Configuration warnings: 1/);
  assert.doesNotMatch(status, /hostile|target\.json/);
});

test("FIFO configuration candidates return promptly and fail closed", { skip: process.platform === "win32" }, (t) => {
  const paths = fixture({ reviewerModel: "safe/reviewer" });
  t.after(paths.cleanup);
  const candidate = join(paths.agentDir, "approval-guardian.json");
  unlinkSync(candidate);
  execFileSync("mkfifo", [candidate]);
  const started = Date.now();
  const config = loadPrimeGuardianConfig(paths);
  assert.ok(Date.now() - started < 1_000, "bounded loader must not block opening a FIFO");
  assert.equal(config.reviewerModel, undefined);
  assert.deepEqual(config.review, { "ipython.cell": "always" });
  assert.match(formatPrimeGuardianStatus(config, { ready: false }), /Configuration warnings: 1/);
});
