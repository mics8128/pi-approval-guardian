import { resolveGuardianPath } from "./gate.ts";
import type { GuardianAction } from "./review.ts";
import {
	decideGuardianAction,
	guardianInputIdentity,
	snapshotGuardianJson,
	type NormalizedGuardianAction,
} from "./shared-decision.ts";

const NORMALIZED_PAYLOAD_CHARS = 64_000;

export type {
	GuardianDecisionAudit,
	GuardianDecisionServices,
	NormalizedGuardianAction,
	NormalizedGuardianDecision,
} from "./shared-decision.ts";
export { decideGuardianAction, guardianInputIdentity } from "./shared-decision.ts";

/** Pi host adapter: convert every classified Pi tool call to the shared decision contract. */
export function normalizePiToolAction(
	action: GuardianAction,
	input: unknown,
): NormalizedGuardianAction {
	const bounded = boundedPayload(action);
	const privacy = {
		privateDataRead: bounded.value.private_data_read === true,
	};
	return {
		host: "pi",
		tool: action.tool,
		operation: operationFor(action.tool),
		payload: bounded.value,
		cwd: resolveGuardianPath(".", action.cwd).projectRoot,
		reviewReasons: reviewReasonsFor(
			action.tool,
			bounded.value,
			privacy.privateDataRead,
		),
		privacy,
		payloadState: {
			complete: bounded.complete,
			originalChars: bounded.originalChars,
			retainedChars: bounded.retainedChars,
		},
		inputIdentity: normalizedInputIdentity(input),
	};
}

function boundedPayload(action: GuardianAction): {
	value: Record<string, unknown>;
	complete: boolean;
	originalChars: number;
	retainedChars: number;
} {
	let payload: Record<string, unknown>;
	try {
		payload = snapshotGuardianJson(action.payload);
	} catch {
		return { value: {}, complete: false, originalChars: 0, retainedChars: 0 };
	}
	if (action.tool === "bash") {
		const command = String(payload.command ?? "");
		if (command.length <= NORMALIZED_PAYLOAD_CHARS) {
			return {
				value: payload,
				complete: true,
				originalChars: command.length,
				retainedChars: command.length,
			};
		}
		const marker = "<guardian_action_truncated />";
		const retained = Math.max(0, NORMALIZED_PAYLOAD_CHARS - marker.length);
		const prefix = Math.floor(retained / 2);
		return {
			value: {
				...payload,
				command: `${command.slice(0, prefix)}${marker}${command.slice(command.length - (retained - prefix))}`,
			},
			complete: false,
			originalChars: command.length,
			retainedChars: NORMALIZED_PAYLOAD_CHARS,
		};
	}
	const serialized = JSON.stringify(payload);
	return {
		value: payload,
		complete: true,
		originalChars: serialized.length,
		retainedChars: serialized.length,
	};
}

function operationFor(tool: string): string {
	switch (tool) {
		case "bash": return "execute";
		case "read": return "read";
		case "grep": return "search";
		case "find": return "find";
		case "ls": return "list";
		case "write": return "write";
		case "edit": return "edit";
		default: return "invoke";
	}
}

function reviewReasonsFor(
	tool: string,
	payload: Record<string, unknown>,
	privateDataRead: boolean,
): string[] {
	if (tool === "bash") {
		return [
			"bash.command configured for review",
			...(privateDataRead ? ["private data read"] : []),
		];
	}
	const classified = Array.isArray(payload.review_reasons)
		? payload.review_reasons.filter(
				(reason): reason is string => typeof reason === "string",
			)
		: [];
	return [
		`${tool} classified for review`,
		...classified,
		...(privateDataRead && !classified.includes("private data read")
			? ["private data read"]
			: []),
	];
}

function normalizedInputIdentity(input: unknown): string {
	try {
		return guardianInputIdentity(input);
	} catch {
		return "invalid";
	}
}
