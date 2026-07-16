import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_REVIEWER_MODEL, REVIEW_TIMEOUT_MS } from "./review.ts";

export const MODEL_ENV = "PI_APPROVAL_GUARDIAN_MODEL";
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
	"hypa_read.path": "private-only",
	"grep.path": "private-only",
	"write.path": "outside-or-private",
	"edit.path": "outside-or-private",
};

interface GuardianConfigFile {
	model?: unknown;
	timeoutMs?: unknown;
	policy?: unknown;
	review?: unknown;
}

export interface GuardianConfig {
	model: string;
	timeoutMs: number;
	policy?: string;
	review: Record<string, ReviewLevel>;
	globalPath: string;
	projectPath: string;
	projectConfigLoaded: boolean;
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
	const globalConfig = readConfigFile(globalPath, warnings);
	const projectConfig = options.projectTrusted
		? readConfigFile(projectPath, warnings)
		: {};

	const model =
		firstString(env[MODEL_ENV], projectConfig.model, globalConfig.model) ??
		DEFAULT_REVIEWER_MODEL;
	const timeoutMs =
		firstTimeout(
			env[TIMEOUT_ENV],
			projectConfig.timeoutMs,
			globalConfig.timeoutMs,
		) ?? REVIEW_TIMEOUT_MS;
	const policies = [globalConfig.policy, projectConfig.policy, env[POLICY_ENV]]
		.filter(
			(value): value is string =>
				typeof value === "string" && value.trim().length > 0,
		)
		.map((value) => value.trim());

	const review = {
		...DEFAULT_REVIEW_RULES,
		...parseReviewRules(globalConfig.review, globalPath, warnings),
		...parseReviewRules(projectConfig.review, projectPath, warnings),
	};

	return {
		model,
		timeoutMs,
		policy: policies.length > 0 ? policies.join("\n\n") : undefined,
		review,
		globalPath,
		projectPath,
		projectConfigLoaded: options.projectTrusted && existsSync(projectPath),
		warnings,
	};
}

function readConfigFile(path: string, warnings: string[]): GuardianConfigFile {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			warnings.push(`Ignoring ${path}: expected a JSON object.`);
			return {};
		}
		return parsed as GuardianConfigFile;
	} catch (error) {
		warnings.push(
			`Ignoring ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return {};
	}
}

function parseReviewRules(
	value: unknown,
	path: string,
	warnings: string[],
): Record<string, ReviewLevel> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		warnings.push(`Ignoring review rules in ${path}: expected an object.`);
		return {};
	}
	const rules: Record<string, ReviewLevel> = {};
	for (const [key, level] of Object.entries(value)) {
		if (
			level === "always" ||
			level === "outside-or-private" ||
			level === "private-only" ||
			level === "off"
		) {
			rules[key] = level;
		} else {
			warnings.push(`Ignoring review.${key} in ${path}: invalid level.`);
		}
	}
	return rules;
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
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
