import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import type { GuardianAssessment } from "./review.ts";

export const GUARDIAN_REVIEW_MAX_ATTEMPTS = 3;
export const MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN = 3;
export const MAX_RECENT_AUTO_REVIEW_DENIALS_PER_TURN = 10;
export const AUTO_REVIEW_DENIAL_WINDOW_SIZE = 50;

export type GuardianReviewResult =
	| { kind: "allowed"; assessment: GuardianAssessment }
	| { kind: "denied"; assessment: GuardianAssessment }
	| { kind: "timeout"; message: string }
	| { kind: "failure"; message: string; retryable?: boolean }
	| { kind: "cancelled"; message: string }
	| { kind: "circuit-open"; message: string };

export class DenialCircuitBreaker {
	private consecutiveDenials = 0;
	private recentReviews: boolean[] = [];

	reset(): void {
		this.consecutiveDenials = 0;
		this.recentReviews = [];
	}

	record(denied: boolean): boolean {
		this.consecutiveDenials = denied ? this.consecutiveDenials + 1 : 0;
		this.recentReviews.push(denied);
		if (this.recentReviews.length > AUTO_REVIEW_DENIAL_WINDOW_SIZE) {
			this.recentReviews.shift();
		}
		return this.isOpen();
	}

	isOpen(): boolean {
		const recentDenials = this.recentReviews.filter(Boolean).length;
		return (
			this.consecutiveDenials >= MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN ||
			recentDenials >= MAX_RECENT_AUTO_REVIEW_DENIALS_PER_TURN
		);
	}
}

const SENSITIVE_BASENAMES = new Set([
	".env",
	"credentials",
	"credentials.json",
	"secrets.json",
	"authorized_keys",
	"known_hosts",
	"config.toml",
	"settings.json",
	"approval-guardian.json",
	"package.json",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	".gitlab-ci.yml",
	"docker-compose.yml",
	"docker-compose.yaml",
	"compose.yml",
	"compose.yaml",
]);

const SENSITIVE_SEGMENTS = new Set([
	".ssh",
	".gnupg",
	".aws",
	".kube",
	".git",
	".github",
	".pi",
	"secrets",
	"credentials",
	"terraform",
	"k8s",
	"kubernetes",
]);

const SENSITIVE_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".tf", ".tfvars"];
const SHELL_PROFILE_PATTERN =
	/^\.(?:zshrc|zprofile|zlogin|bashrc|bash_profile|profile)$/;

export interface MutationReviewTarget {
	absolutePath: string;
	outsideProject: boolean;
	sensitive: boolean;
	reasons: string[];
}

export function classifyMutationPath(
	path: string,
	cwd: string,
): MutationReviewTarget {
	const absolutePath = canonicalizePath(resolve(cwd, path));
	const projectRoot = canonicalizePath(resolve(cwd));
	const rel = relative(projectRoot, absolutePath);
	const outsideProject =
		rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
	const normalizedSegments = absolutePath.split(/[\\/]+/).filter(Boolean);
	const file = basename(absolutePath).toLowerCase();
	const sensitive =
		SENSITIVE_BASENAMES.has(file) ||
		file.startsWith(".env.") ||
		SHELL_PROFILE_PATTERN.test(file) ||
		SENSITIVE_SUFFIXES.some((suffix) => file.endsWith(suffix)) ||
		normalizedSegments.some((segment) =>
			SENSITIVE_SEGMENTS.has(segment.toLowerCase()),
		);
	const reasons = [
		...(outsideProject ? ["outside project"] : []),
		...(sensitive ? ["sensitive path"] : []),
	];
	return { absolutePath, outsideProject, sensitive, reasons };
}

export function shouldReviewMutation(path: string, cwd: string): boolean {
	const target = classifyMutationPath(path, cwd);
	return target.outsideProject || target.sensitive;
}

function canonicalizePath(path: string): string {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) {
			const target = resolve(dirname(path), readlinkSync(path));
			return canonicalizePath(target);
		}
		return realpathSync(path);
	} catch {
		const parent = dirname(path);
		if (parent === path) return path;
		return join(canonicalizePath(parent), basename(path));
	}
}
