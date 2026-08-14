import { spawnSync } from "node:child_process";

const probe = spawnSync("prime-agent", ["-v"], { encoding: "utf8", shell: process.platform === "win32" });
if (probe.error && probe.error.code === "ENOENT") {
  console.log("Prime Agent binary unavailable; native smoke skipped (unit and artifact checks still enforced).");
  process.exit(0);
}
if (probe.status !== 0) {
  console.error(probe.stderr || probe.error || "Prime Agent probe failed");
  process.exit(probe.status ?? 1);
}
const smoke = spawnSync(process.execPath, ["scripts/prime-tracer-native-smoke.mjs"], { stdio: "inherit" });
process.exit(smoke.status ?? 1);
