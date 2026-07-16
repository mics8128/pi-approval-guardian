import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
	win32,
} from "node:path";
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

// Small state holder; the structural rule misclassifies its method span as a large class.
// pi-lens-ignore: large-class
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
	"private",
]);
const EXTERNAL_PRIVATE_SEGMENTS = new Set([
	".ssh",
	".gnupg",
	".aws",
	".azure",
	".kube",
	".docker",
	".pi",
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
]);
const EXTERNAL_PRIVATE_CONFIG_SEGMENTS = new Set([
	"gcloud",
	"gh",
	"glab",
	"op",
	"rclone",
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
];
const PRIVATE_READ_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".tfvars"];

export interface MutationReviewTarget {
	absolutePath: string;
	outsideProject: boolean;
	sensitive: boolean;
	reasons: string[];
}

export interface ReadReviewTarget {
	absolutePath: string;
	outsideProject: boolean;
	private: boolean;
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

// The branches deliberately mirror independent blacklist categories for auditability.
// pi-lens-ignore: high-complexity
export function classifyReadPath(path: string, cwd: string): ReadReviewTarget {
	const windowsAbsolute = /^[a-z]:[\\/]/i.test(path) || /^\\\\/.test(path);
	const windowsCwd = /^[a-z]:[\\/]/i.test(cwd) || /^\\\\/.test(cwd);
	const absolutePath = windowsAbsolute
		? win32.normalize(path).replace(/\\/g, "/")
		: canonicalizePath(resolve(cwd, path));
	const projectRoot = windowsCwd
		? win32.normalize(cwd).replace(/\\/g, "/")
		: canonicalizePath(resolve(cwd));
	let rel: string;
	if (windowsAbsolute && windowsCwd) {
		rel = win32.relative(projectRoot, absolutePath);
	} else if (windowsAbsolute) {
		rel = "..";
	} else {
		rel = relative(projectRoot, absolutePath);
	}
	const outsideProject = windowsAbsolute
		? rel === ".." || rel.startsWith("../") || win32.isAbsolute(rel)
		: rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
	const normalizedSegments = absolutePath
		.split(/[\\/]+/)
		.filter(Boolean)
		.map((segment) => segment.toLowerCase());
	const file = normalizedSegments.at(-1) ?? "";
	const privateBasename =
		PRIVATE_READ_BASENAMES.has(file) ||
		file.startsWith(".env.") ||
		file.startsWith("service-account") ||
		file.startsWith("password") ||
		file.endsWith(".secret") ||
		file.endsWith(".secrets") ||
		PRIVATE_READ_SUFFIXES.some((suffix) => file.endsWith(suffix));
	const projectPrivateSegment = normalizedSegments.some((segment) =>
		PROJECT_PRIVATE_SEGMENTS.has(segment),
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
	const privatePath =
		privateBasename || projectPrivateSegment || privateDirectory;
	const reasons = [
		...(privateBasename ? ["private file"] : []),
		...(projectPrivateSegment ? ["private directory"] : []),
		...(privateDirectory ? ["common private directory"] : []),
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
