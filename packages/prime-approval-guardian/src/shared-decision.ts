import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

export type GuardianRiskLevel = "low" | "medium" | "high" | "critical";
export type GuardianUserAuthorization = "unknown" | "low" | "medium" | "high";

export interface GuardianAssessment {
	risk_level: GuardianRiskLevel;
	user_authorization: GuardianUserAuthorization;
	outcome: "allow" | "deny";
	rationale: string;
}

export type GuardianReviewResult =
	| { kind: "allowed"; assessment: GuardianAssessment }
	| { kind: "denied"; assessment: GuardianAssessment }
	| { kind: "timeout" | "cancelled" | "circuit-open"; message: string }
	| { kind: "failure"; message: string; retryable?: boolean };

export interface NormalizedGuardianAction {
	host: "pi" | "prime";
	tool: string;
	operation: string;
	payload: Record<string, unknown>;
	cwd: string;
	reviewReasons: string[];
	privacy: { privateDataRead: boolean };
	payloadState: {
		complete: boolean;
		originalChars: number;
		retainedChars: number;
	};
	inputIdentity: string;
	capabilityAnalysis?: {
		authority: "advisory";
		indicators: Array<
			| "filesystem"
			| "process"
			| "shell-magic"
			| "network"
			| "deployment"
			| "skill"
			| "rlm-subagent"
			| "dynamic-execution"
		>;
		uncertainties: Array<
			| "unknown"
			| "dynamic"
			| "unsupported"
			| "truncated"
			| "failure"
		>;
		findings: number;
		aliasesExamined: number;
		inputChars: number;
	};
}

export interface GuardianDecisionAudit {
	host: NormalizedGuardianAction["host"];
	tool: string;
	operation: string;
	inputIdentity: string;
	outcome: GuardianReviewResult["kind"];
}

export interface NormalizedGuardianDecision {
	verdict: "allow" | "block";
	result: GuardianReviewResult;
	audit: GuardianDecisionAudit;
}

export interface GuardianDecisionServices {
	isCircuitOpen(): boolean;
	review(action: NormalizedGuardianAction): Promise<GuardianReviewResult>;
	protectInput(expectedInputIdentity: string): void;
	recordCircuitOutcome(adverse: boolean): void;
}

export async function decideGuardianAction(
	action: NormalizedGuardianAction,
	services: GuardianDecisionServices,
): Promise<NormalizedGuardianDecision> {
	let result: GuardianReviewResult;
	if (services.isCircuitOpen()) {
		result = {
			kind: "circuit-open",
			message: "Repeated adverse Guardian outcomes reached the per-turn limit.",
		};
	} else if (!inputIdentityIsValid(action.inputIdentity)) {
		result = {
			kind: "failure",
			message:
				"Normalized action input identity could not be computed safely; approval review was not attempted.",
		};
	} else if (!action.payloadState.complete) {
		result = {
			kind: "failure",
			message:
				"Normalized action payload exceeded its safety limit and is incomplete; approval review was not attempted.",
		};
	} else {
		try {
			result = enforceNormalizedActionRequirements(action, await services.review(action));
		} catch (error) {
			result = {
				kind: "failure",
				message: `Automatic approval review failed: ${safeError(error)}`,
			};
		}
	}
	if (result.kind !== "circuit-open") {
		if (result.kind === "allowed") {
			try {
				services.protectInput(action.inputIdentity);
			} catch (error) {
				result = {
					kind: "failure",
					message: `Approved tool input could not be locked safely: ${safeError(error)}`,
				};
			}
		}
		const adverse = circuitOutcomeForReview(result);
		if (adverse !== undefined) services.recordCircuitOutcome(adverse);
	}
	return {
		verdict: result.kind === "allowed" ? "allow" : "block",
		result,
		audit: {
			host: action.host,
			tool: action.tool,
			operation: action.operation,
			inputIdentity: action.inputIdentity,
			outcome: result.kind,
		},
	};
}

function enforceNormalizedActionRequirements(
	action: Pick<NormalizedGuardianAction, "payload" | "privacy">,
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
		rationale = "High-risk actions require at least medium user authorization.";
	} else if (action.privacy.privateDataRead && authorization !== "high") {
		rationale =
			"The private-data read lacks explicit high user authorization. Explain the exact source and purpose, then wait for the user to authorize it in conversation before retrying.";
	}
	if (!rationale) return result;
	return {
		kind: "denied",
		assessment: { ...result.assessment, outcome: "deny", rationale },
	};
}

export function guardianInputIdentity(value: unknown): string {
	const snapshot = snapshotGuardianJson(value);
	const canonical = canonicalJson(snapshot);
	return `sha256:${createHash("sha256")
		.update(canonical, "utf8")
		.digest("hex")}`;
}

/** Create a getter-free JSON snapshot without invoking proxy traps or iterators. */
export function snapshotGuardianJson<T>(value: T): T {
	return cloneJson(value, new WeakSet<object>(), new WeakSet<object>()) as T;
}

function cloneJson(
	value: unknown,
	active: WeakSet<object>,
	seen: WeakSet<object>,
): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("non-finite input number");
		return value;
	}
	if (typeof value !== "object") throw new Error(`non-JSON input ${typeof value}`);
	if (isProxy(value)) throw new Error("proxy input is not supported");
	if (active.has(value)) throw new Error("cyclic input");
	if (seen.has(value)) throw new Error("repeated input reference");
	active.add(value);
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype) {
				throw new Error("input array has a custom prototype");
			}
			const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
			if (keys.length !== value.length) throw new Error("invalid input array shape");
			const clone: unknown[] = [];
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
					throw new Error("invalid input array entry");
				}
				clone.push(cloneJson(descriptor.value, active, seen));
			}
			return clone;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error("input is not a plain object");
		}
		const keys = Reflect.ownKeys(value);
		if (keys.some((key) => typeof key === "symbol")) {
			throw new Error("symbol-keyed input property");
		}
		const clone: Record<string, unknown> = prototype === null
			? Object.create(null) as Record<string, unknown>
			: {};
		for (const key of keys as string[]) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
				throw new Error("invalid input property");
			}
			Object.defineProperty(clone, key, {
				value: cloneJson(descriptor.value, active, seen),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return clone;
	} finally {
		active.delete(value);
	}
}

function inputIdentityIsValid(value: string): boolean {
	return /^sha256:[a-f0-9]{64}$/.test(value);
}

function circuitOutcomeForReview(
	result: GuardianReviewResult,
): boolean | undefined {
	if (result.kind === "allowed" || result.kind === "cancelled") return false;
	if (
		result.kind === "denied" ||
		result.kind === "timeout" ||
		result.kind === "failure"
	) {
		return true;
	}
	return undefined;
}

function safeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function canonicalJson(
	value: unknown,
	active = new WeakSet<object>(),
	seen = new WeakSet<object>(),
): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("non-finite input number");
		return Object.is(value, -0) ? "-0" : JSON.stringify(value);
	}
	if (typeof value !== "object") throw new Error(`non-JSON input ${typeof value}`);
	if (isProxy(value)) throw new Error("proxy input is not supported");
	if (active.has(value)) throw new Error("cyclic input");
	if (seen.has(value)) throw new Error("repeated input reference");
	active.add(value);
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype) {
				throw new Error("input array has a custom prototype");
			}
			const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
			if (keys.length !== value.length) throw new Error("invalid input array shape");
			const entries: string[] = [];
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
					throw new Error("invalid input array entry");
				}
				entries.push(canonicalJson(descriptor.value, active, seen));
			}
			return `[${entries.join(",")}]`;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error("input is not a plain object");
		}
		const keys = Reflect.ownKeys(value);
		if (keys.some((key) => typeof key === "symbol")) {
			throw new Error("symbol-keyed input property");
		}
		return `{${(keys as string[])
			.sort()
			.map((key) => {
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
					throw new Error("invalid input property");
				}
				return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, active, seen)}`;
			})
			.join(",")}}`;
	} finally {
		active.delete(value);
	}
}
