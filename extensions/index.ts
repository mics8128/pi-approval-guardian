// pi-lens-ignore: find-import-file-without-extension
import {
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { loadGuardianConfig } from "../src/config.ts";
import {
	DenialCircuitBreaker,
	classifyMutationPath,
	classifyReadPath,
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

	const resetRuntime = () => {
		controller?.dispose();
		controller = undefined;
		controllerKey = undefined;
		circuitBreaker.reset();
	};

	pi.on("session_start", () => resetRuntime());
	pi.on("session_shutdown", (_event, ctx) => {
		resetRuntime();
		activeReviews = 0;
		ctx.ui.setStatus("approval-guardian", undefined);
	});
	pi.on("before_agent_start", () => {
		circuitBreaker.reset();
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
						"Review rules (tool.parameter → level):",
						"bash.command → model review",
						"read.path → explicit user confirmation for blacklisted private paths; otherwise off",
						"write.path → model review for sensitive or out-of-project paths; otherwise off",
						"edit.path → model review for sensitive or out-of-project paths; otherwise off",
						"All other tools/parameters → off",
					]
				: [
						"Reviews every agent bash action, blacklisted private reads, and sensitive/out-of-project writes or edits before execution.",
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
		const readPath = readPathFromToolCall(event);
		if (readPath) {
			const target = classifyReadPath(readPath, ctx.cwd);
			if (target.private) {
				if (!ctx.hasUI) {
					return {
						block: true,
						reason: `Reading private path ${target.absolutePath} requires explicit user confirmation, but no interactive approval UI is available.`,
					};
				}
				const approved = await ctx.ui.confirm(
					"Approval Guardian · private read",
					[
						`Allow the agent to read this path?`,
						target.absolutePath,
						`Reason: ${target.reasons.join(", ")}`,
						"The file contents will enter the agent conversation context.",
					].join("\n"),
				);
				if (!approved) {
					return {
						block: true,
						reason: `User did not explicitly authorize reading private path ${target.absolutePath}.`,
					};
				}
				ctx.ui.notify(
					`Approval Guardian · explicitly allowed private read\n${target.absolutePath}`,
					"warning",
				);
				return;
			}
		}

		const action = actionFromToolCall(event, ctx.cwd);
		if (!action) return;

		if (circuitBreaker.isOpen()) {
			const result: GuardianReviewResult = {
				kind: "circuit-open",
				message: "Repeated Guardian denials reached the per-turn limit.",
			};
			ctx.ui.notify(formatReviewResult(result, action), "error");
			return { block: true, reason: rejectionReason(result) };
		}

		const result = await reviewAction(action, ctx);
		if (result.kind === "allowed") {
			circuitBreaker.record(false);
			ctx.ui.notify(formatReviewResult(result, action), "info");
			return;
		}

		if (result.kind === "denied") {
			const opened = circuitBreaker.record(true);
			ctx.ui.notify(formatReviewResult(result, action), "error");
			if (opened) ctx.abort();
		} else {
			circuitBreaker.record(false);
			ctx.ui.notify(
				formatReviewResult(result, action),
				result.kind === "cancelled" ? "warning" : "error",
			);
		}
		return { block: true, reason: rejectionReason(result) };
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

			const systemPrompt = buildGuardianSystemPrompt(config.policy);
			const key = JSON.stringify({
				cwd: ctx.cwd,
				model: `${model.provider}/${model.id}`,
				timeoutMs: config.timeoutMs,
				systemPrompt,
			});
			if (!controller || controllerKey !== key) {
				controller?.dispose();
				controller = new ReviewerSessionController({
					model,
					modelRegistry: ctx.modelRegistry,
					cwd: ctx.cwd,
					systemPrompt,
					timeoutMs: config.timeoutMs,
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

function readPathFromToolCall(event: ToolCallEvent): string | undefined {
	if (isToolCallEventType("read", event)) return event.input.path;
	if (event.toolName !== "hypa_read") return;
	const input = event.input as { path?: unknown };
	return typeof input.path === "string" ? input.path : undefined;
}

function actionFromToolCall(
	event: ToolCallEvent,
	cwd: string,
): GuardianAction | undefined {
	if (isToolCallEventType("bash", event)) {
		return { tool: "bash", payload: { command: event.input.command }, cwd };
	}
	if (isToolCallEventType("write", event)) {
		const target = classifyMutationPath(event.input.path, cwd);
		if (!target.outsideProject && !target.sensitive) return;
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
		if (!target.outsideProject && !target.sensitive) return;
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
	return;
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
