import { homedir } from "node:os";
import { classifyReadPath } from "./gate.ts";
import {
	PRIVATE_CONFIG_GLOB_DIRECTORY_CANDIDATES,
	PRIVATE_GLOB_DIRECTORY_CANDIDATES,
	PRIVATE_GLOB_FILE_CANDIDATES,
} from "./path-rules.ts";

/**
 * Conservatively identifies shell actions that reference deterministic private
 * paths. Literal path candidates are classified by the same classifyReadPath()
 * rules used for read/grep/find/ls tools; glob handling consumes the same rule
 * catalog through representative candidates.
 */
export function commandReferencesPrivateData(
	command: string,
	cwd: string,
): boolean {
	const expanded = expandHomeReferences(command);
	if (referencesDynamicPiPath(expanded)) return true;

	for (const token of shellEvidenceTokens(expanded)) {
		for (const candidate of tokenValueCandidates(token)) {
			if (!candidate) continue;
			if (pathPatternReferencesPrivateData(candidate)) return true;
			if (
				looksLikeLiteralPath(candidate) &&
				classifyReadPath(candidate, cwd).private
			) {
				return true;
			}
		}
	}
	return false;
}

export function looksLikePrivateGlob(glob: string): boolean {
	return pathPatternReferencesPrivateData(glob);
}

function expandHomeReferences(value: string): string {
	return value
		.replace(/\$\{HOME\}|\$HOME/gi, homedir())
		.replace(/(^|[\s'"=(])~(?=\/)/g, `$1${homedir()}`);
}

function shellEvidenceTokens(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	const flush = () => {
		if (current) tokens.push(current);
		current = "";
	};

	for (let index = 0; index < command.length; index++) {
		const character = command[index];
		if (quote === "'") {
			if (character === "'") quote = undefined;
			else current += character;
			continue;
		}
		if (quote === '"') {
			if (character === '"') {
				quote = undefined;
				continue;
			}
			if (
				character === "\\" &&
				index + 1 < command.length &&
				/["$`\\\n]/.test(command[index + 1] ?? "")
			) {
				current += command[++index];
				continue;
			}
			current += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/.test(character) || /[;|&<>()]/.test(character)) {
			flush();
			continue;
		}
		if (
			character === "\\" &&
			index + 1 < command.length &&
			/[\s'";|&<>()]/.test(command[index + 1] ?? "")
		) {
			current += command[++index];
			continue;
		}
		current += character;
	}
	flush();
	return tokens;
}

function tokenValueCandidates(token: string): string[] {
	const candidates = [token];
	const equals = token.lastIndexOf("=");
	if (equals >= 0 && equals < token.length - 1) {
		candidates.push(token.slice(equals + 1));
	}
	return candidates.map(cleanShellToken).filter(Boolean);
}

function cleanShellToken(token: string): string {
	return token.replace(/^[,:]+/, "").replace(/,+$/, "").trim();
}

function looksLikeLiteralPath(token: string): boolean {
	return (
		token.startsWith(".") ||
		token.startsWith("/") ||
		token.startsWith("~") ||
		token.startsWith("@") ||
		token.startsWith("file://") ||
		/^[a-z]:[\\/]/i.test(token) ||
		/^\\\\/.test(token) ||
		token.includes("/") ||
		token.includes("\\")
	);
}

function pathPatternReferencesPrivateData(expression: string): boolean {
	const tokens = [expression, ...expression.split(/[\s'"`;|&<>()]+/)]
		.map((token) => token.slice(token.lastIndexOf("=") + 1))
		.map(cleanShellToken)
		.filter(Boolean);
	return tokens.some((token) => {
		const segments = token
			.replace(/\\/g, "/")
			.toLowerCase()
			.split("/")
			.filter(Boolean);
		for (let index = 0; index < segments.length; index++) {
			const pattern = segments[index] ?? "";
			if (
				[...PRIVATE_GLOB_DIRECTORY_CANDIDATES, ...PRIVATE_GLOB_FILE_CANDIDATES].some(
					(candidate) => shellGlobMatches(pattern, candidate),
				)
			) {
				return true;
			}
			if (
				index > 0 &&
				shellGlobMatches(segments[index - 1] ?? "", ".config") &&
				PRIVATE_CONFIG_GLOB_DIRECTORY_CANDIDATES.some((candidate) =>
					shellGlobMatches(pattern, candidate),
				)
			) {
				return true;
			}
		}
		return false;
	});
}

function shellGlobMatches(pattern: string, candidate: string): boolean {
	return expandBracePatterns(pattern).some((expanded) => {
		const literal = expanded.replace(/\[[^\]]*\]/g, "").replace(/[*?]/g, "");
		if (literal.length === 0) return false;
		let source = "^";
		for (let index = 0; index < expanded.length; index++) {
			const character = expanded[index];
			if (character === "*") {
				source += ".*";
			} else if (character === "?") {
				source += ".";
			} else if (character === "[") {
				const close = expanded.indexOf("]", index + 1);
				if (close < 0) {
					source += "\\[";
					continue;
				}
				let content = expanded.slice(index + 1, close);
				if (content.startsWith("!")) content = `^${content.slice(1)}`;
				source += `[${content}]`;
				index = close;
			} else {
				source += escapeRegExp(character);
			}
		}
		try {
			return new RegExp(`${source}$`, "i").test(candidate);
		} catch {
			return false;
		}
	});
}

function expandBracePatterns(pattern: string, depth = 0): string[] {
	if (depth >= 2) return [pattern];
	const match = /\{([^{}]+)\}/.exec(pattern);
	if (!match || match.index === undefined) return [pattern];
	const options = match[1].split(",");
	if (options.length === 0 || options.length > 16) return [pattern];
	const prefix = pattern.slice(0, match.index);
	const suffix = pattern.slice(match.index + match[0].length);
	return options.flatMap((option) =>
		expandBracePatterns(`${prefix}${option}${suffix}`, depth + 1),
	);
}

function referencesDynamicPiPath(command: string): boolean {
	const piTokens = command
		.split(/[\s'"`;|&<>()]+/)
		.filter((token) => token.toLowerCase().includes(".pi"));
	if (piTokens.some((token) => /[*?\[\]{}$]/.test(token))) return true;

	const assignments = command.matchAll(
		/(?:^|[;\s])([a-z_][a-z0-9_]*)\s*=\s*["']?([^;\s"']*\.pi[^;\s"']*)/gi,
	);
	for (const assignment of assignments) {
		const variable = assignment[1];
		if (!variable) continue;
		const remaining = command.slice(
			(assignment.index ?? 0) + assignment[0].length,
		);
		const variableReference = new RegExp(
			`\\$(?:${escapeRegExp(variable)}\\b|\\{${escapeRegExp(variable)}\\})`,
		);
		if (variableReference.test(remaining)) return true;
	}
	return false;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
