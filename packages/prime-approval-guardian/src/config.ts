import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

export const PRIME_CONFIG_FILE = "approval-guardian.json";
export const DEFAULT_PRIME_TIMEOUT_MS = 90_000;
export const MAX_PRIME_CONFIG_BYTES = 64 * 1024;
export const MAX_PRIME_POLICY_CHARS = 16 * 1024;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_CONFIG_KEYS = 128;
const MAX_REVIEW_RULES = 128;
const MAX_DIAGNOSTICS = 32;

export interface RejectedPrimeControl { source: "global" | "project"; control: string; reason: string }
export interface PrimeGuardianConfig {
  reviewerModel?: string;
  reviewerSource: "global" | "default";
  timeoutMs: number;
  timeoutSource: "global" | "project" | "default";
  policy?: string;
  policySource: "global" | "default";
  review: Record<"ipython.cell", "always">;
  temporaryBypass: false;
  grants: [];
  globalPath: string;
  projectPath: string;
  globalConfigPresent: boolean;
  projectConfigPresent: boolean;
  rejectedProjectControls: RejectedPrimeControl[];
  weakenedRules: RejectedPrimeControl[];
  unsupportedControls: string[];
  warnings: string[];
}
export interface LoadPrimeGuardianConfigOptions { cwd: string; agentDir: string }
interface RawConfig { reviewerModel?: unknown; model?: unknown; timeoutMs?: unknown; policy?: unknown; review?: unknown; grants?: unknown; temporaryBypass?: unknown; bypass?: unknown; [key: string]: unknown }
const KNOWN = new Set(["reviewerModel", "model", "timeoutMs", "policy", "review", "grants", "temporaryBypass", "bypass"]);

export function loadPrimeGuardianConfig(options: LoadPrimeGuardianConfigOptions): PrimeGuardianConfig {
  const globalPath = join(options.agentDir, PRIME_CONFIG_FILE);
  const projectPath = join(options.cwd, ".prime", "agent", PRIME_CONFIG_FILE);
  const warnings: string[] = [];
  const globalConfig = readConfig(globalPath, "global", warnings);
  const projectConfig = readConfig(projectPath, "project", warnings);
  const rejected: RejectedPrimeControl[] = [];
  const weakened: RejectedPrimeControl[] = [];
  const unsupported = new Set<string>();

  const reviewerValue = globalConfig.reviewerModel ?? globalConfig.model;
  const reviewerModel = isModelSpec(reviewerValue) ? reviewerValue : undefined;
  if (reviewerValue !== undefined && !reviewerModel) addWarning(warnings, "Invalid global reviewer selection.");
  rejectProjectSelection(projectConfig, "reviewerModel", rejected);
  rejectProjectSelection(projectConfig, "model", rejected);

  let timeoutMs = validTimeout(globalConfig.timeoutMs) ?? DEFAULT_PRIME_TIMEOUT_MS;
  let timeoutSource: PrimeGuardianConfig["timeoutSource"] = validTimeout(globalConfig.timeoutMs) === undefined ? "default" : "global";
  if (globalConfig.timeoutMs !== undefined && validTimeout(globalConfig.timeoutMs) === undefined) addWarning(warnings, "Invalid global deadline.");
  if (projectConfig.timeoutMs !== undefined) {
    const projectTimeout = validTimeout(projectConfig.timeoutMs);
    if (projectTimeout === undefined) addRejected(rejected, { source: "project", control: "timeoutMs", reason: "invalid safety deadline" });
    else if (projectTimeout < timeoutMs) addRejected(rejected, { source: "project", control: "timeoutMs", reason: "project cannot shorten the global safety deadline" });
    else { timeoutMs = projectTimeout; timeoutSource = "project"; }
  }

  const globalPolicy = globalConfig.policy;
  const policy = typeof globalPolicy === "string" && globalPolicy.trim() && globalPolicy.length <= MAX_PRIME_POLICY_CHARS ? globalPolicy.trim() : undefined;
  if (globalPolicy !== undefined && !policy) addWarning(warnings, "Invalid or oversized global policy.");
  if (projectConfig.policy !== undefined) addRejected(rejected, { source: "project", control: "policy", reason: "project cannot inject reviewer policy" });

  checkReview(globalConfig.review, "global", warnings, weakened);
  checkReview(projectConfig.review, "project", warnings, weakened);
  for (const entry of weakened) if (entry.source === "project") addRejected(rejected, entry);
  for (const [source, config] of [["global", globalConfig], ["project", projectConfig]] as const) {
    if (config.grants !== undefined) { unsupported.add("grants"); if (source === "project") addRejected(rejected, { source, control: "grants", reason: "project grants are forbidden" }); }
    if (config.temporaryBypass !== undefined || config.bypass !== undefined) {
      unsupported.add("temporaryBypass");
      if (source === "project") addRejected(rejected, { source, control: "temporaryBypass", reason: "Prime temporary bypass is unavailable" });
    }
  }
  return {
    reviewerModel, reviewerSource: reviewerModel ? "global" : "default",
    timeoutMs, timeoutSource, policy, policySource: policy ? "global" : "default",
    review: { "ipython.cell": "always" }, temporaryBypass: false, grants: [],
    globalPath, projectPath, globalConfigPresent: existsSync(globalPath), projectConfigPresent: existsSync(projectPath),
    rejectedProjectControls: rejected.slice(0, MAX_DIAGNOSTICS), weakenedRules: weakened.slice(0, MAX_DIAGNOSTICS), unsupportedControls: [...unsupported].sort().slice(0, MAX_DIAGNOSTICS), warnings: warnings.slice(0, MAX_DIAGNOSTICS),
  };
}

function readConfig(path: string, source: "global" | "project", warnings: string[]): RawConfig {
  let fd: number | undefined;
  try {
    if (lstatSync(path).isSymbolicLink()) { addWarning(warnings, `Non-regular ${source} configuration ignored.`); return {}; }
    const noFollow = (constants as Record<string, number>).O_NOFOLLOW ?? 0;
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
    const initial = fstatSync(fd);
    if (!initial.isFile()) { addWarning(warnings, `Non-regular ${source} configuration ignored.`); return {}; }
    const size = initial.size;
    if (size > MAX_PRIME_CONFIG_BYTES) { addWarning(warnings, `Oversized ${source} configuration ignored.`); return {}; }
    const buffer = Buffer.alloc(Math.min(MAX_PRIME_CONFIG_BYTES + 1, Math.max(1, size + 1)));
    let total = 0;
    while (total < buffer.length) {
      const count = readSync(fd, buffer, total, buffer.length - total, null);
      if (count === 0) break;
      total += count;
    }
    const final = fstatSync(fd);
    if (final.size !== initial.size || final.mtimeMs !== initial.mtimeMs) { addWarning(warnings, `Changed ${source} configuration ignored.`); return {}; }
    if (total > MAX_PRIME_CONFIG_BYTES) { addWarning(warnings, `Oversized ${source} configuration ignored.`); return {}; }
    const parsed: unknown = JSON.parse(buffer.subarray(0, total).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { addWarning(warnings, `Invalid ${source} configuration ignored.`); return {}; }
    const config = parsed as RawConfig;
    const keys = Object.keys(config);
    if (keys.length > MAX_CONFIG_KEYS) { addWarning(warnings, `Oversized ${source} configuration ignored.`); return {}; }
    if (keys.some((key) => !KNOWN.has(key))) addWarning(warnings, `Unknown ${source} controls ignored.`);
    return config;
  } catch { if (existsSync(path)) addWarning(warnings, `Invalid or unreadable ${source} configuration ignored.`); return {}; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function addWarning(warnings: string[], warning: string) { if (warnings.length < MAX_DIAGNOSTICS) warnings.push(warning); }
function addRejected(rejected: RejectedPrimeControl[], value: RejectedPrimeControl) { if (rejected.length < MAX_DIAGNOSTICS) rejected.push(value); }
function rejectProjectSelection(config: RawConfig, key: "reviewerModel" | "model", rejected: RejectedPrimeControl[]) {
  if (config[key] !== undefined) addRejected(rejected, { source: "project", control: key, reason: "project cannot select or weaken the reviewer" });
}
function isModelSpec(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
function validTimeout(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_TIMEOUT_MS && value <= MAX_TIMEOUT_MS ? value : undefined;
}
function checkReview(value: unknown, source: "global" | "project", warnings: string[], weakened: RejectedPrimeControl[]) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) { addWarning(warnings, `Invalid ${source} review controls ignored.`); return; }
  const entries = Object.entries(value);
  if (entries.length > MAX_REVIEW_RULES) { addWarning(warnings, `Oversized ${source} review controls ignored.`); return; }
  let unsupported = false;
  for (const [rule, level] of entries) {
    if (rule !== "ipython.cell") { unsupported = true; continue; }
    if (level !== "always") addRejected(weakened, { source, control: "review.ipython.cell", reason: "whole-cell review cannot be weakened or disabled" });
  }
  if (unsupported) addWarning(warnings, `Unsupported ${source} review controls ignored.`);
}

export interface PrimeReviewerReadiness { ready: boolean; reason?: "model unavailable" | "authentication unavailable" | "authentication check failed" }
const STATUS_REJECTED_PROJECT_CONTROLS = new Set(["reviewerModel", "model", "timeoutMs", "policy", "grants", "temporaryBypass", "bypass"]);
const STATUS_UNSUPPORTED_CONTROLS = new Set(["grants", "temporaryBypass"]);
export function formatPrimeGuardianStatus(config: PrimeGuardianConfig, readiness: PrimeReviewerReadiness): string {
  const rejectedProjectControls = [...new Set(config.rejectedProjectControls
    .filter((item) => item.source === "project" && STATUS_REJECTED_PROJECT_CONTROLS.has(item.control))
    .map((item) => item.control === "bypass" ? "temporaryBypass" : item.control))].sort();
  const weakenedRules = [...new Set(config.weakenedRules
    .filter((item) => (item.source === "global" || item.source === "project") && item.control === "review.ipython.cell")
    .map((item) => `${item.source}:review.ipython.cell`))].sort();
  const unsupportedControls = [...new Set(config.unsupportedControls
    .filter((control) => STATUS_UNSUPPORTED_CONTROLS.has(control)))].sort();
  return [
    "Prime Approval Guardian · fail-closed whole-cell preflight",
    "Temporary bypass: unavailable in interactive, print, RPC, and daemon operation",
    `Global config: ${config.globalConfigPresent ? "present" : "absent"} · Prime agent configuration`,
    `Project config: ${config.projectConfigPresent ? "present (strengthening only)" : "absent"} · project Prime configuration`,
    `Reviewer: ${readiness.ready ? "ready" : "not ready"} · selection source: ${config.reviewerSource}`,
    `Deadline: ${config.timeoutMs}ms (${config.timeoutSource})`,
    `Policy: ${config.policy ? "customized from global config" : "isolated default"}`,
    "Review floor: ipython.cell → always",
    `Rejected project controls: ${rejectedProjectControls.length ? rejectedProjectControls.join(", ") : "none"}`,
    `Weakened rules: ${weakenedRules.length ? weakenedRules.join(", ") : "none"}`,
    `Unsupported controls: ${unsupportedControls.length ? unsupportedControls.join(", ") : "none"}`,
    `Configuration warnings: ${config.warnings.length}`,
  ].join("\n");
}
