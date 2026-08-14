import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isProxy } from "node:util/types";
import {
	analyzeIpythonCapabilities,
	failedIpythonCapabilityAnalysis,
	IPYTHON_ANALYSIS_UNCERTAINTIES,
	IPYTHON_CAPABILITY_INDICATORS,
	type IpythonCapabilityAnalysis,
} from "./capability-analysis.ts";
import {
	guardianInputIdentity,
	type NormalizedGuardianAction,
} from "./shared-decision.ts";

const MAX_CELL_CHARS = 64_000;

export type {
	GuardianAssessment,
	GuardianDecisionAudit,
	GuardianDecisionServices,
	GuardianReviewResult,
	NormalizedGuardianAction,
	NormalizedGuardianDecision,
} from "./shared-decision.ts";
export {
	decideGuardianAction,
	guardianInputIdentity,
} from "./shared-decision.ts";

export function normalizePrimeIpythonAction(
	input: unknown,
	cwd: string,
): NormalizedGuardianAction | undefined {
	if (!isPlainCodeInput(input)) return;
	const code = input.code;
	const complete = code.length <= MAX_CELL_CHARS;
	return {
		host: "prime",
		tool: "ipython",
		operation: "execute-cell",
		payload: { code: complete ? code : code.slice(0, MAX_CELL_CHARS) },
		cwd: canonicalCwd(cwd),
		reviewReasons: ["all Prime IPython cells require whole-cell review"],
		privacy: { privateDataRead: false },
		payloadState: {
			complete,
			originalChars: code.length,
			retainedChars: Math.min(code.length, MAX_CELL_CHARS),
		},
		inputIdentity: safeIdentity(input),
		capabilityAnalysis: safeCapabilityAnalysis(code),
	};
}

function safeIdentity(input: unknown): string {
	try {
		return guardianInputIdentity(input);
	} catch {
		return "invalid";
	}
}

function canonicalCwd(cwd: string): string {
	const absolute = resolve(cwd);
	try {
		return realpathSync(absolute);
	} catch {
		return absolute;
	}
}

function isPlainCodeInput(input: unknown): input is { code: string } {
	if (
		typeof input !== "object" ||
		input === null ||
		isProxy(input) ||
		Object.getPrototypeOf(input) !== Object.prototype
	) {
		return false;
	}
	const keys = Reflect.ownKeys(input);
	if (keys.length !== 1 || keys[0] !== "code") return false;
	const descriptor = Object.getOwnPropertyDescriptor(input, "code");
	return (
		!!descriptor &&
		"value" in descriptor &&
		descriptor.enumerable === true &&
		typeof descriptor.value === "string"
	);
}

function safeCapabilityAnalysis(code: string): IpythonCapabilityAnalysis {
	try {
		return sanitizeIpythonCapabilityAnalysis(code.length, analyzeIpythonCapabilities(code));
	} catch {
		return failedIpythonCapabilityAnalysis(code.length);
	}
}

// This adapter accepts data, never executable caller code. It snapshots only
// bounded own data properties and is exported for adversarial contract tests;
// it is not part of the extension entry point.
export function sanitizeIpythonCapabilityAnalysis(inputChars: number, candidate: unknown): IpythonCapabilityAnalysis {
	try {
		if (typeof candidate !== "object" || candidate === null || Object.getPrototypeOf(candidate) !== Object.prototype) throw new Error("invalid analysis");
		const indicators = snapshotClosedArray(candidate, "indicators", IPYTHON_CAPABILITY_INDICATORS);
		const uncertainties = snapshotClosedArray(candidate, "uncertainties", IPYTHON_ANALYSIS_UNCERTAINTIES);
		const authority = ownData(candidate, "authority");
		const findings = ownData(candidate, "findings");
		const aliasesExamined = ownData(candidate, "aliasesExamined");
		if (authority !== "advisory") throw new Error("invalid authority");
		if (!Number.isInteger(findings) || findings !== indicators.length) throw new Error("invalid finding count");
		if (!Number.isInteger(aliasesExamined) || (aliasesExamined as number) < 0 || (aliasesExamined as number) > 64) throw new Error("invalid alias count");
		return { authority, indicators, uncertainties, findings: findings as number, aliasesExamined: aliasesExamined as number, inputChars };
	} catch {
		return failedIpythonCapabilityAnalysis(inputChars);
	}
}

function snapshotClosedArray<const T extends readonly string[]>(object: object, key: string, vocabulary: T): T[number][] {
	const value = ownData(object, key);
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error("invalid array");
	const length = ownData(value, "length");
	if (!Number.isInteger(length) || (length as number) < 0 || (length as number) > vocabulary.length) throw new Error("invalid array length");
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.length !== (length as number) + 1 || ownKeys.some((entry) => typeof entry === "symbol")) throw new Error("invalid array shape");
	const allowed = new Set<string>(vocabulary);
	const seen = new Set<string>();
	const snapshot: T[number][] = [];
	for (let index = 0; index < (length as number); index++) {
		const entry = ownData(value, String(index));
		if (typeof entry !== "string" || !allowed.has(entry) || seen.has(entry)) throw new Error("invalid array entry");
		seen.add(entry);
		snapshot.push(entry as T[number]);
	}
	return snapshot;
}

function ownData(object: object, key: PropertyKey): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	if (!descriptor || !("value" in descriptor)) throw new Error("missing data property");
	return descriptor.value;
}

export { analyzeIpythonCapabilities } from "./capability-analysis.ts";
export type { IpythonCapabilityAnalysis, IpythonCapabilityIndicator, IpythonAnalysisUncertainty } from "./capability-analysis.ts";
