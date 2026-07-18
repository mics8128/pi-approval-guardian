import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadGuardianConfig } from "./config.ts";
import { formatDuration } from "./review-presentation.ts";
import {
	buildReviewerChannels,
	currentReviewerChannel,
	guardianHealth,
	reviewerChannelForSpec,
	reviewerChannelIdentity,
	reviewerChannelLabel,
	type ReviewerChannel,
} from "./reviewer-channels.ts";

export interface GuardianStatusCallbacks {
	syncConfigurationWarnings: (
		ctx: ExtensionContext,
		warnings: string[],
	) => void;
	notifyReviewerSwitch: (
		ctx: ExtensionContext,
		from: ReviewerChannel,
		to: ReviewerChannel,
	) => void;
}

export function syncGuardianRuntimeHealth(
	ctx: ExtensionContext,
	callbacks: GuardianStatusCallbacks,
): void {
	const config = loadGuardianConfig({
		cwd: ctx.cwd,
		projectTrusted: ctx.isProjectTrusted(),
	});
	callbacks.syncConfigurationWarnings(ctx, config.warnings);
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
		if (selected) callbacks.notifyReviewerSwitch(ctx, channels[0], selected);
	}
	if (!health.selectedFallback && health.reason) {
		ctx.ui.notify(health.reason, "warning");
	}
}

export async function showGuardianConfiguration(
	args: string,
	ctx: ExtensionCommandContext,
	temporaryBypassActive: boolean,
	callbacks: GuardianStatusCallbacks,
): Promise<void> {
	const projectTrusted = ctx.isProjectTrusted();
	const config = loadGuardianConfig({ cwd: ctx.cwd, projectTrusted });
	callbacks.syncConfigurationWarnings(ctx, config.warnings);
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
	const operationalLabel = !ready
		? "needs attention"
		: selectedChannel?.role === "current-model"
			? "ready via current model"
			: selectedChannel?.role === "configured-fallback"
				? "ready via configured fallback"
				: degradedFallback
					? "ready · fallback unavailable"
					: "ready";
	const summaryLabel = `${
		temporaryBypassActive
			? `BYPASSED · underlying ${operationalLabel}`
			: operationalLabel
	}${config.warnings.length > 0 ? " · config warnings" : ""}`;
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
	if (selectedChannel && selectedIndex > 0 && !temporaryBypassActive) {
		callbacks.notifyReviewerSwitch(
			ctx,
			channels[selectedIndex - 1],
			selectedChannel,
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
			`Approval Guardian · ${summaryLabel} · ${temporaryBypassActive ? "reviews disabled" : "fail-closed"}`,
			temporaryBypassActive
				? "Temporary bypass: active; covered agent tool calls are not being reviewed. Run /approval-guardian enable to restore protection."
				: "Temporary bypass: inactive",
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
		temporaryBypassActive ||
			!ready ||
			degradedFallback ||
			config.warnings.length > 0
			? "warning"
			: "info",
	);
}
