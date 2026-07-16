import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import {
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadGuardianConfig } from "../src/config.ts";
import {
	buildGuardianPrompt,
	buildGuardianTranscript,
	GUARDIAN_POLICY,
	parseGuardianAssessment,
	parseModelSpec,
	type GuardianAssessment,
	type GuardianMessage,
} from "../src/review.ts";

export default function codexGuardian(pi: ExtensionAPI) {
	let activeReviews = 0;

	pi.registerCommand("codex-guardian", {
		description: "Show the Codex-style automatic bash reviewer configuration",
		handler: async (_args, ctx) => {
			const config = loadGuardianConfig({
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
			});
			const parsed = parseModelSpec(config.model);
			const model = parsed
				? ctx.modelRegistry.find(parsed.provider, parsed.model)
				: undefined;
			ctx.ui.notify(
				[
					"Codex Guardian is enabled and fail-closed.",
					`Reviewer model: ${config.model}`,
					`Model available: ${model ? "yes" : "no"}`,
					`Timeout: ${config.timeoutMs}ms`,
					`Global config: ${config.globalPath}`,
					`Project config: ${config.projectConfigLoaded ? config.projectPath : "not loaded"}`,
					`Additional policy: ${config.policy ? "configured" : "none"}`,
					...config.warnings,
				].join("\n"),
				model && config.warnings.length === 0 ? "info" : "warning",
			);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const command = event.input.command;
		const result = await reviewCommand(command, ctx);
		if (result.outcome === "allow") {
			ctx.ui.notify(formatDecision("approved", command, result), "info");
			return;
		}
		const reason = rejectionReason(result);
		ctx.ui.notify(formatDecision("denied", command, result), "error");
		return { block: true, reason };
	});

	async function reviewCommand(
		command: string,
		ctx: ExtensionContext,
	): Promise<GuardianAssessment> {
		activeReviews++;
		ctx.ui.setStatus("codex-guardian", `reviewing bash (${activeReviews})`);
		try {
			const config = loadGuardianConfig({
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
			});
			const spec = parseModelSpec(config.model);
			if (!spec)
				return failedClosed(`Invalid reviewer model ${config.model}; expected provider/model.`);
			const model = ctx.modelRegistry.find(spec.provider, spec.model);
			if (!model) {
				return failedClosed(
					`Reviewer model not found: ${spec.provider}/${spec.model}.`,
				);
			}
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok)
				return failedClosed(`Reviewer authentication failed: ${auth.error}`);
			if (!auth.apiKey)
				return failedClosed(
					`No API key available for reviewer provider ${model.provider}.`,
				);

			const messages = collectBranchMessages(ctx);
			const transcript = buildGuardianTranscript(messages);
			const prompt = buildGuardianPrompt({ command, cwd: ctx.cwd, transcript });
			const systemPrompt = config.policy
				? `${GUARDIAN_POLICY}\n\nAdditional organization policy:\n${config.policy}`
				: GUARDIAN_POLICY;
			const timeout = AbortSignal.timeout(config.timeoutMs);
			const signal = ctx.signal
				? AbortSignal.any([ctx.signal, timeout])
				: timeout;
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: prompt }],
				timestamp: Date.now(),
			};
			const response = await complete(
				model,
				{ systemPrompt, messages: [userMessage] },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					maxTokens: 1024,
					signal,
				},
			);
			if (response.stopReason === "aborted") {
				return failedClosed(
					timeout.aborted
						? "Automatic approval review timed out."
						: "Automatic approval review was cancelled.",
				);
			}
			if (response.stopReason === "error") {
				return failedClosed(
					response.errorMessage || "Reviewer model returned an error.",
				);
			}
			const text = response.content
				.filter(
					(content): content is { type: "text"; text: string } =>
						content.type === "text",
				)
				.map((content) => content.text)
				.join("\n");
			return parseGuardianAssessment(text);
		} catch (error) {
			return failedClosed(
				`Automatic approval review failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			activeReviews--;
			ctx.ui.setStatus(
				"codex-guardian",
				activeReviews > 0 ? `reviewing bash (${activeReviews})` : undefined,
			);
		}
	}
}

function collectBranchMessages(ctx: ExtensionContext): GuardianMessage[] {
	return ctx.sessionManager.getBranch().flatMap((entry) => {
		if (entry.type !== "message") return [];
		return [entry.message as GuardianMessage];
	});
}

function failedClosed(rationale: string): GuardianAssessment {
	return {
		risk_level: "high",
		user_authorization: "unknown",
		outcome: "deny",
		rationale,
	};
}

function rejectionReason(result: GuardianAssessment): string {
	return [
		"This action was rejected by the automatic Codex-style approval reviewer.",
		`Risk: ${result.risk_level}; user authorization: ${result.user_authorization}.`,
		`Reason: ${result.rationale}`,
		"Do not retry through a workaround or indirect command. Use a materially safer alternative or ask the user to explicitly approve the exact risk.",
	].join("\n");
}

function formatDecision(
	verdict: "approved" | "denied",
	command: string,
	result: GuardianAssessment,
): string {
	const preview =
		command.length > 160 ? `${command.slice(0, 157)}...` : command;
	return `Codex Guardian ${verdict} (${result.risk_level}, authorization ${result.user_authorization})\n${preview}\n${result.rationale}`;
}
