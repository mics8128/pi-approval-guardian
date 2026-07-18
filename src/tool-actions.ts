// pi-lens-ignore: find-import-file-without-extension
import {
	isToolCallEventType,
	type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { ReviewLevel } from "./config.ts";
import type { DirectoryScanCache } from "./directory-scan-cache.ts";
import {
	classifyMutationPath,
	classifyReadPath,
	directoryMayContainPrivatePath,
	shouldReviewPath,
	type GuardianReviewResult,
} from "./gate.ts";
import type { GuardianAction } from "./review.ts";
import {
	commandReferencesPrivateData,
	looksLikePrivateGlob,
} from "./shell-private-data.ts";

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
	directoryScanCache?: DirectoryScanCache,
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
		return pathReadAction(
			"read",
			event.input,
			cwd,
			rules["read.path"],
			directoryScanCache,
		);
	}
	if (isToolCallEventType("grep", event)) {
		return pathReadAction(
			"grep",
			{ ...event.input, path: event.input.path || "." },
			cwd,
			rules["grep.path"],
			directoryScanCache,
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
		directoryScanCache,
	);
}

function pathReadAction(
	tool: string,
	input: Record<string, unknown>,
	cwd: string,
	level: ReviewLevel = "private-only",
	directoryScanCache?: DirectoryScanCache,
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
			10_000,
			directoryScanCache,
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

const DIRECTORY_SCAN_CACHE_SAFE_TOOLS = new Set(["read", "grep", "find", "ls"]);

export function shouldInvalidateDirectoryScanCache(toolName: string): boolean {
	return !DIRECTORY_SCAN_CACHE_SAFE_TOOLS.has(toolName);
}
