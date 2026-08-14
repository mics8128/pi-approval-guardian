import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_REVIEWER_MODEL,
	REVIEW_TIMEOUT_MS,
	parseModelSpec,
} from "./review.ts";

export const MODEL_ENV = "PI_APPROVAL_GUARDIAN_MODEL";
export const FALLBACK_MODEL_ENV = "PI_APPROVAL_GUARDIAN_FALLBACK_MODEL";
export const POLICY_ENV = "PI_APPROVAL_GUARDIAN_POLICY";
export const TIMEOUT_ENV = "PI_APPROVAL_GUARDIAN_TIMEOUT_MS";
export const CONFIG_FILE_NAME = "approval-guardian.json";

export type ReviewLevel =
	| "always"
	| "outside-or-private"
	| "private-only"
	| "off";

export const DEFAULT_REVIEW_RULES: Readonly<Record<string, ReviewLevel>> = {
	"bash.command": "always",
	"read.path": "private-only",
	"grep.path": "outside-or-private",
	"find.path": "private-only",
	"ls.path": "private-only",
	"write.path": "outside-or-private",
	"edit.path": "outside-or-private",
};

interface GuardianConfigFile {
	model?: unknown;
	fallbackModel?: unknown;
	timeoutMs?: unknown;
	policy?: unknown;
	review?: unknown;
}

type ConfigSource = "environment" | "project" | "global" | "default";

export interface GuardianConfig {
	model: string;
	fallbackModel: string;
	timeoutMs: number;
	policy?: string;
	review: Record<string, ReviewLevel>;
	globalPath: string;
	projectPath: string;
	globalConfigPresent: boolean;
	projectConfigPresent: boolean;
	modelSource: ConfigSource;
	fallbackModelSource: ConfigSource;
	timeoutSource: ConfigSource;
	policySources: Array<"environment" | "project" | "global">;
	warnings: string[];
}

export interface LoadGuardianConfigOptions {
	cwd: string;
	projectTrusted: boolean;
	agentDir?: string;
	env?: NodeJS.ProcessEnv;
}

export function loadGuardianConfig(
	options: LoadGuardianConfigOptions,
): GuardianConfig {
	const agentDir = options.agentDir ?? getAgentDir();
	const env = options.env ?? process.env;
	const globalPath = join(agentDir, CONFIG_FILE_NAME);
	const projectPath = join(options.cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
	const warnings: string[] = [];
	if (env[MODEL_ENV] !== undefined && !isModelSpecString(env[MODEL_ENV])) {
		warnings.push(`Invalid ${MODEL_ENV}: expected provider/model-id.`);
	}
	if (
		env[FALLBACK_MODEL_ENV] !== undefined &&
		!isModelSpecString(env[FALLBACK_MODEL_ENV])
	) {
		warnings.push(
			`Invalid ${FALLBACK_MODEL_ENV}: expected provider/model-id.`,
		);
	}
	if (
		env[TIMEOUT_ENV] !== undefined &&
		firstTimeout(env[TIMEOUT_ENV]) === undefined
	) {
		warnings.push(
			`Invalid ${TIMEOUT_ENV}: expected an integer from 1000 to 300000.`,
		);
	}
	const globalConfig = readConfigFile(globalPath, warnings);
	const projectConfig = options.projectTrusted
		? readConfigFile(projectPath, warnings)
		: {};

	const modelValue = firstModelWithSource(
		["environment", env[MODEL_ENV]],
		["project", projectConfig.model],
		["global", globalConfig.model],
	);
	const fallbackModelValue = firstModelWithSource(
		["environment", env[FALLBACK_MODEL_ENV]],
		["project", projectConfig.fallbackModel],
		["global", globalConfig.fallbackModel],
	);
	const timeoutValue = firstTimeoutWithSource(
		["environment", env[TIMEOUT_ENV]],
		["project", projectConfig.timeoutMs],
		["global", globalConfig.timeoutMs],
	);
	const policies = [
		["global", globalConfig.policy],
		["project", projectConfig.policy],
		["environment", env[POLICY_ENV]],
	] as const;
	const policySources = policies.flatMap(([source, value]) =>
		typeof value === "string" && value.trim().length > 0 ? [source] : [],
	);

	const globalReview = parseReviewRules(
		globalConfig.review,
		globalPath,
		warnings,
	);
	const projectReview = parseReviewRules(
		projectConfig.review,
		projectPath,
		warnings,
	);
	const review = mergeReviewRules(globalReview, projectReview);

	return {
		model: modelValue?.value ?? DEFAULT_REVIEWER_MODEL,
		fallbackModel: fallbackModelValue?.value ?? DEFAULT_REVIEWER_MODEL,
		timeoutMs: timeoutValue?.value ?? REVIEW_TIMEOUT_MS,
		policy:
			policySources.length > 0
				? policies
						.flatMap(([, value]) =>
							typeof value === "string" && value.trim() ? [value.trim()] : [],
						)
						.join("\n\n")
				: undefined,
		review,
		globalPath,
		projectPath,
		globalConfigPresent: existsSync(globalPath),
		projectConfigPresent: existsSync(projectPath),
		modelSource: modelValue?.source ?? "default",
		fallbackModelSource: fallbackModelValue?.source ?? "default",
		timeoutSource: timeoutValue?.source ?? "default",
		policySources,
		warnings,
	};
}

function readConfigFile(path: string, warnings: string[]): GuardianConfigFile {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			warnings.push(`Invalid ${path}: expected a JSON object.`);
			return {};
		}
		const config = parsed as GuardianConfigFile;
		validateConfigFile(config, path, warnings);
		return config;
	} catch (error) {
		warnings.push(
			`Invalid or unreadable ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return {};
	}
}

const CONFIG_FILE_KEYS = new Set([
	"model",
	"fallbackModel",
	"timeoutMs",
	"policy",
	"review",
]);

const REVIEW_LEVEL_RANK: Record<ReviewLevel, number> = {
	off: 0,
	"private-only": 1,
	"outside-or-private": 2,
	always: 3,
};

function mergeReviewRules(
	globalRules: Record<string, ReviewLevel>,
	projectRules: Record<string, ReviewLevel>,
): Record<string, ReviewLevel> {
	const effective: Record<string, ReviewLevel> = {
		...DEFAULT_REVIEW_RULES,
		...globalRules,
	};
	for (const [key, projectLevel] of Object.entries(projectRules)) {
		const floor = effective[key] ?? "private-only";
		effective[key] =
			REVIEW_LEVEL_RANK[projectLevel] > REVIEW_LEVEL_RANK[floor]
				? projectLevel
				: floor;
	}
	return effective;
}

function validateConfigFile(
	config: GuardianConfigFile,
	path: string,
	warnings: string[],
): void {
	for (const key of Object.keys(config)) {
		if (!CONFIG_FILE_KEYS.has(key)) {
			warnings.push(`Unknown top-level key ${key} in ${path}.`);
		}
	}
	if (config.model !== undefined && !isModelSpecString(config.model)) {
		warnings.push(`Invalid model in ${path}: expected provider/model-id string.`);
	}
	if (
		config.fallbackModel !== undefined &&
		!isModelSpecString(config.fallbackModel)
	) {
		warnings.push(
			`Invalid fallbackModel in ${path}: expected provider/model-id string.`,
		);
	}
	if (
		config.timeoutMs !== undefined &&
		firstTimeout(config.timeoutMs) === undefined
	) {
		warnings.push(
			`Invalid timeoutMs in ${path}: expected an integer from 1000 to 300000.`,
		);
	}
	if (config.policy !== undefined && typeof config.policy !== "string") {
		warnings.push(`Invalid policy in ${path}: expected a string.`);
	}
}

function parseReviewRules(
	value: unknown,
	path: string,
	warnings: string[],
): Record<string, ReviewLevel> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		warnings.push(`Invalid review in ${path}: expected an object.`);
		return {};
	}
	const rules: Record<string, ReviewLevel> = {};
	for (const [key, level] of Object.entries(value)) {
		if (!isReviewRuleKey(key)) {
			warnings.push(`Unsupported review.${key} in ${path}.`);
			continue;
		}
		if (
			level === "always" ||
			level === "outside-or-private" ||
			level === "private-only" ||
			level === "off"
		) {
			rules[key] = level;
		} else {
			warnings.push(
				`Invalid review.${key} in ${path}: expected always, outside-or-private, private-only, or off.`,
			);
		}
	}
	return rules;
}

function isReviewRuleKey(key: string): boolean {
	if (Object.hasOwn(DEFAULT_REVIEW_RULES, key)) return true;
	const toolName = key.endsWith(".path") ? key.slice(0, -".path".length) : "";
	return toolName.length > 0 && !/\s/.test(toolName);
}

function isModelSpecString(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		parseModelSpec(value) !== undefined
	);
}

function firstModelWithSource(
	...values: Array<[GuardianConfig["modelSource"], unknown]>
): { source: GuardianConfig["modelSource"]; value: string } | undefined {
	for (const [source, value] of values) {
		if (isModelSpecString(value)) {
			return { source, value: value.trim() };
		}
	}
	return undefined;
}

function firstTimeoutWithSource(
	...values: Array<[GuardianConfig["timeoutSource"], unknown]>
): { source: GuardianConfig["timeoutSource"]; value: number } | undefined {
	for (const [source, value] of values) {
		const timeout = firstTimeout(value);
		if (timeout !== undefined) return { source, value: timeout };
	}
	return undefined;
}

function firstTimeout(...values: unknown[]): number | undefined {
	for (const value of values) {
		const parsed =
			typeof value === "number"
				? value
				: typeof value === "string"
					? Number(value)
					: NaN;
		if (Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 300_000)
			return parsed;
	}
	return undefined;
}
