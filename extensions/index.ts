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
	type GuardianConfig,
	type ReviewLevel,
} from "../src/config.ts";
import {
	DenialCircuitBreaker,
	ReviewBatchTracker,
	circuitOutcomeForReview,
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
	type ReviewerModel,
} from "../src/reviewer-session.ts";

type ReviewerChannelRole =
	| "primary"
	| "configured-fallback"
	| "current-model";

export interface ReviewerChannel {
	role: ReviewerChannelRole;
	modelSpec: string;
	model?: ReviewerModel;
}

interface GuardianHealth {
	ready: boolean;
	reason?: string;
	selectedFallback?: Exclude<ReviewerChannelRole, "primary">;
	fallbackUnavailable?: boolean;
}

function reviewerModelForSpec(
	modelSpec: string,
	registry: ExtensionContext["modelRegistry"],
): ReviewerModel | undefined {
	const parsed = parseModelSpec(modelSpec);
	return parsed
		? resolveReviewerModel(registry, parsed.provider, parsed.model)
		: undefined;
}

function modelSpecFor(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function reviewerChannelForSpec(
	role: ReviewerChannelRole,
	modelSpec: string,
	registry: ExtensionContext["modelRegistry"],
	currentModel?: ExtensionContext["model"],
): ReviewerChannel {
	const model =
		currentModel && modelSpecFor(currentModel) === modelSpec
			? (currentModel as ReviewerModel)
			: reviewerModelForSpec(modelSpec, registry);
	return { role, modelSpec, model };
}

function currentReviewerChannel(
	currentModel: ExtensionContext["model"],
): ReviewerChannel | undefined {
	return currentModel
		? {
				role: "current-model",
				modelSpec: modelSpecFor(currentModel),
				model: currentModel as ReviewerModel,
			}
		: undefined;
}

function reviewerChannelIdentity(channel: ReviewerChannel): string {
	return channel.model ? modelSpecFor(channel.model) : channel.modelSpec;
}

function buildReviewerChannels(
	config: GuardianConfig,
	registry: ExtensionContext["modelRegistry"],
	currentModel?: ExtensionContext["model"],
): ReviewerChannel[] {
	const candidates = [
		reviewerChannelForSpec("primary", config.model, registry, currentModel),
		reviewerChannelForSpec(
			"configured-fallback",
			config.fallbackModel,
			registry,
			currentModel,
		),
		currentReviewerChannel(currentModel),
	].filter((channel): channel is ReviewerChannel => channel !== undefined);
	const seen = new Set<string>();
	return candidates.filter((channel) => {
		const identity = reviewerChannelIdentity(channel);
		if (seen.has(identity)) return false;
		seen.add(identity);
		return true;
	});
}

function reviewerChannelLabel(role: ReviewerChannelRole): string {
	switch (role) {
		case "primary":
			return "Primary";
		case "configured-fallback":
			return "Configured fallback";
		case "current-model":
			return "Current session model";
	}
}

function reviewerChannelIssue(
	channel: ReviewerChannel,
	registry: ExtensionContext["modelRegistry"],
): string | undefined {
	return !channel.model
		? `Reviewer model not found: ${channel.modelSpec}.`
		: !registry.hasConfiguredAuth(channel.model)
			? `Reviewer authentication is unavailable for ${channel.model.provider}.`
			: undefined;
}

export function guardianHealth(
	config: GuardianConfig,
	registry: ExtensionContext["modelRegistry"],
	currentModel?: ExtensionContext["model"],
): GuardianHealth {
	const channels = buildReviewerChannels(config, registry, currentModel);
	const issues = channels.map((channel) => reviewerChannelIssue(channel, registry));
	const primaryIssue = issues[0];
	const backups = channels.slice(1);
	const backupIssues = issues.slice(1);
	if (!primaryIssue) {
		return backups.length > 0 && backupIssues.every(Boolean)
			? {
					ready: true,
					reason: backupIssues
						.map(
							(issue, index) =>
								`${reviewerChannelLabel(backups[index].role)} unavailable: ${issue}`,
						)
						.join(" "),
					fallbackUnavailable: true,
				}
			: { ready: true };
	}
	const readyFallbackIndex = backupIssues.findIndex((issue) => !issue);
	if (readyFallbackIndex >= 0) {
		const selected = backups[readyFallbackIndex];
		return {
			ready: true,
			reason: channels
				.slice(0, readyFallbackIndex + 1)
				.map(
					(channel, index) =>
						`${reviewerChannelLabel(channel.role)} unavailable: ${issues[index]}`,
				)
				.join(" "),
			selectedFallback: selected.role as Exclude<
				ReviewerChannelRole,
				"primary"
			>,
		};
	}
	return {
		ready: false,
		reason: channels
			.map(
				(channel, index) =>
					`${reviewerChannelLabel(channel.role)} unavailable: ${issues[index]}`,
			)
			.join(" "),
	};
}

export function shouldFallbackReview(result: GuardianReviewResult): boolean {
	return result.kind === "failure";
}

export async function runReviewWithFallbackChain(
	channels: ReviewerChannel[],
	review: (channel: ReviewerChannel) => Promise<GuardianReviewResult>,
	onFallback: (from: ReviewerChannel, to: ReviewerChannel) => void,
): Promise<{
	result: GuardianReviewResult;
	finalChannel: ReviewerChannel;
	attempts: Array<{ channel: ReviewerChannel; result: GuardianReviewResult }>;
}> {
	const seen = new Set<string>();
	const distinctChannels = channels.filter((channel) => {
		const identity = reviewerChannelIdentity(channel);
		if (seen.has(identity)) return false;
		seen.add(identity);
		return true;
	});
	if (distinctChannels.length === 0)
		throw new Error("No reviewer channels are configured.");
	const attempts: Array<{
		channel: ReviewerChannel;
		result: GuardianReviewResult;
	}> = [];
	for (let index = 0; index < distinctChannels.length; index++) {
		const channel = distinctChannels[index];
		if (index > 0)
			onFallback(distinctChannels[index - 1], channel);
		const result = await review(channel);
		attempts.push({ channel, result });
		if (
			!shouldFallbackReview(result) ||
			index === distinctChannels.length - 1
		) {
			return { result, finalChannel: channel, attempts };
		}
	}
	throw new Error("Guardian reviewer chain ended unexpectedly.");
}

export function lockReviewedToolInput(event: ToolCallEvent): void {
	const input = event.input;
	deepFreezeJsonLike(input);
	const descriptor = Object.getOwnPropertyDescriptor(event, "input");
	Object.defineProperty(event, "input", {
		value: input,
		enumerable: descriptor?.enumerable ?? true,
		writable: false,
		configurable: false,
	});
}

export function lockAllowedToolInput(
	event: ToolCallEvent,
	result: GuardianReviewResult,
): GuardianReviewResult {
	if (result.kind !== "allowed") return result;
	try {
		lockReviewedToolInput(event);
		return result;
	} catch (error) {
		return {
			kind: "failure",
			message: `Approved tool input could not be locked safely: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function deepFreezeJsonLike(value: unknown): void {
	assertJsonLike(value);
	freezeJsonLike(value);
}

function assertJsonLike(
	value: unknown,
	visited = new WeakSet<object>(),
	active = new WeakSet<object>(),
): void {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("non-finite number");
		return;
	}
	if (typeof value !== "object") {
		throw new Error(`non-JSON ${typeof value} value`);
	}
	if (active.has(value)) throw new Error("cyclic object graph");
	if (visited.has(value)) return;
	active.add(value);
	const prototype = Object.getPrototypeOf(value);
	if (Array.isArray(value)) {
		if (prototype !== Array.prototype) {
			throw new Error("array with custom prototype");
		}
		let indexCount = 0;
		for (const key of Reflect.ownKeys(value)) {
			if (key === "length") continue;
			if (typeof key === "symbol") throw new Error("symbol-keyed property");
			const index = Number(key);
			if (
				!Number.isInteger(index) ||
				index < 0 ||
				String(index) !== key ||
				index >= value.length
			) {
				throw new Error(`non-JSON array property ${key}`);
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
				throw new Error(`non-JSON array index ${key}`);
			}
			indexCount++;
			assertJsonLike(descriptor.value, visited, active);
		}
		if (indexCount !== value.length) throw new Error("sparse array");
	} else {
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error(
				`non-plain object ${prototype?.constructor?.name ?? "unknown"}`,
			);
		}
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key === "symbol") throw new Error("symbol-keyed property");
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
				throw new Error(`non-JSON property ${key}`);
			}
			assertJsonLike(descriptor.value, visited, active);
		}
	}
	active.delete(value);
	visited.add(value);
}

function freezeJsonLike(value: unknown, seen = new WeakSet<object>()): void {
	if (typeof value !== "object" || value === null || seen.has(value)) return;
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && "value" in descriptor) freezeJsonLike(descriptor.value, seen);
	}
	Object.freeze(value);
}

// Extension wiring intentionally coordinates lifecycle, UI, policy, and reviewer state.
// pi-lens-ignore: high-complexity, high-fan-out
export default function approvalGuardian(pi: ExtensionAPI) {
	let activeReviews = 0;
	let idleStatus: string | undefined;
	let configurationWarningsActive = false;
	let configurationWarningKey: string | undefined;
	const reviewerSwitchNoticeKeys = new Set<string>();
	const controllers = new Map<string, ReviewerSessionController>();
	let controllerContextKey: string | undefined;
	const circuitBreaker = new DenialCircuitBreaker();
	const reviewBatches = new ReviewBatchTracker();

	const displayedIdleStatus = (): string | undefined =>
		idleStatus && configurationWarningsActive
			? `${idleStatus} · config warnings`
			: idleStatus;

	const refreshIdleStatus = (ctx: ExtensionContext) => {
		if (activeReviews === 0 && idleStatus !== undefined) {
			ctx.ui.setStatus("approval-guardian", displayedIdleStatus());
		}
	};

	const resetRuntime = () => {
		for (const controller of controllers.values()) controller.dispose();
		controllers.clear();
		controllerContextKey = undefined;
		idleStatus = undefined;
		configurationWarningsActive = false;
		configurationWarningKey = undefined;
		reviewerSwitchNoticeKeys.clear();
		circuitBreaker.reset();
		reviewBatches.reset();
	};

	const setIdleStatus = (ctx: ExtensionContext, status: string) => {
		idleStatus = status;
		refreshIdleStatus(ctx);
	};

	const syncConfigurationWarnings = (
		ctx: ExtensionContext,
		warnings: string[],
	) => {
		const nextKey = warnings.length > 0 ? warnings.join("\n") : undefined;
		const nextActive = nextKey !== undefined;
		if (configurationWarningsActive !== nextActive) {
			configurationWarningsActive = nextActive;
			refreshIdleStatus(ctx);
		}
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
		setIdleStatus(
			ctx,
			to.role === "current-model"
				? "Guardian · current-model fallback"
				: "Guardian · fallback",
		);
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

	pi.on("session_start", (_event, ctx) => {
		resetRuntime();
		activeReviews = 0;
		const config = loadGuardianConfig({
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
		});
		syncConfigurationWarnings(ctx, config.warnings);
		const channels = buildReviewerChannels(
			config,
			ctx.modelRegistry,
			ctx.model,
		);
		const health = guardianHealth(config, ctx.modelRegistry, ctx.model);
		if (health.selectedFallback) {
			const selected = channels.find(
				(channel) => channel.role === health.selectedFallback,
			);
			if (selected) notifyReviewerSwitch(ctx, channels[0], selected);
		} else {
			setIdleStatus(
				ctx,
				!health.ready
					? "Guardian · needs attention"
					: health.fallbackUnavailable
						? "Guardian · ready · fallback unavailable"
						: "Guardian · ready",
			);
		}
		if (!health.selectedFallback && health.reason) {
			ctx.ui.notify(health.reason, "warning");
		}
	});
	pi.on("session_shutdown", (_event, ctx) => {
		resetRuntime();
		activeReviews = 0;
		idleStatus = undefined;
		ctx.ui.setStatus("approval-guardian", undefined);
	});
	pi.on("before_agent_start", () => {
		circuitBreaker.reset();
		reviewBatches.reset();
	});

	const showConfiguration = async (
		args: string,
		ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1],
	): Promise<void> => {
		const projectTrusted = ctx.isProjectTrusted();
		const config = loadGuardianConfig({ cwd: ctx.cwd, projectTrusted });
		syncConfigurationWarnings(ctx, config.warnings);
		const primaryChannel = reviewerChannelForSpec(
			"primary",
			config.model,
			ctx.modelRegistry,
			ctx.model,
		);
		const configuredFallbackChannel = reviewerChannelForSpec(
			"configured-fallback",
			config.fallbackModel,
			ctx.modelRegistry,
			ctx.model,
		);
		const currentChannel = currentReviewerChannel(ctx.model);
		const channels = buildReviewerChannels(
			config,
			ctx.modelRegistry,
			ctx.model,
		);
		const checkChannel = async (
			channel: ReviewerChannel,
		): Promise<string | undefined> => {
			if (!channel.model)
				return `Reviewer model not found: ${channel.modelSpec}.`;
			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(channel.model);
				return !auth.ok || !auth.apiKey
					? `Reviewer authentication is unavailable for ${channel.model.provider}.`
					: undefined;
			} catch (error) {
				return `Reviewer authentication check failed: ${error instanceof Error ? error.message : String(error)}`;
			}
		};
		const issues = new Map<string, string | undefined>();
		let issue: string | undefined;
		for (const channel of channels) {
			issues.set(reviewerChannelIdentity(channel), await checkChannel(channel));
		}
		const selectedIndex = channels.findIndex(
			(channel) => !issues.get(reviewerChannelIdentity(channel)),
		);
		if (selectedIndex < 0) {
			issue = channels
				.map(
					(channel) =>
						`${reviewerChannelLabel(channel.role)} unavailable: ${issues.get(reviewerChannelIdentity(channel))}`,
				)
				.join(" ");
		}
		const ready = selectedIndex >= 0 && issue === undefined;
		const selectedChannel = ready ? channels[selectedIndex] : undefined;
		const degradedFallback =
			ready &&
			selectedIndex === 0 &&
			channels.length > 1 &&
			channels
				.slice(1)
				.every((channel) => issues.get(reviewerChannelIdentity(channel)));
		const operationalStatusLabel = !ready
			? "needs attention"
			: selectedChannel?.role === "current-model"
				? "ready via current model"
				: selectedChannel?.role === "configured-fallback"
					? "ready via configured fallback"
					: degradedFallback
						? "ready · fallback unavailable"
						: "ready";
		const statusLabel =
			config.warnings.length > 0
				? `${operationalStatusLabel} · config warnings`
				: operationalStatusLabel;
		const channelStatus = (channelIssue: string | undefined) =>
			channelIssue ? "unavailable" : "ready";
		const primaryIdentity = reviewerChannelIdentity(primaryChannel);
		const configuredIdentity = reviewerChannelIdentity(
			configuredFallbackChannel,
		);
		const currentIdentity = currentChannel
			? reviewerChannelIdentity(currentChannel)
			: undefined;
		const configuredFallbackStatus =
			configuredIdentity === primaryIdentity
				? "same as primary (no separate channel)"
				: channelStatus(issues.get(configuredIdentity));
		const currentFallbackStatus = !currentChannel
			? "unavailable (no current session model)"
			: currentIdentity === primaryIdentity
				? "same as primary (no separate channel)"
				: currentIdentity === configuredIdentity
					? "same as configured fallback (no separate channel)"
					: channelStatus(issues.get(currentIdentity as string));
		const projectConfigStatus = !config.projectConfigPresent
			? "absent"
			: projectTrusted
				? "present · trusted"
				: "present · skipped (project untrusted)";
		if (selectedChannel && selectedIndex > 0) {
			notifyReviewerSwitch(ctx, channels[selectedIndex - 1], selectedChannel);
		} else {
			setIdleStatus(
				ctx,
				!ready
					? "Guardian · needs attention"
					: degradedFallback
						? "Guardian · ready · fallback unavailable"
						: "Guardian · ready",
			);
		}
		const details =
			args.trim() === "rules"
				? [
						"Review rules (tool.parameter → reviewer scope):",
						...Object.entries(config.review)
							.sort(([left], [right]) => left.localeCompare(right))
							.map(([key, level]) => `${key} → ${level}`),
						"Unconfigured tools with a top-level string path parameter default to private-only.",
						"All review prompts go to isolated AI reviewer sessions; no user confirmation dialog is used.",
					]
				: [
						"Reviews configured shell, private-read/search, and sensitive/out-of-project mutation actions before execution.",
						"Run /approval-guardian rules for the tool/parameter review matrix.",
					];
		const unavailableBeforeSelected =
			selectedIndex > 0
				? channels.slice(0, selectedIndex).map(
						(channel) =>
							`${reviewerChannelLabel(channel.role)} unavailable: ${issues.get(reviewerChannelIdentity(channel))}`,
					)
				: [];
		const unavailableBackups = degradedFallback
			? channels.slice(1).map(
					(channel) =>
						`${reviewerChannelLabel(channel.role)} unavailable: ${issues.get(reviewerChannelIdentity(channel))}`,
				)
			: [];
		ctx.ui.notify(
			[
				`Approval Guardian · ${statusLabel} · fail-closed`,
				`Primary: ${config.model} (${config.modelSource}) · ${channelStatus(issues.get(primaryIdentity))}`,
				`Configured fallback: ${config.fallbackModel} (${config.fallbackModelSource}) · ${configuredFallbackStatus}`,
				`Current-model fallback: ${currentChannel?.modelSpec ?? "unavailable"} · ${currentFallbackStatus}`,
				`${formatDuration(config.timeoutMs)} deadline (${config.timeoutSource}) · up to 3 attempts per distinct reviewer channel`,
				`Policy: ${config.policy ? `customized (${config.policySources.join(" + ")})` : "default"}`,
				`Global config: ${config.globalConfigPresent ? "present" : "absent"} · ${config.globalPath}`,
				`Project config: ${projectConfigStatus} · ${config.projectPath}`,
				config.warnings.length > 0
					? `Configuration: ${config.warnings.length} warning(s); invalid entries ignored, remaining valid settings and defaults active.`
					: "Configuration: valid",
				...details,
				...unavailableBeforeSelected,
				...unavailableBackups,
				...config.warnings.map((warning) => `Configuration warning: ${warning}`),
				...(issue ? [issue] : []),
			].join("\n"),
			ready && !degradedFallback && config.warnings.length === 0
				? "info"
				: "warning",
		);
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
			syncConfigurationWarnings(ctx, config.warnings);
			const action = actionFromToolCall(event, ctx.cwd, config.review);
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
		activeReviews++;
		ctx.ui.setStatus("approval-guardian", reviewStatus(activeReviews));
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
			if (result.kind === "failure" || result.kind === "timeout") {
				idleStatus = "Guardian · needs attention";
			} else if (!usedFallback && result.kind !== "cancelled") {
				const health = guardianHealth(config, ctx.modelRegistry, ctx.model);
				idleStatus = health.fallbackUnavailable
					? "Guardian · ready · fallback unavailable"
					: "Guardian · ready";
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
			idleStatus = "Guardian · needs attention";
			return {
				kind: "failure",
				message: `Automatic approval review failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		} finally {
			activeReviews--;
			ctx.ui.setStatus(
				"approval-guardian",
				activeReviews > 0 ? reviewStatus(activeReviews) : displayedIdleStatus(),
			);
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

const PRIVATE_COMMAND_GLOB_FILES = [
	".env",
	".env.local",
	".npmrc",
	".pypirc",
	".netrc",
	".git-credentials",
	"auth.json",
	"token.json",
	"tokens.json",
	"credentials.json",
	"secrets.json",
	"id_rsa",
	"id_ed25519",
	"id_ecdsa",
	"id_dsa",
	"secret.pem",
	"secret.key",
	"secret.p12",
	"secret.pfx",
	"secret.jks",
	"secret.keystore",
	"secret.kdbx",
	"terraform.tfvars",
];

function globExpressionReferencesPrivateData(expression: string): boolean {
	if (!/[*?\[\]{}]/.test(expression)) return false;
	return expression
		.split(/[\s'"`;|&<>()]+/)
		.map((token) => token.slice(token.lastIndexOf("=") + 1))
		.some((token) => {
			const segments = token
				.replace(/\\/g, "/")
				.toLowerCase()
				.split("/")
				.filter(Boolean);
			return segments.some((pattern) =>
				[...PRIVATE_COMMAND_DIRECTORIES, ...PRIVATE_COMMAND_GLOB_FILES].some(
					(candidate) => shellGlobMatches(pattern, candidate),
				),
			);
		});
}

function shellGlobMatches(pattern: string, candidate: string): boolean {
	return expandBracePatterns(pattern).some((expanded) => {
		const literal = expanded.replace(/\[[^\]]*\]/g, "").replace(/[*?]/g, "");
		if (literal.length === 0) return false;
		let source = "^";
		for (let index = 0; index < expanded.length; index++) {
			const character = expanded[index];
			if (character === "*") {
				source += ".*";
			} else if (character === "?") {
				source += ".";
			} else if (character === "[") {
				const close = expanded.indexOf("]", index + 1);
				if (close < 0) {
					source += "\\[";
					continue;
				}
				let content = expanded.slice(index + 1, close);
				if (content.startsWith("!")) content = `^${content.slice(1)}`;
				source += `[${content}]`;
				index = close;
			} else {
				source += escapeRegExp(character);
			}
		}
		try {
			return new RegExp(`${source}$`, "i").test(candidate);
		} catch {
			return false;
		}
	});
}

function expandBracePatterns(pattern: string, depth = 0): string[] {
	if (depth >= 2) return [pattern];
	const match = /\{([^{}]+)\}/.exec(pattern);
	if (!match || match.index === undefined) return [pattern];
	const options = match[1].split(",");
	if (options.length === 0 || options.length > 16) return [pattern];
	const prefix = pattern.slice(0, match.index);
	const suffix = pattern.slice(match.index + match[0].length);
	return options.flatMap((option) =>
		expandBracePatterns(`${prefix}${option}${suffix}`, depth + 1),
	);
}

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
	if (globExpressionReferencesPrivateData(expanded)) return true;
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
	return (
		/(?:^|[\\/])(?:\.env(?:[.*]|$)|secrets?(?:[\\/.*]|$)|credentials?(?:[\\/.*]|$)|\.ssh(?:[\\/]|$)|\.gnupg(?:[\\/]|$)|\.aws(?:[\\/]|$)|\.kube(?:[\\/]|$)|[^/\\]*\.(?:pem|key|p12|pfx|tfvars)(?:$|[},]))/i.test(
			glob,
		) || globExpressionReferencesPrivateData(glob)
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
			return "Repeated adverse automatic-review outcomes reached the per-turn safety limit. Stop trying alternate commands and ask the user for guidance.";
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

function reviewResultDiagnostic(result: GuardianReviewResult): string {
	if (result.kind === "failure" || result.kind === "timeout") {
		return singleLine(result.message);
	}
	return result.kind;
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
