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
	"secrets",
	"credentials",
	"terraform",
	"k8s",
	"kubernetes",
]);

const SENSITIVE_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".tf", ".tfvars"];
const SHELL_PROFILE_PATTERN =
	/^\.(?:zshrc|zprofile|zlogin|bashrc|bash_profile|profile)$/;

const PRIVATE_READ_BASENAMES = new Set([
	".env",
	".netrc",
	".npmrc",
	".pypirc",
	".git-credentials",
	"auth.json",
	"token.json",
	"tokens.json",
	"cookies.sqlite",
	"login data",
	"logins.json",
	"key4.db",
	"nuget.config",
	"credentials.tfrc.json",
	"credentials",
	"credentials.json",
	"secrets.json",
	"authorized_keys",
	"id_rsa",
	"id_ed25519",
	"id_ecdsa",
	"id_dsa",
]);

const PROJECT_PRIVATE_SEGMENTS = new Set([
	"secrets",
	"secret",
	"credentials",
]);
const EXTERNAL_PRIVATE_SEGMENTS = new Set([
	".ssh",
	".gnupg",
	".aws",
	".azure",
	".kube",
	".docker",
	".password-store",
	".mozilla",
	"keychains",
	"keyrings",
	"credentials",
	"vault",
	"vaults",
	"1password",
	"bitwarden",
	"keepass",
	"keepassxc",
	"wireguard",
	"openvpn",
	".openvpn",
	".terraform.d",
	".gem",
	".bundle",
]);
const EXTERNAL_PRIVATE_CONFIG_SEGMENTS = new Set([
	"gcloud",
	"gh",
	"glab",
	"op",
	"rclone",
	"hub",
	"google-chrome",
	"chromium",
	"bravesoftware",
	"microsoft-edge",
	"sops",
	"age",
]);
const PRIVATE_PATH_FRAGMENTS = [
	"/library/application support/google/chrome/",
	"/library/application support/chromium/",
	"/library/application support/firefox/",
	"/library/application support/bravesoftware/",
	"/library/application support/1password/",
	"/library/application support/bitwarden/",
	"/library/keychains/",
	"/library/mobiledevice/provisioning profiles/",
	"/appdata/roaming/gnupg/",
	"/appdata/roaming/gcloud/",
	"/appdata/roaming/github cli/",
	"/appdata/roaming/1password/",
	"/appdata/roaming/bitwarden/",
	"/appdata/roaming/mozilla/firefox/profiles/",
	"/appdata/roaming/microsoft/credentials/",
	"/appdata/local/microsoft/credentials/",
	"/appdata/local/google/chrome/user data/",
	"/appdata/local/chromium/user data/",
	"/appdata/local/microsoft/edge/user data/",
	"/windows/system32/config/",
	"/programdata/ssh/",
	"/etc/ssl/private/",
	"/etc/networkmanager/system-connections/",
	"/etc/wireguard/",
	"/etc/openvpn/",
	"/var/lib/private/",
];
const PRIVATE_READ_SUFFIXES = [
	".pem",
	".key",
	".p12",
	".pfx",
	".jks",
	".keystore",
	".kdbx",
	".tfvars",
];

const PI_PRIVATE_ROOT_FILES = new Set([
	"settings.json",
	"web-search.json",
	"knowledge-search-.json",
]);
const PI_PRIVATE_AGENT_FILES = new Set([
	"auth.json",
	"approval-guardian.json",
	"models-store.json",
	"models.json",
	"run-history.jsonl",
	"settings.json",
	"trust.json",
]);

function startsWithSegments(values: string[], prefix: string[]): boolean {
	return prefix.every((segment, index) => values[index] === segment);
}

function piRelativeSegments(segments: string[]): string[] | undefined {
	const piIndex = segments.lastIndexOf(".pi");
	return piIndex >= 0 ? segments.slice(piIndex + 1) : undefined;
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

const PI_SENSITIVE_MUTATION_DIRECTORIES = new Set([
	"agents",
	"chains",
	"extensions",
	"git",
	"npm",
	"prompts",
	"skills",
	"themes",
]);

function isSensitivePiMutationPath(segments: string[]): boolean {
	const relativeSegments = piRelativeSegments(segments);
	if (!relativeSegments) return false;
	if (relativeSegments.length === 0) return true;
	return PI_SENSITIVE_MUTATION_DIRECTORIES.has(relativeSegments[0] ?? "");
}

function isPiPrivatePath(segments: string[], file: string): boolean {
	const relativeSegments = piRelativeSegments(segments);
	if (!relativeSegments || relativeSegments.length === 0) return false;
	if (
		relativeSegments[0] === "memory" ||
		relativeSegments[0] === "pi-acp" ||
		relativeSegments[0]?.startsWith("knowledge-search-") === true
	) {
		return true;
	}

	if (relativeSegments.length === 1) {
		return PI_PRIVATE_ROOT_FILES.has(file);
	}

	if (relativeSegments[0] === "agent") {
		if (
			relativeSegments[1] === "sessions" ||
			startsWithSegments(relativeSegments, ["agent", "delegates", "jobs"])
		) {
			return true;
		}
		if (relativeSegments.length === 2) {
			return (
				PI_PRIVATE_AGENT_FILES.has(file) ||
				file.startsWith("settings.json.") ||
				file.startsWith("models.json.") ||
				file.endsWith("-api-key")
			);
		}
		if (relativeSegments[1]?.startsWith("archive-")) {
			return (
				file.includes("api-key") ||
				file.endsWith(".log") ||
				file.startsWith("settings.json") ||
				file.includes("models.json")
			);
		}
	}

	return (
		startsWithSegments(relativeSegments, ["context-mode", "content"]) ||
		startsWithSegments(relativeSegments, ["context-mode", "sessions"]) ||
		startsWithSegments(relativeSegments, ["session-search", "index"]) ||
		(startsWithSegments(relativeSegments, ["session-search"]) &&
			file === "config.json")
	);
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

function isCredentialLikeBasename(file: string): boolean {
	return (
		file === "service-account" ||
		/^service-account(?:[-_.][a-z0-9_-]+)?\.(?:json|ya?ml|pem|key)$/i.test(
			file,
		) ||
		/^passwords?(?:(?:[-_.](?:store|vault|secret|secrets|credential|credentials|token|tokens|hash|hashes))(?:\.(?:json|ya?ml|txt|csv|db))?|\.(?:json|ya?ml|txt|csv|db))?$/i.test(
			file,
		)
	);
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
		SENSITIVE_BASENAMES.has(file) ||
		file.startsWith(".env.") ||
		SHELL_PROFILE_PATTERN.test(file) ||
		SENSITIVE_SUFFIXES.some((suffix) => file.endsWith(suffix)) ||
		normalizedSegments.some((segment) =>
			SENSITIVE_SEGMENTS.has(segment.toLowerCase()),
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
	const privateBasename =
		PRIVATE_READ_BASENAMES.has(file) ||
		file.startsWith(".env.") ||
		isCredentialLikeBasename(file) ||
		file.endsWith(".secret") ||
		file.endsWith(".secrets") ||
		PRIVATE_READ_SUFFIXES.some((suffix) => file.endsWith(suffix));
	const projectPrivateSegment = normalizedSegments.some(
		(segment) =>
			PROJECT_PRIVATE_SEGMENTS.has(segment) &&
			!(installedPiPackage && segment === "private"),
	);
	const privateDirectory =
		normalizedSegments.some((segment) =>
			EXTERNAL_PRIVATE_SEGMENTS.has(segment),
		) ||
		normalizedSegments.some(
			(segment, index) =>
				segment === ".config" &&
				EXTERNAL_PRIVATE_CONFIG_SEGMENTS.has(
					normalizedSegments[index + 1] ?? "",
				),
		) ||
		PRIVATE_PATH_FRAGMENTS.some((fragment) =>
			`/${normalizedSegments.join("/")}/`.includes(fragment),
		);
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
): boolean {
	const root = classifyReadPath(path, cwd);
	let rootStat: ReturnType<typeof lstatSync>;
	try {
		rootStat = lstatSync(root.absolutePath);
	} catch {
		return root.private;
	}
	if (!rootStat.isDirectory()) return root.private && globMatches(path, glob);
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
			if (current.privateAncestor) return true;
			continue;
		}
		for (const entry of entries) {
			scanned++;
			if (scanned > maxEntries) return true;
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
			if (childPrivate && globMatches(relativeChild, glob)) return true;
		}
	}
	return false;
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
