// pi-lens-ignore: find-import-file-without-extension
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadGuardianConfig, type GuardianConfig } from "../src/config.ts";
import { DirectoryScanCache } from "../src/directory-scan-cache.ts";
import {
	DenialCircuitBreaker,
	ReviewBatchTracker,
	circuitOutcomeForReview,
	type GuardianReviewResult,
} from "../src/gate.ts";
import { buildGuardianSystemPrompt } from "../src/policy.ts";
import {
	formatReviewResult,
	rejectionReason,
	reviewResultDiagnostic,
} from "../src/review-presentation.ts";
import {
	showGuardianConfiguration,
	syncGuardianRuntimeHealth,
} from "../src/guardian-status.ts";
import type { GuardianAction, GuardianMessage } from "../src/review.ts";
import {
	buildReviewerChannels,
	modelSpecFor,
	reviewerChannelLabel,
	runReviewWithFallbackChain,
	shouldFallbackReview,
	type ReviewerChannel,
} from "../src/reviewer-channels.ts";
import { ReviewerSessionController } from "../src/reviewer-session.ts";
import {
	actionFromToolCall,
	enforceActionRequirements,
	reviewerToolsForAction,
	shouldInvalidateDirectoryScanCache,
	toolCallBatchInfo,
} from "../src/tool-actions.ts";
import { lockAllowedToolInput } from "../src/tool-input-lock.ts";

export {
	guardianHealth,
	runReviewWithFallbackChain,
	shouldFallbackReview,
	type ReviewerChannel,
} from "../src/reviewer-channels.ts";
export {
	actionFromToolCall,
	enforceActionRequirements,
	reviewerToolsForAction,
	shouldInvalidateDirectoryScanCache,
	toolCallBatchInfo,
} from "../src/tool-actions.ts";
export {
	lockAllowedToolInput,
	lockReviewedToolInput,
} from "../src/tool-input-lock.ts";

function collectBranchMessages(ctx: ExtensionContext): GuardianMessage[] {
	return ctx.sessionManager.getBranch().flatMap((entry) => {
		if (entry.type !== "message") return [];
		return [entry.message as GuardianMessage];
	});
}

export interface ApprovalGuardianOptions {
	directoryScanCache?: DirectoryScanCache;
}

// Extension wiring intentionally coordinates lifecycle, UI, policy, and reviewer state.
// pi-lens-ignore: high-complexity, high-fan-out
export default function approvalGuardian(
	pi: ExtensionAPI,
	options: ApprovalGuardianOptions = {},
) {
	type GuardianCommandContext = Parameters<
		Parameters<typeof pi.registerCommand>[1]["handler"]
	>[1];

	let temporaryBypassActive = false;
	let configurationWarningKey: string | undefined;
	const reviewerSwitchNoticeKeys = new Set<string>();
	const controllers = new Map<string, ReviewerSessionController>();
	let controllerContextKey: string | undefined;
	const circuitBreaker = new DenialCircuitBreaker();
	const reviewBatches = new ReviewBatchTracker();
	const directoryScanCache =
		options.directoryScanCache ?? new DirectoryScanCache();

	const showBypassWarning = (ctx: ExtensionContext) => {
		ctx.ui.setWidget(
			"approval-guardian-bypass",
			[
				ctx.ui.theme.fg(
					"warning",
					"⚠ Approval Guardian is BYPASSED — run /approval-guardian enable",
				),
			],
			{ placement: "belowEditor" },
		);
	};

	const clearBypassWarning = (ctx: ExtensionContext) => {
		ctx.ui.setWidget("approval-guardian-bypass", undefined);
	};

	const disposeReviewerControllers = () => {
		for (const controller of controllers.values()) controller.dispose();
		controllers.clear();
		controllerContextKey = undefined;
	};

	const resetRuntime = () => {
		disposeReviewerControllers();
		temporaryBypassActive = false;
		configurationWarningKey = undefined;
		reviewerSwitchNoticeKeys.clear();
		circuitBreaker.reset();
		reviewBatches.reset();
		directoryScanCache.clear();
	};

	const syncConfigurationWarnings = (
		ctx: ExtensionContext,
		warnings: string[],
	) => {
		const nextKey = warnings.length > 0 ? warnings.join("\n") : undefined;
		if (!nextKey) {
			configurationWarningKey = undefined;
			return;
		}
		if (configurationWarningKey === nextKey) return;
		configurationWarningKey = nextKey;
		ctx.ui.notify(
			[
				"Approval Guardian configuration warning. Invalid entries were ignored; remaining valid settings and built-in defaults are active.",
				...warnings,
			].join("\n"),
			"warning",
		);
	};

	const notifyReviewerSwitch = (
		ctx: ExtensionContext,
		from: ReviewerChannel,
		to: ReviewerChannel,
	) => {
		const key = `${from.role}:${from.modelSpec}→${to.role}:${to.modelSpec}`;
		if (reviewerSwitchNoticeKeys.has(key)) return;
		reviewerSwitchNoticeKeys.add(key);
		ctx.ui.notify(
			to.role === "current-model"
				? `Guardian · configured reviewer channels unavailable; using current session model ${to.modelSpec}.`
				: `Guardian · primary reviewer unavailable; using configured fallback ${to.modelSpec}.`,
			"warning",
		);
	};

	const finishReviewBatch = (batchId: string, ctx: ExtensionContext) => {
		const adverse = reviewBatches.finish(batchId);
		if (adverse !== undefined && circuitBreaker.record(adverse)) ctx.abort();
	};

	const statusCallbacks = {
		syncConfigurationWarnings,
		notifyReviewerSwitch,
	};

	pi.on("session_start", (_event, ctx) => {
		const wasBypassed = temporaryBypassActive;
		resetRuntime();
		if (wasBypassed) clearBypassWarning(ctx);
		syncGuardianRuntimeHealth(ctx, statusCallbacks);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		resetRuntime();
		clearBypassWarning(ctx);
	});
	pi.on("before_agent_start", () => {
		// Temporary bypass is intentionally UI/control-plane state only. Do not
		// inject it into model context or treat it as additional authorization.
		circuitBreaker.reset();
		reviewBatches.reset();
		directoryScanCache.clear();
	});

	const setTemporaryBypass = async (
		nextActive: boolean,
		ctx: GuardianCommandContext,
	): Promise<void> => {
		if (nextActive && ctx.mode !== "tui") {
			throw new Error(
				"Temporary Approval Guardian bypass requires interactive TUI mode so the persistent warning remains visible.",
			);
		}
		await ctx.waitForIdle();
		if (temporaryBypassActive === nextActive) {
			if (nextActive) showBypassWarning(ctx);
			else clearBypassWarning(ctx);
			ctx.ui.notify(
				nextActive
					? "Approval Guardian is already temporarily bypassed. Run /approval-guardian enable to restore protection."
					: "Approval Guardian is already enabled.",
				nextActive ? "warning" : "info",
			);
			return;
		}

		disposeReviewerControllers();
		reviewerSwitchNoticeKeys.clear();
		circuitBreaker.reset();
		reviewBatches.reset();
		directoryScanCache.clear();
		if (nextActive) {
			temporaryBypassActive = true;
			showBypassWarning(ctx);
			ctx.ui.notify(
				[
					"Approval Guardian is temporarily BYPASSED.",
					"Covered agent tool calls will proceed without Guardian review until /approval-guardian enable.",
					"This does not grant the agent additional authorization, and the bypass resets automatically when the Pi session runtime reloads or is replaced.",
				].join("\n"),
				"warning",
			);
			return;
		}

		temporaryBypassActive = false;
		clearBypassWarning(ctx);
		syncGuardianRuntimeHealth(ctx, statusCallbacks);
		ctx.ui.notify(
			"Approval Guardian is enabled again. Covered agent tool calls once again require Guardian review.",
			"info",
		);
	};

	const commandArguments = [
		{
			value: "rules",
			label: "rules",
			description: "Show review levels",
		},
		{
			value: "bypass",
			label: "bypass",
			description: "Temporarily disable Guardian review",
		},
		{
			value: "enable",
			label: "enable",
			description: "End the temporary bypass",
		},
	];

	pi.registerCommand("approval-guardian", {
		description:
			"Show Guardian status/rules or temporarily bypass/enable review",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trim().toLowerCase();
			const matches = commandArguments.filter(({ value }) =>
				value.startsWith(normalized),
			);
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			switch (args.trim().toLowerCase()) {
				case "bypass":
					await setTemporaryBypass(true, ctx);
					return;
				case "enable":
					await setTemporaryBypass(false, ctx);
					return;
				default:
					await showGuardianConfiguration(
						args,
						ctx,
						temporaryBypassActive,
						statusCallbacks,
					);
			}
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (temporaryBypassActive) return;
		const batch = toolCallBatchInfo(
			event.toolCallId,
			ctx.sessionManager.getBranch(),
		);
		try {
			const config = loadGuardianConfig({
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
			});
			syncConfigurationWarnings(ctx, config.warnings);
			const action = actionFromToolCall(
				event,
				ctx.cwd,
				config.review,
				directoryScanCache,
			);
			if (!action) return;

			if (circuitBreaker.isOpen()) {
				const result: GuardianReviewResult = {
					kind: "circuit-open",
					message: "Repeated adverse Guardian outcomes reached the per-turn limit.",
				};
				ctx.ui.notify(formatReviewResult(result, action), "error");
				return { block: true, reason: rejectionReason(result) };
			}

			const reviewed = await reviewAction(action, config, ctx);
			const result = lockAllowedToolInput(
				event,
				enforceActionRequirements(action, reviewed),
			);
			const circuitOutcome = circuitOutcomeForReview(result);
			if (circuitOutcome !== undefined) {
				reviewBatches.record(batch.id, circuitOutcome);
			}
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
		if (temporaryBypassActive) return;
		if (shouldInvalidateDirectoryScanCache(event.toolName)) {
			directoryScanCache.clear();
		}
		const batch = toolCallBatchInfo(
			event.toolCallId,
			ctx.sessionManager.getBranch(),
		);
		if (batch.isLast) finishReviewBatch(batch.id, ctx);
	});

	async function reviewAction(
		action: GuardianAction,
		config: GuardianConfig,
		ctx: ExtensionContext,
	): Promise<GuardianReviewResult> {
		try {
			const channels = buildReviewerChannels(
				config,
				ctx.modelRegistry,
				ctx.model,
			);
			const { result, attempts } = await runReviewWithFallbackChain(
				channels,
				(channel) => reviewWithChannel(channel, config, action, ctx),
				(from, to) => notifyReviewerSwitch(ctx, from, to),
			);
			const usedFallback = attempts.length > 1;
			if (usedFallback && shouldFallbackReview(result)) {
				ctx.ui.notify(
					[
						"Guardian · all attempted reviewer channels failed.",
						...attempts.map(
							({ channel, result: attemptResult }) =>
								`${reviewerChannelLabel(channel.role)} (${channel.modelSpec}): ${reviewResultDiagnostic(attemptResult)}`,
						),
					].join("\n"),
					"error",
				);
			}
			if (
				!usedFallback &&
				(result.kind === "allowed" || result.kind === "denied")
			) {
				reviewerSwitchNoticeKeys.clear();
			}
			if (usedFallback && result.kind === "failure") {
				return {
					kind: "failure",
					message: "Automatic approval review failed.",
				};
			}
			if (usedFallback && result.kind === "timeout") {
				return {
					kind: "timeout",
					message: "Automatic approval review timed out.",
				};
			}
			return result;
		} catch (error) {
			return {
				kind: "failure",
				message: `Automatic approval review failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	async function reviewWithChannel(
		channel: ReviewerChannel,
		config: GuardianConfig,
		action: GuardianAction,
		ctx: ExtensionContext,
	): Promise<GuardianReviewResult> {
		try {
			const model = channel.model;
			if (!model) {
				return {
					kind: "failure",
					message: `Reviewer model not found: ${channel.modelSpec}.`,
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
			const nextContextKey = JSON.stringify({
				cwd: ctx.cwd,
				primaryModel: config.model,
				fallbackModel: config.fallbackModel,
				currentModel: ctx.model ? modelSpecFor(ctx.model) : undefined,
				timeoutMs: config.timeoutMs,
				baseSystemPrompt,
			});
			if (controllerContextKey !== nextContextKey) {
				for (const existing of controllers.values()) existing.dispose();
				controllers.clear();
				controllerContextKey = nextContextKey;
			}
			const key = JSON.stringify({
				channel: channel.role,
				modelSpec: channel.modelSpec,
				model: `${model.provider}/${model.id}`,
				privateDataReview,
			});
			let controller = controllers.get(key);
			if (!controller) {
				controller = new ReviewerSessionController({
					model,
					modelRegistry: ctx.modelRegistry,
					cwd: ctx.cwd,
					systemPrompt,
					timeoutMs: config.timeoutMs,
					tools: reviewerTools,
				});
				controllers.set(key, controller);
			}
			return controller.review(action, collectBranchMessages(ctx), ctx.signal);
		} catch (error) {
			return {
				kind: "failure",
				message: `Automatic approval review failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
}
