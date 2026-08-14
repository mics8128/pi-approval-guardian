/**
 * Auditable source of truth for deterministic private-read and sensitive-mutation
 * path rules. Keep literal rule catalogs here so structured tool paths and shell
 * command heuristics do not drift apart.
 */

export const SENSITIVE_MUTATION_BASENAMES = [
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
] as const;

export const SENSITIVE_MUTATION_SEGMENTS = [
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
] as const;

export const SENSITIVE_MUTATION_SUFFIXES = [
	".pem",
	".key",
	".p12",
	".pfx",
	".tf",
	".tfvars",
] as const;

export const PRIVATE_READ_BASENAMES = [
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
] as const;

export const PROJECT_PRIVATE_SEGMENTS = [
	"secrets",
	"secret",
	"credentials",
] as const;

export const EXTERNAL_PRIVATE_SEGMENTS = [
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
] as const;

export const EXTERNAL_PRIVATE_CONFIG_SEGMENTS = [
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
] as const;

export const PRIVATE_PATH_FRAGMENTS = [
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
] as const;

export const PRIVATE_READ_SUFFIXES = [
	".pem",
	".key",
	".p12",
	".pfx",
	".jks",
	".keystore",
	".kdbx",
	".tfvars",
] as const;

export const PI_PRIVATE_ROOT_FILES = [
	"settings.json",
	"web-search.json",
	"knowledge-search-.json",
] as const;

export const PI_PRIVATE_AGENT_FILES = [
	"auth.json",
	"approval-guardian.json",
	"models-store.json",
	"models.json",
	"run-history.jsonl",
	"settings.json",
	"trust.json",
] as const;

export const PI_SENSITIVE_MUTATION_DIRECTORIES = [
	"agents",
	"chains",
	"extensions",
	"git",
	"npm",
	"prompts",
	"skills",
	"themes",
] as const;

/**
 * Representative names used only to evaluate shell/glob patterns. The source
 * categories above remain authoritative; these arrays are derived from them.
 */
export const PRIVATE_GLOB_FILE_CANDIDATES = [
	...PRIVATE_READ_BASENAMES,
	".env.local",
	"service-account-prod.json",
	"password-vault.yaml",
	"passwords.json",
	"value.secret",
	"value.secrets",
	...PRIVATE_READ_SUFFIXES.map((suffix) => `secret${suffix}`),
] as const;

export const PRIVATE_GLOB_DIRECTORY_CANDIDATES = [
	...PROJECT_PRIVATE_SEGMENTS,
	...EXTERNAL_PRIVATE_SEGMENTS,
] as const;

export const PRIVATE_CONFIG_GLOB_DIRECTORY_CANDIDATES = [
	...EXTERNAL_PRIVATE_CONFIG_SEGMENTS,
] as const;

const sensitiveMutationBasenames = new Set<string>(
	SENSITIVE_MUTATION_BASENAMES,
);
const sensitiveMutationSegments = new Set<string>(
	SENSITIVE_MUTATION_SEGMENTS,
);
const privateReadBasenames = new Set<string>(PRIVATE_READ_BASENAMES);
const projectPrivateSegments = new Set<string>(PROJECT_PRIVATE_SEGMENTS);
const externalPrivateSegments = new Set<string>(EXTERNAL_PRIVATE_SEGMENTS);
const externalPrivateConfigSegments = new Set<string>(
	EXTERNAL_PRIVATE_CONFIG_SEGMENTS,
);
const piPrivateRootFiles = new Set<string>(PI_PRIVATE_ROOT_FILES);
const piPrivateAgentFiles = new Set<string>(PI_PRIVATE_AGENT_FILES);
const piSensitiveMutationDirectories = new Set<string>(
	PI_SENSITIVE_MUTATION_DIRECTORIES,
);

const SHELL_PROFILE_PATTERN =
	/^\.(?:zshrc|zprofile|zlogin|bashrc|bash_profile|profile)$/;

export function isSensitiveMutationBasename(file: string): boolean {
	return sensitiveMutationBasenames.has(file) || file.startsWith(".env.");
}

export function isSensitiveMutationSegment(segment: string): boolean {
	return sensitiveMutationSegments.has(segment);
}

export function hasSensitiveMutationSuffix(file: string): boolean {
	return SENSITIVE_MUTATION_SUFFIXES.some((suffix) => file.endsWith(suffix));
}

export function isShellProfileBasename(file: string): boolean {
	return SHELL_PROFILE_PATTERN.test(file);
}

export function isCredentialLikeBasename(file: string): boolean {
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

export function isPrivateReadBasename(file: string): boolean {
	return (
		privateReadBasenames.has(file) ||
		file.startsWith(".env.") ||
		isCredentialLikeBasename(file) ||
		file.endsWith(".secret") ||
		file.endsWith(".secrets") ||
		PRIVATE_READ_SUFFIXES.some((suffix) => file.endsWith(suffix))
	);
}

export function isProjectPrivateSegment(segment: string): boolean {
	return projectPrivateSegments.has(segment);
}

export function isCommonPrivateDirectory(segments: string[]): boolean {
	return (
		segments.some((segment) => externalPrivateSegments.has(segment)) ||
		segments.some(
			(segment, index) =>
				segment === ".config" &&
				externalPrivateConfigSegments.has(segments[index + 1] ?? ""),
		) ||
		PRIVATE_PATH_FRAGMENTS.some((fragment) =>
			`/${segments.join("/")}/`.includes(fragment),
		)
	);
}

function startsWithSegments(values: string[], prefix: string[]): boolean {
	return prefix.every((segment, index) => values[index] === segment);
}

function piRelativeSegments(segments: string[]): string[] | undefined {
	const piIndex = segments.lastIndexOf(".pi");
	return piIndex >= 0 ? segments.slice(piIndex + 1) : undefined;
}

export function isSensitivePiMutationPath(segments: string[]): boolean {
	const relativeSegments = piRelativeSegments(segments);
	if (!relativeSegments) return false;
	if (relativeSegments.length === 0) return true;
	return piSensitiveMutationDirectories.has(relativeSegments[0] ?? "");
}

export function isPiPrivatePath(segments: string[], file: string): boolean {
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
		return piPrivateRootFiles.has(file);
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
				piPrivateAgentFiles.has(file) ||
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
