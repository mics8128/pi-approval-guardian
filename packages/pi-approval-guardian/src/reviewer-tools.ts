// pi-lens-ignore: find-import-file-without-extension
import {
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	type CreateAgentSessionOptions,
	type ToolCallEvent,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ReviewLevel } from "./config.ts";
import { actionFromToolCall } from "./tool-actions.ts";

export type ReviewerToolName = "read" | "grep" | "find" | "ls";

export const DEFAULT_REVIEWER_TOOLS: readonly ReviewerToolName[] = [
	"read",
	"grep",
	"find",
	"ls",
];

const REVIEWER_PRIVATE_READ_RULES: Record<string, ReviewLevel> = {
	"read.path": "private-only",
	"grep.path": "private-only",
	"find.path": "private-only",
	"ls.path": "private-only",
};

const PRIVATE_INVESTIGATION_ERROR =
	"Reviewer investigation blocked because the requested scope may contain private local data.";

export function reviewerInvestigationTouchesPrivateData(
	toolName: ReviewerToolName,
	input: Record<string, unknown>,
	cwd: string,
): boolean {
	const action = actionFromToolCall(
		{
			toolName,
			toolCallId: "guardian-reviewer-investigation",
			input,
		} as ToolCallEvent,
		cwd,
		REVIEWER_PRIVATE_READ_RULES,
	);
	return action?.payload.private_data_read === true;
}

function guardReviewerTool(
	definition: ToolDefinition<any, any, any>,
	cwd: string,
): ToolDefinition<any, any, any> {
	const execute = definition.execute;
	return {
		...definition,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (
				reviewerInvestigationTouchesPrivateData(
					definition.name as ReviewerToolName,
					params as Record<string, unknown>,
					cwd,
				)
			) {
				throw new Error(PRIVATE_INVESTIGATION_ERROR);
			}
			return execute(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}

export function createReviewerToolDefinitions(
	cwd: string,
	toolNames: readonly ReviewerToolName[] = DEFAULT_REVIEWER_TOOLS,
): ToolDefinition[] {
	const definitions: Record<ReviewerToolName, ToolDefinition<any, any, any>> = {
		read: createReadToolDefinition(cwd),
		grep: createGrepToolDefinition(cwd),
		find: createFindToolDefinition(cwd),
		ls: createLsToolDefinition(cwd),
	};
	return toolNames.map((toolName) =>
		guardReviewerTool(definitions[toolName], cwd),
	);
}

export function reviewerToolSessionOptions(
	cwd: string,
	toolNames: readonly ReviewerToolName[] = DEFAULT_REVIEWER_TOOLS,
): Pick<CreateAgentSessionOptions, "tools" | "noTools" | "customTools"> {
	if (toolNames.length === 0) {
		return { tools: [], noTools: "all" };
	}
	return {
		tools: [...toolNames],
		noTools: "builtin",
		customTools: createReviewerToolDefinitions(cwd, toolNames),
	};
}
