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

interface GuardianHealth {
	ready: boolean;
	reason?: string;
	usingFallback?: boolean;
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

export function guardianHealth(
	config: GuardianConfig,
	registry: ExtensionContext["modelRegistry"],
): GuardianHealth {
	if (config.warnings.length > 0) {
		return {
			ready: false,
			reason: `Guardian configuration is invalid: ${config.warnings.join(" ")}`,
		};
	}
	const modelIssue = (modelSpec: string): string | undefined => {
		const model = reviewerModelForSpec(modelSpec, registry);
		return !model
			? `Reviewer model not found: ${modelSpec}.`
			: !registry.hasConfiguredAuth(model)
				? `Reviewer authentication is unavailable for ${model.provider}.`
				: undefined;
	};
	const primaryIssue = modelIssue(config.model);
	const distinctFallback = config.fallbackModel !== config.model;
	const fallbackIssue = distinctFallback
		? modelIssue(config.fallbackModel)
		: undefined;
	if (!primaryIssue) {
		return fallbackIssue
			? {
					ready: true,
					reason: `Fallback unavailable: ${fallbackIssue}`,
					fallbackUnavailable: true,
				}
			: { ready: true };
	}
	if (distinctFallback && !fallbackIssue) {
		return { ready: true, reason: primaryIssue, usingFallback: true };
	}
	return {
		ready: false,
		reason: distinctFallback
			? `${primaryIssue} Fallback unavailable: ${fallbackIssue}`
			: primaryIssue,
	};
}

export function shouldFallbackReview(result: GuardianReviewResult): boolean {
	return result.kind === "failure" || result.kind === "timeout";
}

export async function runReviewWithFallback(
	primaryModel: string,
	fallbackModel: string,
	review: (modelSpec: string) => Promise<GuardianReviewResult>,
	onFallback: () => void,
): Promise<{
	result: GuardianReviewResult;
	primaryResult: GuardianReviewResult;
	usedFallback: boolean;
}> {
	const primaryResult = await review(primaryModel);
	if (
		fallbackModel === primaryModel ||
		!shouldFallbackReview(primaryResult)
	) {
		return { result: primaryResult, primaryResult, usedFallback: false };
	}
	onFallback();
	return {
		result: await review(fallbackModel),
		primaryResult,
		usedFallback: true,
	};
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
	let fallbackNoticeKey: string | undefined;
	let controller: ReviewerSessionController | undefined;
	let controllerKey: string | undefined;
	const circuitBreaker = new DenialCircuitBreaker();
	const reviewBatches = new ReviewBatchTracker();

	const resetRuntime = () => {
		controller?.dispose();
		controller = undefined;
		controllerKey = undefined;
		fallbackNoticeKey = undefined;
		circuitBreaker.reset();
		reviewBatches.reset();
	};

	const setIdleStatus = (ctx: ExtensionContext, status: string) => {
		idleStatus = status;
		if (activeReviews === 0) {
			ctx.ui.setStatus("approval-guardian", status);
		}
	};

	const notifyFallback = (
		ctx: ExtensionContext,
		primaryModel: string,
		fallbackModel: string,
	) => {
		idleStatus = "Guardian · fallback";
		if (activeReviews === 0) {
			ctx.ui.setStatus("approval-guardian", idleStatus);
		}
		const key = `${primaryModel}→${fallbackModel}`;
		if (fallbackNoticeKey === key) return;
		fallbackNoticeKey = key;
		ctx.ui.notify(
			`Guardian · primary reviewer unavailable; using fallback ${fallbackModel}.`,
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
		const health = guardianHealth(config, ctx.modelRegistry);
		if (health.usingFallback) {
			notifyFallback(ctx, config.model, config.fallbackModel);
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
		if (!health.usingFallback && health.reason) {
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
		const checkModel = async (modelSpec: string): Promise<string | undefined> => {
			const model = reviewerModelForSpec(modelSpec, ctx.modelRegistry);
			if (!model) return `Reviewer model not found: ${modelSpec}.`;
			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				return !auth.ok || !auth.apiKey
					? `Reviewer authentication is unavailable for ${model.provider}.`
					: undefined;
			} catch (error) {
				return `Reviewer authentication check failed: ${error instanceof Error ? error.message : String(error)}`;
			}
		};
		let issue: string | undefined;
		let primaryIssue: string | undefined;
		let fallbackIssue: string | undefined;
		let usingFallback = false;
		const distinctFallback = config.fallbackModel !== config.model;
		if (config.warnings.length > 0) {
			issue = `Guardian configuration is invalid: ${config.warnings.join(" ")}`;
		} else {
			primaryIssue = await checkModel(config.model);
			fallbackIssue = distinctFallback
				? await checkModel(config.fallbackModel)
				: undefined;
			if (primaryIssue) {
				if (distinctFallback && !fallbackIssue) {
					usingFallback = true;
				} else {
					issue = distinctFallback
						? `${primaryIssue} Fallback unavailable: ${fallbackIssue}`
						: primaryIssue;
				}
			}
		}
		const ready = issue === undefined;
		const degradedFallback =
			ready && distinctFallback && !usingFallback && Boolean(fallbackIssue);
		const statusLabel = !ready
			? "needs attention"
			: usingFallback
				? "ready via fallback"
				: degradedFallback
					? "ready · fallback unavailable"
					: "ready";
		const channelStatus = (channelIssue: string | undefined) =>
			config.warnings.length > 0
				? "not checked"
				: channelIssue
					? "unavailable"
					: "ready";
		const fallbackStatus = distinctFallback
			? channelStatus(fallbackIssue)
			: "same as primary (no separate fallback)";
		const projectConfigStatus = !config.projectConfigPresent
			? "absent"
			: projectTrusted
				? "present · trusted"
				: "present · skipped (project untrusted)";
		if (usingFallback) {
			notifyFallback(ctx, config.model, config.fallbackModel);
		} else {
			setIdleStatus(
				ctx,
				ready ? "Guardian · ready" : "Guardian · needs attention",
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
						"All review prompts go to the isolated AI reviewer; no user confirmation dialog is used.",
					]
				: [
						"Reviews configured shell, private-read/search, and sensitive/out-of-project mutation actions before execution.",
						"Run /approval-guardian rules for the tool/parameter review matrix.",
					];
		ctx.ui.notify(
			[
				`Approval Guardian · ${statusLabel} · fail-closed`,
				`Primary: ${config.model} (${config.modelSource}) · ${channelStatus(primaryIssue)}`,
				`Fallback: ${config.fallbackModel} (${config.fallbackModelSource}) · ${fallbackStatus}`,
				`${formatDuration(config.timeoutMs)} deadline (${config.timeoutSource}) · up to 3 attempts per reviewer channel`,
				`Policy: ${config.policy ? `customized (${config.policySources.join(" + ")})` : "default"}`,
				`Global config: ${config.globalConfigPresent ? "present" : "absent"} · ${config.globalPath}`,
				`Project config: ${projectConfigStatus} · ${config.projectPath}`,
				...details,
				...(usingFallback && primaryIssue ? [`Primary unavailable: ${primaryIssue}`] : []),
				...(degradedFallback && fallbackIssue
					? [`Fallback unavailable: ${fallbackIssue}`]
					: []),
				...(issue ? [issue] : []),
			].join("\n"),
			ready && !degradedFallback ? "info" : "warning",
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
			const { result, primaryResult, usedFallback } =
				await runReviewWithFallback(
					config.model,
					config.fallbackModel,
					(modelSpec) => reviewWithModel(modelSpec, config, action, ctx),
					() => notifyFallback(ctx, config.model, config.fallbackModel),
				);
			if (usedFallback && shouldFallbackReview(result)) {
				ctx.ui.notify(
					[
						"Guardian · primary and fallback reviewers both failed.",
						`Primary (${config.model}): ${reviewResultDiagnostic(primaryResult)}`,
						`Fallback (${config.fallbackModel}): ${reviewResultDiagnostic(result)}`,
					].join("\n"),
					"error",
				);
			}
			if (shouldFallbackReview(result)) {
				idleStatus = "Guardian · needs attention";
			} else if (!usedFallback && result.kind !== "cancelled") {
				const health = guardianHealth(config, ctx.modelRegistry);
				idleStatus = health.fallbackUnavailable
					? "Guardian · ready · fallback unavailable"
					: "Guardian · ready";
				fallbackNoticeKey = undefined;
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
				activeReviews > 0 ? reviewStatus(activeReviews) : idleStatus,
			);
		}
	}

	async function reviewWithModel(
		modelSpec: string,
		config: GuardianConfig,
		action: GuardianAction,
		ctx: ExtensionContext,
	): Promise<GuardianReviewResult> {
		try {
			const model = reviewerModelForSpec(modelSpec, ctx.modelRegistry);
			if (!model) {
				return {
					kind: "failure",
					message: `Reviewer model not found: ${modelSpec}.`,
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
				modelSpec,
				model: `${model.provider}/${model.id}`,
				primaryModel: config.model,
				fallbackModel: config.fallbackModel,
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
