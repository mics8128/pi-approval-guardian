import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GuardianConfig } from "./config.ts";
import type { GuardianReviewResult } from "./gate.ts";
import { parseModelSpec } from "./review.ts";
import {
	resolveReviewerModel,
	type ReviewerModel,
} from "./reviewer-session.ts";

export type ReviewerChannelRole =
	| "primary"
	| "configured-fallback"
	| "current-model";

export interface ReviewerChannel {
	role: ReviewerChannelRole;
	modelSpec: string;
	model?: ReviewerModel;
}

export interface GuardianHealth {
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

export function modelSpecFor(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

export function reviewerChannelForSpec(
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

export function currentReviewerChannel(
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

export function reviewerChannelIdentity(channel: ReviewerChannel): string {
	return channel.model ? modelSpecFor(channel.model) : channel.modelSpec;
}

export function buildReviewerChannels(
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

export function reviewerChannelLabel(role: ReviewerChannelRole): string {
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
		if (index > 0) onFallback(distinctChannels[index - 1], channel);
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
