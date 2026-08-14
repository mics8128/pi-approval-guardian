export const IPYTHON_CAPABILITY_INDICATORS = [
	"filesystem", "process", "shell-magic", "network", "deployment", "skill", "rlm-subagent", "dynamic-execution",
] as const;
export type IpythonCapabilityIndicator = typeof IPYTHON_CAPABILITY_INDICATORS[number];

export const IPYTHON_ANALYSIS_UNCERTAINTIES = [
	"unknown", "dynamic", "unsupported", "truncated", "failure",
] as const;
export type IpythonAnalysisUncertainty = typeof IPYTHON_ANALYSIS_UNCERTAINTIES[number];

export interface IpythonCapabilityAnalysis {
	authority: "advisory";
	indicators: IpythonCapabilityIndicator[];
	uncertainties: IpythonAnalysisUncertainty[];
	findings: number;
	aliasesExamined: number;
	inputChars: number;
}

const ANALYSIS_CHAR_LIMIT = 16_384;
const ALIAS_LIMIT = 64;
const ALIAS_TARGET_CHAR_LIMIT = 256;
const RULES: ReadonlyArray<readonly [IpythonCapabilityIndicator, RegExp]> = [
	["filesystem", /\b(?:pathlib|shutil|glob|tempfile|os\.(?:open|remove|unlink|rename|replace|mkdir|makedirs|rmdir|listdir|walk)|open)\b/],
	["process", /\b(?:subprocess|multiprocessing|os\.(?:system|popen|spawn\w*|exec\w*|fork)|Process)\b/],
	["network", /\b(?:requests|httpx|urllib|aiohttp|socket|websocket|ftplib|smtplib)\b/],
	["deployment", /\b(?:railway|vercel|kubectl|helm|terraform|pulumi|docker)\b/i],
	["skill", /\b(?:skill|agentcloak|websearch|attach_image)\b/i],
	["rlm-subagent", /\b(?:rlm|subagent|agent_message|agent_observe)\b/i],
	["dynamic-execution", /\b(?:eval|exec|compile|__import__|importlib\.(?:import_module|reload))\b/],
];

// This is deliberately a small lexical assessment, not a Python interpreter or
// authorization mechanism. It retains at most 16,384 characters, 64 aliases
// with 256-character targets, and evaluates the eight closed categories.
export function analyzeIpythonCapabilities(code: string): IpythonCapabilityAnalysis {
	const inputChars = code.length;
	const source = code.slice(0, ANALYSIS_CHAR_LIMIT);
	const indicators = new Set<IpythonCapabilityIndicator>();
	const uncertainties = new Set<IpythonAnalysisUncertainty>();
	if (inputChars > source.length) uncertainties.add("truncated");
	if (source.includes("\0") || /(^|\n)\s*(?:async\s+)?(?:def|class)\s*$/m.test(source)) uncertainties.add("unsupported");

	const lexicalResult = eraseLiteralsAndComments(source);
	const lexical = lexicalResult.text;
	if (lexicalResult.unsupported) uncertainties.add("unsupported");
	const aliases = collectAliases(lexical, uncertainties);

	const magic = source.split("\n").some((line) => /^\s*(?:!|%%?\w+)/.test(line));
	if (magic) indicators.add("shell-magic");
	applyRules(lexical, indicators);
	// Targets are inspected separately. No source or intermediate string is ever
	// rewritten, so alias chains cannot amplify the representation.
	for (const target of aliases.values()) applyRules(target, indicators);
	if (magic) applyMagicRules(source, indicators);

	if (/\b([A-Za-z_]\w*)\s*=\s*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*\([^\n]*\)[^\n]*(?:\n|;)[\s\S]{0,2048}\b\1\s*\(/.test(lexical)) markDynamic(uncertainties);
	if (/(?:\bgetattr\s*\([^\n)]{1,1024}\)|\b(?:globals|locals)\s*\(\s*\)\s*\[[^\]\n]{1,1024}\]|\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\.__dict__\s*\[[^\]\n]{1,1024}\])\s*\(/.test(lexical)) markDynamic(uncertainties);
	if (/\b(?:eval|exec|compile|__import__)\s*\(|\bimportlib\.(?:import_module|reload)\s*\(/.test(lexical)) uncertainties.add("dynamic");
	return {
		authority: "advisory",
		indicators: IPYTHON_CAPABILITY_INDICATORS.filter((value) => indicators.has(value)),
		uncertainties: IPYTHON_ANALYSIS_UNCERTAINTIES.filter((value) => uncertainties.has(value)),
		findings: indicators.size,
		aliasesExamined: aliases.size,
		inputChars,
	};
}

export function failedIpythonCapabilityAnalysis(inputChars: number): IpythonCapabilityAnalysis {
	return { authority: "advisory", indicators: [], uncertainties: ["failure"], findings: 0, aliasesExamined: 0, inputChars };
}

function collectAliases(source: string, uncertainties: Set<IpythonAnalysisUncertainty>): Map<string, string> {
	const aliases = new Map<string, string>();
	const aliasPattern = /(?:^|\n)\s*(?:import\s+([A-Za-z_]\w*)(?:\.[A-Za-z_]\w*)*(?:\s+as\s+([A-Za-z_]\w*))?|from\s+([A-Za-z_]\w*)(?:\.[A-Za-z_]\w*)*\s+import\s+([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?|([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+))\s*(?=\n|;|$)/g;
	let match: RegExpExecArray | null = null;
	while (aliases.size < ALIAS_LIMIT && (match = aliasPattern.exec(source))) {
		if (match[1]) aliases.set(match[2] ?? match[1], match[1].slice(0, ALIAS_TARGET_CHAR_LIMIT));
		else if (match[3] && match[4]) aliases.set(match[5] ?? match[4], `${match[3]}.${match[4]}`.slice(0, ALIAS_TARGET_CHAR_LIMIT));
		else if (match[6] && match[7]) aliases.set(match[6], resolveAlias(match[7], aliases));
	}
	if (countAliasCandidates(source) > ALIAS_LIMIT) uncertainties.add("truncated");
	return aliases;
}
function applyRules(source: string, found: Set<IpythonCapabilityIndicator>): void {
	for (const [indicator, rule] of RULES) if (rule.test(source)) found.add(indicator);
}
function applyMagicRules(source: string, found: Set<IpythonCapabilityIndicator>): void {
	const magicLines = source.split("\n").filter((line) => /^\s*(?:!|%%?\w+)/.test(line) || /^(?:curl|wget|railway|vercel|kubectl|helm|terraform|docker)\b/i.test(line.trim()));
	const commands = magicLines.join("\n");
	if (/\b(?:curl|wget|ssh|scp|nc)\b/i.test(commands)) found.add("network");
	if (/\b(?:railway|vercel|kubectl|helm|terraform|pulumi|docker)\b/i.test(commands)) found.add("deployment");
	if (/\b(?:python|node|sh|bash|zsh|pwsh)\b/i.test(commands)) found.add("process");
}
function markDynamic(uncertainties: Set<IpythonAnalysisUncertainty>): void {
	uncertainties.add("unknown"); uncertainties.add("dynamic");
}
function resolveAlias(value: string, aliases: Map<string, string>): string {
	const dot = value.indexOf(".");
	const head = dot < 0 ? value : value.slice(0, dot);
	const tail = dot < 0 ? "" : value.slice(dot);
	return `${aliases.get(head) ?? head}${tail}`.slice(0, ALIAS_TARGET_CHAR_LIMIT);
}
function countAliasCandidates(source: string): number {
	return (source.match(/(?:^|\n)\s*(?:import|from|[A-Za-z_]\w*\s*=)/g) ?? []).length;
}
function eraseLiteralsAndComments(source: string): { text: string; unsupported: boolean } {
	let output = ""; let quote = ""; let triple = false; let escaped = false;
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (quote) {
			output += char === "\n" ? "\n" : " ";
			if (escaped) { escaped = false; continue; }
			if (char === "\\") { escaped = true; continue; }
			if (triple && source.slice(index, index + 3) === quote.repeat(3)) { output += "  "; index += 2; quote = ""; triple = false; }
			else if (!triple && char === quote) quote = "";
			continue;
		}
		if (char === "#") { while (index < source.length && source[index] !== "\n") { output += " "; index++; } if (index < source.length) output += "\n"; continue; }
		if (char === "'" || char === '"') { quote = char; triple = source.slice(index, index + 3) === char.repeat(3); output += triple ? "   " : " "; if (triple) index += 2; continue; }
		output += char;
	}
	return { text: output, unsupported: quote !== "" || escaped };
}
