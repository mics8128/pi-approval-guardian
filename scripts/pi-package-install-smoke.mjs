import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, lstatSync, readdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectory = join(repository, "packages", "pi-approval-guardian");
const temporary = mkdtempSync(join(tmpdir(), "pi-guardian-install-"));
const artifactDirectory = join(temporary, "artifact");
const agentDirectory = join(temporary, "agent");
const projectDirectory = join(temporary, "project");
mkdirSync(artifactDirectory);
mkdirSync(projectDirectory);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDirectory,
      PI_SKIP_VERSION_CHECK: "1",
    },
    ...options,
  });
}

function assertNoSymlinks(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    assert(!lstatSync(path).isSymbolicLink(), `installed artifact must not contain symlink ${path}`);
    if (entry.isDirectory()) assertNoSymlinks(path);
  }
}

try {
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", artifactDirectory], { cwd: packageDirectory }));
  const record = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
  assert(record?.filename, "npm pack must produce a tarball");
  const tarball = join(artifactDirectory, record.filename);
  const source = `npm:pi-approval-guardian@file:${tarball}`;

  run("pi", ["install", source], { cwd: projectDirectory });
  const installed = join(agentDirectory, "npm", "node_modules", "pi-approval-guardian");
  const installedRealpath = realpathSync(installed);
  const checkoutRelative = relative(realpathSync(repository), installedRealpath);
  const installedInsideCheckout = checkoutRelative === "" || (!isAbsolute(checkoutRelative) && checkoutRelative !== ".." && !checkoutRelative.startsWith(`..${sep}`));
  assert.equal(installedInsideCheckout, false, "installed artifact must be outside the checkout");
  assert.equal(lstatSync(installed).isSymbolicLink(), false, "installed package root must not be a symlink");
  assertNoSymlinks(installed);
  assert.equal(
    readFileSync(join(installed, "extensions", "index.ts"), "utf8"),
    readFileSync(join(packageDirectory, "extensions", "index.ts"), "utf8"),
  );
  assert.match(run("pi", ["list"], { cwd: projectDirectory }), /pi-approval-guardian/);
  assert.deepEqual(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).pi, {
    extensions: ["./extensions/index.ts"],
  });

  run("npm", [
    "install",
    "--prefix",
    join(agentDirectory, "npm"),
    "--ignore-scripts",
    "--no-save",
    "@earendil-works/pi-ai@0.80.7",
    "@earendil-works/pi-coding-agent@0.80.7",
  ]);
  const runtimeCopy = join(agentDirectory, "npm", "artifact-runtime-copy");
  cpSync(installed, runtimeCopy, { recursive: true });
  const installedBehaviorTest = join(temporary, "artifact-extension.test.ts");
  const installedBaseUrl = pathToFileURL(runtimeCopy).href;
  const behaviorSource = readFileSync(join(packageDirectory, "tests", "extension.test.ts"), "utf8")
    .replaceAll('from "../extensions/', `from "${installedBaseUrl}/extensions/`)
    .replaceAll('from "../src/', `from "${installedBaseUrl}/src/`);
  writeFileSync(installedBehaviorTest, behaviorSource);
  const behaviorOutput = run(process.execPath, ["--test", installedBehaviorTest], { cwd: installed });
  for (const behavior of [
    "locks approved tool arguments",
    "fails closed on contradictory high and critical allow decisions",
    "reports lifecycle health",
    "temporarily bypasses reviews",
  ]) {
    assert.match(behaviorOutput, new RegExp(behavior), `installed artifact did not exercise ${behavior}`);
  }
  console.log(`Pi installed ${record.filename} and passed installed allow/block/status/bypass behavior`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
