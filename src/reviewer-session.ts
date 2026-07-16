// pi-lens-ignore: find-import-file-without-extension
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	createAgentSession,
	getAgentDir,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
// pi-lens-ignore: find-import-file-without-extension
import {
	GUARDIAN_REVIEW_MAX_ATTEMPTS,
	type GuardianReviewResult,
} from "./gate.ts";
import {
	buildGuardianPrompt,
	buildGuardianTranscript,
	parseGuardianAssessment,
	type GuardianAction,
	type GuardianMessage,
} from "./review.ts";

export type ReviewerModel = NonNullable<ReturnType<ModelRegistry["find"]>>;
export const OFFICIAL_AUTO_REVIEW_MODEL = "openai-codex/codex-auto-review";

type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

export function resolveReviewerModel(
	registry: ModelRegistry,
	provider: string,
	model: string,
): ReviewerModel | undefined {
	const registered = registry.find(provider, model);
	if (registered) return registered;
	if (provider !== "openai-codex" || model !== "codex-auto-review") return;

	const template =
		registry.find("openai-codex", "gpt-5.4-mini") ??
		registry.find("openai-codex", "gpt-5.4");
	if (!template) return;
	return {
		...template,
		id: "codex-auto-review",
		name: "Codex Auto Review",
		contextWindow: 272_000,
		maxTokens: 10_000,
	};
}

export interface ReviewerSessionOptions {
	model: ReviewerModel;
	modelRegistry: ModelRegistry;
	cwd: string;
	systemPrompt: string;
	timeoutMs: number;
	tools?: Array<"read" | "grep" | "find" | "ls">;
}

// Session lifecycle, retry, deadline, and transcript cursor state are cohesive here.
// pi-lens-ignore: large-class
export class ReviewerSessionController {
	// pi-lens-ignore: large-class
	private session?: AgentSession;
	private cursor = 0;
	private deliveredPrefix = "";
	private disposed = false;
	private readonly disposeController = new AbortController();
	private queue: Promise<void> = Promise.resolve();
	private readonly options: ReviewerSessionOptions;

	constructor(options: ReviewerSessionOptions) {
		this.options = options;
	}

	review(
		action: GuardianAction,
		messages: GuardianMessage[],
		parentSignal?: AbortSignal,
	): Promise<GuardianReviewResult> {
		const run = this.queue.then(() =>
			this.reviewSerialized(action, messages, parentSignal),
		);
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	dispose(): void {
		this.disposed = true;
		this.disposeController.abort();
		if (this.session?.isStreaming) void this.session.abort();
		this.resetSession();
	}

	private async reviewSerialized(
		action: GuardianAction,
		messages: GuardianMessage[],
		parentSignal?: AbortSignal,
	): Promise<GuardianReviewResult> {
		if (this.disposed) {
			return { kind: "cancelled", message: "Guardian reviewer was disposed." };
		}
		const reviewSignal = parentSignal
			? AbortSignal.any([parentSignal, this.disposeController.signal])
			: this.disposeController.signal;
		if (reviewSignal.aborted) {
			return { kind: "cancelled", message: "Guardian review was cancelled." };
		}

		let retryReason: string | undefined;
		const deadline = Date.now() + this.options.timeoutMs;
		for (let attempt = 1; attempt <= GUARDIAN_REVIEW_MAX_ATTEMPTS; attempt++) {
			const delta = this.selectTranscript(messages);
			const prompt = buildGuardianPrompt({
				action,
				transcript: buildGuardianTranscript(delta.messages),
				mode: delta.mode,
				retryReason,
			});
			const attemptResult = await this.runAttempt(
				prompt,
				Math.max(1, deadline - Date.now()),
				reviewSignal,
			);
			if (attemptResult.kind === "allowed" || attemptResult.kind === "denied") {
				this.cursor = messages.length;
				this.deliveredPrefix = snapshot(messages);
				return attemptResult;
			}
			if (attemptResult.kind === "cancelled") return attemptResult;
			if (
				attempt === GUARDIAN_REVIEW_MAX_ATTEMPTS ||
				!isRetryable(attemptResult) ||
				Date.now() >= deadline
			) {
				this.resetSession();
				this.cursor = 0;
				this.deliveredPrefix = "";
				return Date.now() >= deadline && attemptResult.kind === "failure"
					? { kind: "timeout", message: "Automatic approval review timed out." }
					: attemptResult;
			}

			retryReason = attemptResult.message;
			this.resetSession();
			this.cursor = 0;
			this.deliveredPrefix = "";
			const waitResult = await waitForRetry(attempt, deadline, reviewSignal);
			if (waitResult) return waitResult;
		}
		return { kind: "failure", message: "Guardian review failed unexpectedly." };
	}

	private selectTranscript(messages: GuardianMessage[]): {
		mode: "full" | "delta";
		messages: GuardianMessage[];
	} {
		if (
			this.session &&
			this.cursor <= messages.length &&
			snapshot(messages.slice(0, this.cursor)) === this.deliveredPrefix
		) {
			return { mode: "delta", messages: messages.slice(this.cursor) };
		}
		if (this.session) this.resetSession();
		this.cursor = 0;
		this.deliveredPrefix = "";
		return { mode: "full", messages };
	}

	private async runAttempt(
		prompt: string,
		timeoutMs: number,
		parentSignal?: AbortSignal,
	): Promise<GuardianReviewResult> {
		const startup = await this.getSessionBeforeDeadline(
			timeoutMs,
			parentSignal,
		);
		if ("kind" in startup) return startup;
		const session = startup.session;
		const remainingMs = Math.max(1, startup.deadline - Date.now());
		const promptResult = await promptBeforeDeadline(
			session,
			prompt,
			remainingMs,
			parentSignal,
		);
		if (promptResult) {
			this.resetSession();
			return promptResult;
		}

		const assistant = latestAssistantOutcome(session);
		if (assistant.error) {
			return {
				kind: "failure",
				message: `Reviewer provider error: ${assistant.error}`,
				retryable: assistant.retryable,
			};
		}
		if (!assistant.text) {
			return {
				kind: "failure",
				message: "Reviewer completed without an assessment payload.",
			};
		}
		try {
			const assessment = parseGuardianAssessment(assistant.text);
			return assessment.outcome === "allow"
				? { kind: "allowed", assessment }
				: { kind: "denied", assessment };
		} catch (error) {
			return {
				kind: "failure",
				message: safeError("Reviewer returned an invalid assessment", error),
				retryable: true,
			};
		}
	}

	private async getSessionBeforeDeadline(
		timeoutMs: number,
		parentSignal?: AbortSignal,
	): Promise<
		| { session: AgentSession; deadline: number }
		| Extract<
				GuardianReviewResult,
				{ kind: "timeout" | "cancelled" | "failure" }
		  >
	> {
		const deadline = Date.now() + timeoutMs;
		const sessionPromise = this.getSession();
		return new Promise((resolve) => {
			let settled = false;
			const finish = (
				result:
					| { session: AgentSession; deadline: number }
					| Extract<
							GuardianReviewResult,
							{ kind: "timeout" | "cancelled" | "failure" }
					  >,
			) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			};
			const discardLateSession = () => {
				void sessionPromise.then(
					(session) => {
						if (this.session === session) this.resetSession();
					},
					() => undefined,
				);
			};
			const timer = setTimeout(() => {
				discardLateSession();
				finish({
					kind: "timeout",
					message: "Automatic approval review timed out.",
				});
			}, timeoutMs);
			const onAbort = () => {
				discardLateSession();
				finish({
					kind: "cancelled",
					message: "Guardian review was cancelled.",
				});
			};
			const cleanup = () => {
				clearTimeout(timer);
				parentSignal?.removeEventListener("abort", onAbort);
			};
			parentSignal?.addEventListener("abort", onAbort, { once: true });
			void sessionPromise.then(
				(session) => finish({ session, deadline }),
				(error) =>
					finish({
						kind: "failure",
						message: safeError(
							"Guardian reviewer session failed to start",
							error,
						),
					}),
			);
			if (parentSignal?.aborted) onAbort();
		});
	}

	private async getSession(): Promise<AgentSession> {
		if (this.session) return this.session;
		if (this.disposed) throw new Error("reviewer controller is disposed");
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: this.options.cwd,
			agentDir: getAgentDir(),
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => this.options.systemPrompt,
			appendSystemPromptOverride: () => [],
		});
		await resourceLoader.reload();
		const created = await createAgentSession({
			cwd: this.options.cwd,
			authStorage: this.options.modelRegistry.authStorage,
			modelRegistry: this.options.modelRegistry,
			model: this.options.model,
			thinkingLevel: "low",
			tools: this.options.tools ?? ["read", "grep", "find", "ls"],
			resourceLoader,
			sessionManager: SessionManager.inMemory(this.options.cwd),
			settingsManager,
		});
		if (this.disposed) {
			created.session.dispose();
			throw new Error("reviewer controller was disposed during startup");
		}
		this.session = created.session;
		return created.session;
	}

	private resetSession(): void {
		const session = this.session;
		this.session = undefined;
		session?.dispose();
	}
}

export function promptBeforeDeadline(
	session: AgentSession,
	prompt: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<
	| Extract<GuardianReviewResult, { kind: "timeout" | "cancelled" | "failure" }>
	| undefined
> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (
			result:
				| Extract<
						GuardianReviewResult,
						{ kind: "timeout" | "cancelled" | "failure" }
				  >
				| undefined,
		) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};
		const abortAndFinish = (
			result: Extract<GuardianReviewResult, { kind: "timeout" | "cancelled" }>,
		) => {
			void session.abort();
			finish(result);
		};
		const timer = setTimeout(
			() =>
				abortAndFinish({
					kind: "timeout",
					message: "Automatic approval review timed out.",
				}),
			timeoutMs,
		);
		const onAbort = () =>
			abortAndFinish({
				kind: "cancelled",
				message: "Guardian review was cancelled.",
			});
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		void session.prompt(prompt).then(
			() => finish(undefined),
			(error) =>
				finish({
					kind: "failure",
					message: safeError("Automatic approval review failed", error),
				}),
		);
		if (signal?.aborted) onAbort();
	});
}

function latestAssistantOutcome(session: AgentSession): {
	text?: string;
	error?: string;
	retryable?: boolean;
} {
	let message: AgentSession["messages"][number] | undefined;
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const candidate = session.messages[index];
		if (candidate.role !== "assistant") continue;
		message = candidate;
		break;
	}
	if (!message || message.role !== "assistant") return {};
	if (message.stopReason === "error") {
		return {
			error: message.errorMessage || "unknown provider error",
			retryable: isRetryableAssistantError(message),
		};
	}
	const text = message.content
		.flatMap((content) => (content.type === "text" ? [content.text] : []))
		.join("\n");
	return text ? { text } : {};
}

function snapshot(messages: GuardianMessage[]): string {
	return JSON.stringify(messages);
}

function safeError(prefix: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `${prefix}: ${message}`;
}

function isRetryable(result: GuardianReviewResult): boolean {
	if (result.kind !== "failure") return false;
	return result.retryable === true;
}

async function waitForRetry(
	attempt: number,
	deadline: number,
	parentSignal?: AbortSignal,
): Promise<GuardianReviewResult | undefined> {
	const baseDelay = 200 * 2 ** Math.max(0, attempt - 1);
	const jitter = 0.9 + Math.random() * 0.2;
	const delay = Math.min(
		Math.round(baseDelay * jitter),
		Math.max(0, deadline - Date.now()),
	);
	if (delay <= 0) {
		return { kind: "timeout", message: "Automatic approval review timed out." };
	}
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve(
				Date.now() >= deadline
					? { kind: "timeout", message: "Automatic approval review timed out." }
					: undefined,
			);
		}, delay);
		const onAbort = () => {
			cleanup();
			resolve({ kind: "cancelled", message: "Guardian review was cancelled." });
		};
		const cleanup = () => {
			clearTimeout(timer);
			parentSignal?.removeEventListener("abort", onAbort);
		};
		parentSignal?.addEventListener("abort", onAbort, { once: true });
		if (parentSignal?.aborted) onAbort();
	});
}
