import type {
	GuardianAction,
	GuardianAssessment,
} from "./review.ts";
import type { GuardianReviewResult } from "./gate.ts";

export function rejectionReason(
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

export function formatReviewResult(
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

export function reviewResultDiagnostic(result: GuardianReviewResult): string {
	if (result.kind === "failure" || result.kind === "timeout") {
		return singleLine(result.message);
	}
	return result.kind;
}

export function formatDuration(timeoutMs: number): string {
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
