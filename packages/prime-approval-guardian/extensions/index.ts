import type { Context } from "@earendil-works/pi-ai";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { pathToFileURL } from "node:url";
import {
	decideGuardianAction,
	normalizePrimeIpythonAction,
	guardianInputIdentity,
	type NormalizedGuardianAction,
	type NormalizedGuardianDecision,
	type GuardianReviewResult,
} from "../src/normalized-decision.ts";
import { runIsolatedPrimeReview, type PrimeModel, type PrimeReviewerStream } from "../src/reviewer.ts";
import { loadPrimeGuardianConfig, formatPrimeGuardianStatus, type PrimeGuardianConfig, type PrimeReviewerReadiness } from "../src/config.ts";
import { lockExactToolInput } from "../src/tool-input-lock.ts";

export type PrimeTracerReviewResult =
	| { outcome: "allow" }
	| { outcome: "deny" | "failure" | "timeout"; reason?: string };
export type PrimeTracerReview = (
	action: NormalizedGuardianAction,
	signal: AbortSignal,
) => Promise<PrimeTracerReviewResult> | PrimeTracerReviewResult;
export interface PrimeToolCallEvent { toolName: string; toolCallId: string; input: unknown }
export type PrimeToolCallResult = { block: true; reason: string } | undefined;
export interface PrimeModelRegistry {
	find?(provider: string, model: string): PrimeModel | undefined;
	getApiKeyAndHeaders(model: PrimeModel): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
}
export interface PrimeExtensionContext { cwd?: string; model?: PrimeModel; modelRegistry?: PrimeModelRegistry; signal?: AbortSignal }
export type PrimeToolCallHandler = (event: PrimeToolCallEvent, context: PrimeExtensionContext) => Promise<PrimeToolCallResult>;
export interface PrimeCommandContext extends PrimeExtensionContext { hasUI?: boolean; ui?: { notify(message: string, type?: "info" | "warning" | "error"): void } }
export interface PrimeExtensionApi {
	on(name: "tool_call", handler: PrimeToolCallHandler): void;
	on(name: "turn_start", handler: () => void): void;
	registerCommand?(name: string, command: { description: string; handler(args: string, context: PrimeCommandContext): Promise<void> | void }): void;
}
export interface PrimeApprovalGuardianTracerOptions {
	review?: PrimeTracerReview;
	reviewerModel?: string;
	timeoutMs?: number;
	streamModel?: PrimeReviewerStream;
	audit?: (decision: NormalizedGuardianDecision) => void;
	/** Test/embedded-host override. Normal Prime operation resolves this with Prime Agent getAgentDir(). */
	agentDir?: string;
}

const OUTCOMES = new Set(["allow", "deny", "failure", "timeout"]);

export function createPrimeApprovalGuardian(options: PrimeApprovalGuardianTracerOptions = {}) {
	return function primeApprovalGuardian(pi: PrimeExtensionApi): void {
		let adverseOutcomes = 0;
		pi.on("turn_start", () => { adverseOutcomes = 0; });
		pi.on("tool_call", async (event, context) => {
			if (event.toolName !== "ipython") return;
			const action = normalizePrimeIpythonAction(event.input, context.cwd ?? process.cwd());
			if (!action) return block("Prime Approval Guardian blocked malformed IPython input.");
			let config: PrimeGuardianConfig;
			try { config = await runtimeConfig(context.cwd ?? process.cwd(), options); }
			catch { return block("Prime Approval Guardian configuration was unavailable; IPython was blocked."); }
			const decision = await decideGuardianAction(action, {
				isCircuitOpen: () => adverseOutcomes >= 3,
				review: (candidate) => reviewBeforeDeadline(candidate, context, options, config),
				protectInput: (identity) => lockExactToolInput(event, identity, guardianInputIdentity),
				recordCircuitOutcome: (adverse) => { adverseOutcomes = adverse ? adverseOutcomes + 1 : 0; },
			});
			options.audit?.(decision);
			if (decision.verdict === "allow") return;
			return block(reasonFor(decision.result));
		});
		pi.registerCommand?.("approval-guardian", {
			description: "Show Prime Approval Guardian readiness and configuration sources",
			handler: async (args, context) => {
				if (args.trim().toLowerCase() === "bypass") context.ui?.notify("Temporary bypass request rejected; whole-cell review remains active.", "warning");
				let status: string;
				try {
					const config = await runtimeConfig(context.cwd ?? process.cwd(), options);
					status = formatPrimeGuardianStatus(config, await reviewerReadiness(config, context));
				} catch { status = "Prime Approval Guardian · fail-closed\nTemporary bypass: unavailable\nConfiguration: unavailable"; }
				context.ui?.notify(status, "warning");
			},
		});
	};
}

async function reviewBeforeDeadline(
	action: NormalizedGuardianAction,
	context: PrimeExtensionContext,
	options: PrimeApprovalGuardianTracerOptions,
	config: PrimeGuardianConfig,
): Promise<GuardianReviewResult> {
	const controller = new AbortController();
	const signal = context.signal
		? AbortSignal.any([context.signal, controller.signal])
		: controller.signal;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let removeAbortListener: () => void = () => undefined;
	try {
		const review = options.review
			? Promise.resolve()
					.then(() => options.review!(action, signal))
					.then(normalizeInjectedReview)
			: realReview(action, context, options, config, signal);
		const outcomes: Array<Promise<GuardianReviewResult>> = [
			review,
			new Promise((resolve) => {
				timer = setTimeout(() => {
					controller.abort();
					resolve({
						kind: "timeout",
						message:
							"Prime Approval Guardian review timeout; IPython was blocked.",
					});
				}, options.timeoutMs ?? config.timeoutMs);
			}),
		];
		if (context.signal) {
			const externalAbort = new Promise<GuardianReviewResult>((resolve) => {
				const abort = () =>
					resolve({
						kind: "failure",
						message:
							"Prime Approval Guardian review was cancelled; IPython was blocked.",
					});
				if (context.signal!.aborted) {
					abort();
					return;
				}
				context.signal!.addEventListener("abort", abort, { once: true });
				removeAbortListener = () =>
					context.signal!.removeEventListener("abort", abort);
			});
			outcomes.push(externalAbort);
		}
		return await Promise.race(outcomes);
	} catch (error) {
		const invalid =
			error instanceof Error && error.message === "invalid review result";
		return {
			kind: "failure",
			message: invalid
				? "Prime Approval Guardian received an invalid review result; IPython was blocked."
				: "Prime Approval Guardian review failed; IPython was blocked.",
		};
	} finally {
		if (timer) clearTimeout(timer);
		removeAbortListener();
		controller.abort();
	}
}
async function realReview(action: NormalizedGuardianAction, context: PrimeExtensionContext, options: PrimeApprovalGuardianTracerOptions, config: PrimeGuardianConfig, signal: AbortSignal): Promise<GuardianReviewResult> {
	if (!context.modelRegistry) throw new Error("Reviewer model registry is unavailable.");
	const configured = options.reviewerModel ?? config.reviewerModel;
	let model: PrimeModel | undefined;
	if (configured) {
		const slash = configured.indexOf("/");
		if (slash <= 0 || slash === configured.length - 1) throw new Error("Configured reviewer model must be provider/model.");
		model = context.modelRegistry.find?.(configured.slice(0, slash), configured.slice(slash + 1));
		if (!model) throw new Error(`Registered reviewer model not found: ${configured}.`);
	} else {
		model = context.model;
		if (!model) throw new Error("No explicit current-model fallback is available.");
	}
	const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(`Reviewer authentication is unavailable: ${auth.error ?? "unknown authentication failure"}`);
	return runIsolatedPrimeReview(
		action,
		model,
		{
			ok: true,
			...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
			...(auth.headers === undefined ? {} : { headers: auth.headers }),
		},
		signal,
		options.streamModel,
		config.policy,
	);
}

async function runtimeConfig(cwd: string, options: PrimeApprovalGuardianTracerOptions): Promise<PrimeGuardianConfig> {
	const agentDir = options.agentDir ?? await primeAgentDir();
	return loadPrimeGuardianConfig({ cwd, agentDir });
}
async function primeAgentDir(): Promise<string> {
	// Prime Agent is host-provided. First use normal package resolution (SDK/package installs),
	// then locate the running Prime CLI package without consulting Pi paths or variables.
	let prime: { getAgentDir?: () => string } | undefined;
	try {
		// @ts-expect-error prime-agent is supplied by the compatible Prime host, not the private alpha registry.
		prime = await import("prime-agent");
	} catch {
		const entry = process.argv[1];
		if (!entry) throw new Error("Prime host entry is unavailable");
		let directory = dirname(realpathSync(entry));
		const root = parse(directory).root;
		while (directory !== root) {
			try {
				const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { name?: unknown };
				if (manifest.name === "prime-agent") {
					prime = await import(pathToFileURL(join(directory, "dist", "index.js")).href);
					break;
				}
			} catch { /* keep walking to the host package root */ }
			directory = dirname(directory);
		}
	}
	if (typeof prime?.getAgentDir !== "function") throw new Error("Prime getAgentDir is unavailable");
	return prime.getAgentDir();
}
async function reviewerReadiness(config: PrimeGuardianConfig, context: PrimeExtensionContext): Promise<PrimeReviewerReadiness> {
	const registry = context.modelRegistry;
	if (!registry) return { ready: false, reason: "model unavailable" };
	let model = context.model;
	if (config.reviewerModel) {
		const slash = config.reviewerModel.indexOf("/");
		model = registry.find?.(config.reviewerModel.slice(0, slash), config.reviewerModel.slice(slash + 1));
	}
	if (!model) return { ready: false, reason: "model unavailable" };
	try {
		const auth = await registry.getApiKeyAndHeaders(model);
		return auth.ok ? { ready: true } : { ready: false, reason: "authentication unavailable" };
	} catch { return { ready: false, reason: "authentication check failed" }; }
}

function normalizeInjectedReview(value: unknown): GuardianReviewResult {
	if (typeof value !== "object" || value === null) throw new Error("invalid review result");
	const outcome = Reflect.get(value, "outcome"); const reason = Reflect.get(value, "reason");
	if (typeof outcome !== "string" || !OUTCOMES.has(outcome) || (reason !== undefined && typeof reason !== "string")) throw new Error("invalid review result");
	if (outcome === "allow") return { kind: "allowed", assessment: { risk_level: "low", user_authorization: "unknown", outcome: "allow", rationale: "Deterministic test reviewer allowed the action." } };
	if (outcome === "deny") return { kind: "denied", assessment: { risk_level: "high", user_authorization: "unknown", outcome: "deny", rationale: reason ?? "The reviewer denied the cell." } };
	return { kind: outcome, message: reason ?? `Prime Approval Guardian ${outcome}.` } as GuardianReviewResult;
}
function reasonFor(result: GuardianReviewResult): string {
	if (result.kind === "denied") return result.assessment.rationale;
	if (result.kind === "allowed") return "Prime Approval Guardian blocked an inconsistent allow decision.";
	return result.message;
}
function block(reason: string): { block: true; reason: string } { return { block: true, reason }; }

export { decideGuardianAction, normalizePrimeIpythonAction, guardianInputIdentity } from "../src/normalized-decision.ts";
export type { NormalizedGuardianAction, NormalizedGuardianDecision, GuardianReviewResult } from "../src/normalized-decision.ts";
export default createPrimeApprovalGuardian();
