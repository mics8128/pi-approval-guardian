import {
	lstatSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	matchesGlob,
	relative,
	resolve,
	sep,
	win32,
} from "node:path";
import { fileURLToPath } from "node:url";
import type { ReviewLevel } from "./config.ts";
import type { DirectoryScanCache } from "./directory-scan-cache.ts";
import {
	hasSensitiveMutationSuffix,
	isCommonPrivateDirectory,
	isPiPrivatePath,
	isPrivateReadBasename,
	isProjectPrivateSegment,
	isSensitiveMutationBasename,
	isSensitiveMutationSegment,
	isSensitivePiMutationPath,
	isShellProfileBasename,
} from "./path-rules.ts";
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

export function circuitOutcomeForReview(
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

// Small state holder; the structural rule misclassifies its method span as a large class.
// pi-lens-ignore: large-class
export class DenialCircuitBreaker {
	private consecutiveAdverseOutcomes = 0;
	private recentReviews: boolean[] = [];

	reset(): void {
		this.consecutiveAdverseOutcomes = 0;
		this.recentReviews = [];
	}

	record(adverse: boolean): boolean {
		this.consecutiveAdverseOutcomes = adverse
			? this.consecutiveAdverseOutcomes + 1
			: 0;
		this.recentReviews.push(adverse);
		if (this.recentReviews.length > AUTO_REVIEW_DENIAL_WINDOW_SIZE) {
			this.recentReviews.shift();
		}
		return this.isOpen();
	}

	isOpen(): boolean {
		const recentAdverseOutcomes = this.recentReviews.filter(Boolean).length;
		return (
			this.consecutiveAdverseOutcomes >= MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN ||
			recentAdverseOutcomes >= MAX_RECENT_AUTO_REVIEW_DENIALS_PER_TURN
		);
	}
}

export class ReviewBatchTracker {
	private batches = new Map<string, { reviewed: boolean; adverse: boolean }>();

	reset(): void {
		this.batches.clear();
	}

	record(batchId: string, adverse: boolean): void {
		const state = this.batches.get(batchId) ?? {
			reviewed: false,
			adverse: false,
		};
		state.reviewed = true;
		state.adverse ||= adverse;
		this.batches.set(batchId, state);
	}

	finish(batchId: string): boolean | undefined {
		const state = this.batches.get(batchId);
		this.batches.delete(batchId);
		return state?.reviewed ? state.adverse : undefined;
	}
}

const PI_INSTALLED_PACKAGE_ROOTS = [
	resolve(homedir(), ".pi", "agent", "npm", "node_modules"),
	resolve(homedir(), ".pi", "npm", "node_modules"),
	resolve(homedir(), ".pi", "context-mode", "insight-cache", "node_modules"),
].map((path) => canonicalizePath(path));

function isInstalledPiPackagePath(absolutePath: string): boolean {
	return PI_INSTALLED_PACKAGE_ROOTS.some((root) => {
		const rel = relative(root, absolutePath);
		return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
	});
}

export interface MutationReviewTarget {
	absolutePath: string;
	outsideProject: boolean;
	sensitive: boolean;
	private: boolean;
	reasons: string[];
}

export interface ReadReviewTarget {
	absolutePath: string;
	outsideProject: boolean;
	private: boolean;
	reasons: string[];
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Matches Pi's built-in path normalization without importing its internal modules. */
export function resolveGuardianPath(
	path: string,
	cwd: string,
): { absolutePath: string; projectRoot: string; windowsPath: boolean } {
	const normalizedPath = normalizeGuardianPath(path);
	const normalizedCwd = normalizeGuardianPath(cwd);
	const windowsPath = isWindowsAbsolute(normalizedPath);
	const windowsCwd = isWindowsAbsolute(normalizedCwd);
	const absolutePath =
		windowsPath && process.platform !== "win32"
			? win32.normalize(normalizedPath).replace(/\\/g, "/")
			: canonicalizePath(resolve(normalizedCwd, normalizedPath));
	const projectRoot =
		windowsCwd && process.platform !== "win32"
			? win32.normalize(normalizedCwd).replace(/\\/g, "/")
			: canonicalizePath(resolve(normalizedCwd));
	return { absolutePath, projectRoot, windowsPath };
}

function normalizeGuardianPath(input: string): string {
	let normalized = input.replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized === "~") return homedir();
	if (
		normalized.startsWith("~/") ||
		(process.platform === "win32" && normalized.startsWith("~\\"))
	) {
		normalized = join(homedir(), normalized.slice(2));
	}
	return /^file:\/\//.test(normalized) ? fileURLToPath(normalized) : normalized;
}

function isWindowsAbsolute(path: string): boolean {
	return /^[a-z]:[\\/]/i.test(path) || /^\\\\/.test(path);
}

function isNormalizedWindowsAbsolute(path: string): boolean {
	return isWindowsAbsolute(path) || /^\/\/[^/]/.test(path);
}

function isOutsideProject(
	absolutePath: string,
	projectRoot: string,
	windowsPath: boolean,
): boolean {
	if (windowsPath) {
		if (!isNormalizedWindowsAbsolute(projectRoot)) return true;
		const rel = win32.relative(projectRoot, absolutePath);
		return (
			rel === ".." ||
			rel.startsWith("../") ||
			rel.startsWith("..\\") ||
			win32.isAbsolute(rel)
		);
	}
	const rel = relative(projectRoot, absolutePath);
	return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

export function classifyMutationPath(
	path: string,
	cwd: string,
): MutationReviewTarget {
	const { absolutePath, projectRoot, windowsPath } = resolveGuardianPath(
		path,
		cwd,
	);
	const outsideProject = isOutsideProject(
		absolutePath,
		projectRoot,
		windowsPath,
	);
	const normalizedSegments = absolutePath.split(/[\\/]+/).filter(Boolean);
	const file = basename(absolutePath).toLowerCase();
	const privatePath = classifyReadPath(path, cwd).private;
	const sensitive =
		privatePath ||
		isSensitiveMutationBasename(file) ||
		isShellProfileBasename(file) ||
		hasSensitiveMutationSuffix(file) ||
		normalizedSegments.some((segment) =>
			isSensitiveMutationSegment(segment.toLowerCase()),
		) ||
		isSensitivePiMutationPath(
			normalizedSegments.map((segment) => segment.toLowerCase()),
		);
	const reasons = [
		...(outsideProject ? ["outside project"] : []),
		...(sensitive ? ["sensitive path"] : []),
	];
	return {
		absolutePath,
		outsideProject,
		sensitive,
		private: privatePath,
		reasons,
	};
}

export function shouldReviewMutation(path: string, cwd: string): boolean {
	const target = classifyMutationPath(path, cwd);
	return target.outsideProject || target.sensitive;
}

// The branches deliberately mirror independent blacklist categories for auditability.
// pi-lens-ignore: high-complexity
export function classifyReadPath(path: string, cwd: string): ReadReviewTarget {
	const { absolutePath, projectRoot, windowsPath } = resolveGuardianPath(
		path,
		cwd,
	);
	const outsideProject = isOutsideProject(
		absolutePath,
		projectRoot,
		windowsPath,
	);
	const normalizedSegments = absolutePath
		.split(/[\\/]+/)
		.filter(Boolean)
		.map((segment) => segment.toLowerCase());
	const file = normalizedSegments.at(-1) ?? "";
	const installedPiPackage = isInstalledPiPackagePath(absolutePath);
	const privateBasename = isPrivateReadBasename(file);
	const projectPrivateSegment = normalizedSegments.some(
		(segment) =>
			isProjectPrivateSegment(segment) &&
			!(installedPiPackage && segment === "private"),
	);
	const privateDirectory = isCommonPrivateDirectory(normalizedSegments);
	const piPrivate = isPiPrivatePath(normalizedSegments, file);
	const privatePath =
		privateBasename || projectPrivateSegment || privateDirectory || piPrivate;
	const reasons = [
		...(privateBasename ? ["private file"] : []),
		...(projectPrivateSegment ? ["private directory"] : []),
		...(privateDirectory ? ["common private directory"] : []),
		...(piPrivate ? ["private Pi data"] : []),
	];
	return { absolutePath, outsideProject, private: privatePath, reasons };
}

export function shouldReviewPath(
	level: ReviewLevel,
	target: ReadReviewTarget,
): boolean {
	if (level === "always") return true;
	if (level === "outside-or-private")
		return target.outsideProject || target.private;
	if (level === "private-only") return target.private;
	return false;
}

export function requiresExplicitReadAuthorization(
	path: string,
	cwd: string,
): boolean {
	return classifyReadPath(path, cwd).private;
}

const GREP_SCOPE_SKIP_DIRECTORIES = new Set([
	".git",
	"node_modules",
	"vendor",
	"dist",
	"build",
	"target",
]);

export function directoryMayContainPrivatePath(
	path: string,
	cwd: string,
	glob?: string,
	maxEntries = 10_000,
	cache?: DirectoryScanCache,
): boolean {
	const root = classifyReadPath(path, cwd);
	const cached = cache?.get(root.absolutePath, glob, maxEntries);
	if (cached !== undefined) return cached;
	const finish = (value: boolean) => {
		cache?.set(root.absolutePath, glob, maxEntries, value);
		return value;
	};
	let rootStat: ReturnType<typeof lstatSync>;
	try {
		rootStat = lstatSync(root.absolutePath);
	} catch {
		return finish(root.private);
	}
	if (!rootStat.isDirectory()) {
		return finish(root.private && globMatches(path, glob));
	}
	const pending = [{ directory: root.absolutePath, privateAncestor: root.private }];
	const visited = new Set<string>();
	let scanned = 0;
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		let canonical: string;
		try {
			canonical = realpathSync(current.directory);
		} catch {
			continue;
		}
		if (visited.has(canonical)) continue;
		visited.add(canonical);
		let entries: Dirent[];
		try {
			entries = readdirSync(current.directory, { withFileTypes: true });
		} catch {
			if (current.privateAncestor) return finish(true);
			continue;
		}
		for (const entry of entries) {
			scanned++;
			if (scanned > maxEntries) return finish(true);
			const child = join(current.directory, entry.name);
			const childPrivate =
				current.privateAncestor || classifyReadPath(child, cwd).private;
			if (entry.isDirectory()) {
				if (!GREP_SCOPE_SKIP_DIRECTORIES.has(entry.name.toLowerCase())) {
					pending.push({ directory: child, privateAncestor: childPrivate });
				}
				continue;
			}
			const relativeChild = relative(root.absolutePath, child).replace(/\\/g, "/");
			if (childPrivate && globMatches(relativeChild, glob)) return finish(true);
		}
	}
	return finish(false);
}

function globMatches(path: string, glob?: string): boolean {
	if (!glob) return true;
	if (glob === "*" || glob === "**" || glob === "**/*" || glob === "*.*")
		return true;
	try {
		return matchesGlob(path, glob) || matchesGlob(basename(path), glob);
	} catch {
		return true;
	}
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
