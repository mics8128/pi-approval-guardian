// pi-lens-ignore: find-import-file-without-extension
import { homedir } from "node:os";
import {
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
	loadGuardianConfig,
	type ReviewLevel,
} from "../src/config.ts";
import {
	DenialCircuitBreaker,
	ReviewBatchTracker,
	classifyMutationPath,
	classifyReadPath,
	directoryMayContainPrivatePath,
	shouldReviewPath,
	type GuardianReviewResult,
} from "../src/gate.ts";
import { buildGuardianSystemPrompt } from "../src/policy.ts";
import {
	parseModelSpec,
	type GuardianAction,
	type GuardianAssessment,
	type GuardianMessage,
} from "../src/review.ts";
import {
	ReviewerSessionController,
	resolveReviewerModel,
} from "../src/reviewer-session.ts";

// Extension wiring intentionally coordinates lifecycle, UI, policy, and reviewer state.
// pi-lens-ignore: high-complexity, high-fan-out
export default function approvalGuardian(pi: ExtensionAPI) {
	let activeReviews = 0;
	let controller: ReviewerSessionController | undefined;
	let controllerKey: string | undefined;
	const circuitBreaker = new DenialCircuitBreaker();
	const reviewBatches = new ReviewBatchTracker();

	const resetRuntime = () => {
		controller?.dispose();
		controller = undefined;
		controllerKey = undefined;
		circuitBreaker.reset();
		reviewBatches.reset();
	};

	const finishReviewBatch = (batchId: string, ctx: ExtensionContext) => {
		const denied = reviewBatches.finish(batchId);
		if (denied !== undefined && circuitBreaker.record(denied)) ctx.abort();
	};

	pi.on("session_start", () => resetRuntime());
	pi.on("session_shutdown", (_event, ctx) => {
		resetRuntime();
		activeReviews = 0;
		ctx.ui.setStatus("approval-guardian", undefined);
	});
	pi.on("before_agent_start", () => {
		circuitBreaker.reset();
		reviewBatches.reset();
	});

	const showConfiguration = (
		args: string,
		ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1],
	): Promise<void> => {
		const config = loadGuardianConfig({
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
		});
		const parsed = parseModelSpec(config.model);
		const model = parsed
			? resolveReviewerModel(ctx.modelRegistry, parsed.provider, parsed.model)
			: undefined;
		const ready = Boolean(model) && config.warnings.length === 0;
		const details =
			args.trim() === "rules"
				? [
						"Review rules (tool.parameter → reviewer scope):",
						...Object.entries(config.review)
							.sort(([left], [right]) => left.localeCompare(right))
							.map(([key, level]) => `${key} → ${level}`),
						"Unconfigured tools with a string path parameter default to private-only.",
						"All review prompts go to the isolated AI reviewer; no user confirmation dialog is used.",
					]
				: [
						"Reviews configured shell, private-read/search, and sensitive/out-of-project mutation actions before execution.",
						"Run /approval-guardian rules for the tool/parameter review matrix.",
					];
		ctx.ui.notify(
			[
				`Approval Guardian · ${ready ? "ready" : "needs attention"} · fail-closed`,
				`${config.model} · ${formatDuration(config.timeoutMs)} deadline · up to 3 attempts · policy ${config.policy ? "customized" : "default"}`,
				...details,
				...config.warnings,
			].join("\n"),
			ready ? "info" : "warning",
		);
		return Promise.resolve();
	};

	pi.registerCommand("approval-guardian", {
		description: "Show Guardian status or the tool/parameter review rules",
		getArgumentCompletions: (prefix) =>
			"rules".startsWith(prefix)
				? [
						{
							value: "rules",
							label: "rules",
							description: "Show review levels",
						},
					]
				: null,
		handler: showConfiguration,
	});

	pi.on("tool_call", async (event, ctx) => {
		const batch = toolCallBatchInfo(
			event.toolCallId,
			ctx.sessionManager.getBranch(),
		);
		try {
			const config = loadGuardianConfig({
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
			});
			if (config.warnings.length > 0) {
				return {
					block: true,
					reason: [
						"Approval Guardian configuration is invalid, so tool execution failed closed.",
						...config.warnings,
					].join("\n"),
				};
			}
			const action = actionFromToolCall(event, ctx.cwd, config.review);
			if (!action) return;

			if (circuitBreaker.isOpen()) {
				const result: GuardianReviewResult = {
					kind: "circuit-open",
					message: "Repeated Guardian denials reached the per-turn limit.",
				};
				ctx.ui.notify(formatReviewResult(result, action), "error");
				return { block: true, reason: rejectionReason(result) };
			}

			const reviewed = await reviewAction(action, ctx);
			const result = enforceActionRequirements(action, reviewed);
			reviewBatches.record(batch.id, result.kind === "denied");
			if (result.kind === "allowed") {
				ctx.ui.notify(formatReviewResult(result, action), "info");
				return;
			}

			if (result.kind === "denied") {
				ctx.ui.notify(formatReviewResult(result, action), "error");
			} else {
				ctx.ui.notify(
					formatReviewResult(result, action),
					result.kind === "cancelled" ? "warning" : "error",
				);
			}
			return { block: true, reason: rejectionReason(result) };
		} finally {
			if (batch.isLast) finishReviewBatch(batch.id, ctx);
		}
	});

	pi.on("tool_execution_end", (event, ctx) => {
		const batch = toolCallBatchInfo(
			event.toolCallId,
			ctx.sessionManager.getBranch(),
		);
		if (batch.isLast) finishReviewBatch(batch.id, ctx);
	});

	async function reviewAction(
		action: GuardianAction,
		ctx: ExtensionContext,
	): Promise<GuardianReviewResult> {
		activeReviews++;
		ctx.ui.setStatus("approval-guardian", reviewStatus(activeReviews));
		try {
			const config = loadGuardianConfig({
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
			});
			const spec = parseModelSpec(config.model);
			if (!spec) {
				return {
					kind: "failure",
					message: `Invalid reviewer model ${config.model}; expected provider/model.`,
				};
			}
			const model = resolveReviewerModel(
				ctx.modelRegistry,
				spec.provider,
				spec.model,
			);
			if (!model) {
				return {
					kind: "failure",
					message: `Reviewer model not found: ${spec.provider}/${spec.model}.`,
				};
			}
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				return {
					kind: "failure",
					message: `Reviewer authentication is unavailable for ${model.provider}.`,
				};
			}

			const privateDataReview = action.payload.private_data_read === true;
			const baseSystemPrompt = buildGuardianSystemPrompt(config.policy);
			const systemPrompt = privateDataReview
				? `${baseSystemPrompt}\n\n# Private Data Review Restriction\nNo investigation tools are available for this review. Decide authorization only from the user transcript and planned-action metadata; deny if explicit authorization is not established.`
				: baseSystemPrompt;
			const reviewerTools = reviewerToolsForAction(action);
			const key = JSON.stringify({
				cwd: ctx.cwd,
				model: `${model.provider}/${model.id}`,
				timeoutMs: config.timeoutMs,
				systemPrompt,
				privateDataReview,
			});
			if (!controller || controllerKey !== key) {
				controller?.dispose();
				controller = new ReviewerSessionController({
					model,
					modelRegistry: ctx.modelRegistry,
					cwd: ctx.cwd,
					systemPrompt,
					timeoutMs: config.timeoutMs,
					tools: reviewerTools,
				});
				controllerKey = key;
			}
			return controller.review(action, collectBranchMessages(ctx), ctx.signal);
		} catch (error) {
			return {
				kind: "failure",
				message: `Automatic approval review failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		} finally {
			activeReviews--;
			ctx.ui.setStatus(
				"approval-guardian",
				activeReviews > 0 ? reviewStatus(activeReviews) : undefined,
			);
		}
	}
}

interface ToolCallBatchBranchEntry {
	type: string;
	id?: string;
	message?: { role?: string; content?: unknown };
}

export function toolCallBatchInfo(
	toolCallId: string,
	branch: ReadonlyArray<ToolCallBatchBranchEntry>,
): { id: string; isLast: boolean } {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (
			entry?.type !== "message" ||
			entry.message?.role !== "assistant" ||
			!Array.isArray(entry.message.content)
		) {
			continue;
		}
		const toolCallIds = entry.message.content.flatMap((block) => {
			if (
				typeof block !== "object" ||
				block === null ||
				!("type" in block) ||
				block.type !== "toolCall" ||
				!("id" in block) ||
				typeof block.id !== "string"
			) {
				return [];
			}
			return [block.id];
		});
		if (!toolCallIds.includes(toolCallId)) continue;
		return {
			id: entry.id ?? `tool-message:${toolCallIds[0] ?? toolCallId}`,
			isLast: toolCallIds.at(-1) === toolCallId,
		};
	}
	return { id: `tool-call:${toolCallId}`, isLast: true };
}

export function reviewerToolsForAction(
	action: GuardianAction,
): Array<"read" | "grep" | "find" | "ls"> | undefined {
	return action.payload.private_data_read === true ? [] : undefined;
}

export function actionFromToolCall(
	event: ToolCallEvent,
	cwd: string,
	rules: Record<string, ReviewLevel>,
): GuardianAction | undefined {
	if (isToolCallEventType("bash", event)) {
		if ((rules["bash.command"] ?? "always") === "off") return;
		return {
			tool: "bash",
			payload: {
				command: event.input.command,
				private_data_read: commandReferencesPrivateData(event.input.command, cwd),
			},
			cwd,
		};
	}
	if (isToolCallEventType("read", event)) {
		return pathReadAction("read", event.input, cwd, rules["read.path"]);
	}
	if (isToolCallEventType("grep", event)) {
		return pathReadAction(
			"grep",
			{ ...event.input, path: event.input.path || "." },
			cwd,
			rules["grep.path"],
		);
	}
	if (isToolCallEventType("write", event)) {
		const target = classifyMutationPath(event.input.path, cwd);
		const level = rules["write.path"] ?? "outside-or-private";
		if (!shouldReviewMutationTarget(level, target)) return;
		return {
			tool: "write",
			payload: {
				path: target.absolutePath,
				content: event.input.content,
				review_reasons: target.reasons,
			},
			cwd,
		};
	}
	if (isToolCallEventType("edit", event)) {
		const target = classifyMutationPath(event.input.path, cwd);
		const level = rules["edit.path"] ?? "outside-or-private";
		if (!shouldReviewMutationTarget(level, target)) return;
		return {
			tool: "edit",
			payload: {
				path: target.absolutePath,
				edits: event.input.edits,
				review_reasons: target.reasons,
			},
			cwd,
		};
	}
	return pathReadAction(
		event.toolName,
		event.input as Record<string, unknown>,
		cwd,
		rules[`${event.toolName}.path`] ?? "private-only",
	);
}

function pathReadAction(
	tool: string,
	input: Record<string, unknown>,
	cwd: string,
	level: ReviewLevel = "private-only",
): GuardianAction | undefined {
	const configuredPath =
		typeof input.path === "string" && input.path.trim()
			? input.path
			: undefined;
	const directorySearchTool =
		tool === "grep" || tool === "find" || tool === "ls";
	const path =
		configuredPath ??
		(level === "always" || directorySearchTool ? "." : undefined);
	if (!path) return;
	const target = classifyReadPath(path, cwd);
	const selector =
		tool === "grep"
			? input.glob
			: tool === "find"
				? input.pattern
				: undefined;
	const privateSelector =
		typeof selector === "string" && looksLikePrivateGlob(selector);
	const privateScope =
		directorySearchTool &&
		directoryMayContainPrivatePath(
			path,
			cwd,
			typeof selector === "string" ? selector : undefined,
		);
	if (!shouldReviewPath(level, target) && !privateSelector && !privateScope)
		return;
	return {
		tool,
		payload: {
			...input,
			path: target.absolutePath,
			review_reasons: target.reasons,
			review_level: level,
			private_data_read: target.private || privateSelector || privateScope,
		},
		cwd,
	};
}

const PRIVATE_COMMAND_DIRECTORIES = [
	".ssh",
	".gnupg",
	".aws",
	".azure",
	".kube",
	".docker",
	".password-store",
	"secrets",
	"secret",
	"credentials",
	"keychains",
	"keyrings",
];

function commandReferencesPrivateData(command: string, cwd: string): boolean {
	const expanded = command
		.replace(/\$\{HOME\}|\$HOME/gi, homedir())
		.replace(/(^|[\s'"=])~(?=\/)/g, `$1${homedir()}`)
		.replace(/\\/g, "/");
	const normalized = expanded.toLowerCase();
	if (
		PRIVATE_COMMAND_DIRECTORIES.some((directory) =>
			new RegExp(
				`(?:^|[\\s'"=/])${escapeRegExp(directory)}(?=$|[\\s'";&|/])`,
			).test(normalized),
		)
	) {
		return true;
	}
	if (referencesDynamicPiPath(expanded)) return true;
	if (commandPiPaths(expanded).some((path) => classifyReadPath(path, cwd).private)) {
		return true;
	}
	return /(?:^|[\s'"=\/])(?:\.env(?:\.[^\s'";|&\/]*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|auth\.json|tokens?\.json|credentials(?:\.json)?|secrets?\.json|id_(?:rsa|ed25519|ecdsa|dsa)|[^\s'";|&\/]+\.(?:pem|key|p12|pfx|jks|keystore|kdbx|tfvars))(?=$|[\s'";|&\/])/i.test(
		normalized,
	);
}

function referencesDynamicPiPath(command: string): boolean {
	const piTokens = command
		.split(/[\s'"`;|&<>()]+/)
		.filter((token) => token.toLowerCase().includes(".pi"));
	if (piTokens.some((token) => /[*?\[\]{}$]/.test(token))) return true;

	const assignments = command.matchAll(
		/(?:^|[;\s])([a-z_][a-z0-9_]*)\s*=\s*["']?([^;\s"']*\.pi[^;\s"']*)/gi,
	);
	for (const assignment of assignments) {
		const variable = assignment[1];
		if (!variable) continue;
		const remaining = command.slice(
			(assignment.index ?? 0) + assignment[0].length,
		);
		const variableReference = new RegExp(
			`\\$(?:${escapeRegExp(variable)}\\b|\\{${escapeRegExp(variable)}\\})`,
		);
		if (variableReference.test(remaining)) return true;
	}
	return false;
}

function commandPiPaths(command: string): string[] {
	return command
		.split(/[\s'"`;|&<>()]+/)
		.map((token) => token.slice(token.lastIndexOf("=") + 1))
		.map((token) => token.replace(/^[\[{]+|[\]},]+$/g, ""))
		.filter((token) => {
			const normalized = token.toLowerCase();
			return (
				normalized === ".pi" ||
				normalized.startsWith(".pi/") ||
				normalized.includes("/.pi/") ||
				normalized.endsWith("/.pi")
			);
		});
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikePrivateGlob(glob: string): boolean {
	return /(?:^|[\\/])(?:\.env(?:[.*]|$)|secrets?(?:[\\/.*]|$)|credentials?(?:[\\/.*]|$)|\.ssh(?:[\\/]|$)|\.gnupg(?:[\\/]|$)|\.aws(?:[\\/]|$)|\.kube(?:[\\/]|$)|[^/\\]*\.(?:pem|key|p12|pfx|tfvars)(?:$|[},]))/i.test(
		glob,
	);
}

function shouldReviewMutationTarget(
	level: ReviewLevel,
	target: ReturnType<typeof classifyMutationPath>,
): boolean {
	if (level === "always") return true;
	if (level === "outside-or-private")
		return target.outsideProject || target.sensitive || target.private;
	if (level === "private-only") return target.private;
	return false;
}

export function enforceActionRequirements(
	action: GuardianAction,
	result: GuardianReviewResult,
): GuardianReviewResult {
	if (result.kind !== "allowed") return result;
	const { risk_level: risk, user_authorization: authorization } =
		result.assessment;
	let rationale: string | undefined;
	if (risk === "critical") {
		rationale = "Critical-risk actions cannot be automatically approved.";
	} else if (
		risk === "high" &&
		(authorization === "unknown" || authorization === "low")
	) {
		rationale =
			"High-risk actions require at least medium user authorization.";
	} else if (
		action.payload.private_data_read === true &&
		authorization !== "high"
	) {
		rationale =
			"The private-data read lacks explicit high user authorization. Explain the exact source and purpose, then wait for the user to authorize it in conversation before retrying.";
	}
	if (!rationale) return result;
	return {
		kind: "denied",
		assessment: {
			...result.assessment,
			outcome: "deny",
			rationale,
		},
	};
}

function collectBranchMessages(ctx: ExtensionContext): GuardianMessage[] {
	return ctx.sessionManager.getBranch().flatMap((entry) => {
		if (entry.type !== "message") return [];
		return [entry.message as GuardianMessage];
	});
}

function rejectionReason(
	result: Exclude<GuardianReviewResult, { kind: "allowed" }>,
): string {
	switch (result.kind) {
		case "denied":
			return [
				"This action was rejected due to unacceptable risk.",
				`Reason: ${result.assessment.rationale}`,
				"Do not attempt the same outcome through a workaround, indirect execution, or policy circumvention. Proceed only with a materially safer alternative or after the user explicitly approves the exact action after being informed of the risk.",
			].join("\n");
		case "timeout":
			return "Automatic permission review reached its deadline without approval. Do not assume approval; retry later or ask the user for guidance.";
		case "failure":
			return `Automatic permission review failed closed, so approval was not granted. ${result.message}`;
		case "cancelled":
			return "Automatic permission review was cancelled, so approval was not granted.";
		case "circuit-open":
			return "Repeated automatic-review denials reached the per-turn safety limit. Stop trying alternate commands and ask the user for guidance.";
		default:
			return "Automatic permission review failed closed with an unknown result.";
	}
}

function formatReviewResult(
	result: GuardianReviewResult,
	action: GuardianAction,
): string {
	const target = actionPreview(action);
	switch (result.kind) {
		case "allowed":
			return assessmentSummary("allowed", result.assessment);
		case "denied":
			return [
				assessmentSummary("blocked", result.assessment),
				truncate(singleLine(result.assessment.rationale), 240),
				target,
			].join("\n");
		case "timeout":
			return `Guardian · timed out · blocked\n${target}`;
		case "failure":
			return `Guardian · review failed · blocked\n${truncate(singleLine(result.message), 240)}\n${target}`;
		case "cancelled":
			return `Guardian · cancelled · blocked\n${target}`;
		case "circuit-open":
			return `Guardian · circuit open · blocked\n${target}`;
		default:
			return `Guardian · unknown result · blocked\n${target}`;
	}
}

function assessmentSummary(
	verdict: "allowed" | "blocked",
	assessment: GuardianAssessment,
): string {
	return `Guardian · ${verdict} · ${assessment.risk_level} risk · auth ${assessment.user_authorization}`;
}

function actionPreview(action: GuardianAction): string {
	if (action.tool === "bash") {
		return `$ ${truncate(singleLine(String(action.payload.command ?? "")), 120)}`;
	}
	return `${action.tool} ${truncate(String(action.payload.path ?? ""), 120)}`;
}

function reviewStatus(activeReviews: number): string {
	return activeReviews > 1
		? `Guardian · reviewing ${activeReviews}`
		: "Guardian · reviewing";
}

function formatDuration(timeoutMs: number): string {
	return timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`;
}

function singleLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
	return value.length > maxLength
		? `${value.slice(0, Math.max(0, maxLength - 1))}…`
		: value;
}
