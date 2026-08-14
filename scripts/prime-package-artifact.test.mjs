import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { resolve } from "node:path";

const packageDirectory = resolve("packages/prime-approval-guardian");

test("the Prime artifact contains exactly its publication allowlist", () => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: packageDirectory, encoding: "utf8" });
  const parsed = JSON.parse(output);
  const manifest = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  assert.deepEqual(manifest.files.map(({ path }) => path).sort(), [
    "LICENSE",
    "LICENSES/Apache-2.0.txt",
    "NOTICE",
    "README.md",
    "extensions/index.ts",
    "package.json",
    "src/capability-analysis.ts",
    "src/config.ts",
    "src/normalized-decision.ts",
    "src/reviewer.ts",
    "src/shared-decision.ts",
    "src/tool-input-lock.ts",
  ]);
});
