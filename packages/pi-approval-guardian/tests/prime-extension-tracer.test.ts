import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PRIME_TEST_AGENT_DIR = join(tmpdir(), "prime-guardian-test-no-config");
import primeApprovalGuardian, {
	createPrimeApprovalGuardian,
	guardianInputIdentity,
	type PrimeExtensionApi,
	type PrimeToolCallHandler,
	type PrimeTracerReview,
	type PrimeTracerReviewResult,
} from "../../prime-approval-guardian/extensions/index.ts";
import { analyzeIpythonCapabilities } from "../../prime-approval-guardian/src/capability-analysis.ts";
import { sanitizeIpythonCapabilityAnalysis } from "../../prime-approval-guardian/src/normalized-decision.ts";

function loadPrimeToolCallHandler(review: PrimeTracerReview): PrimeToolCallHandler {
	const handlers = new Map<string, PrimeToolCallHandler>();
	createPrimeApprovalGuardian({ review, agentDir: PRIME_TEST_AGENT_DIR })(
		{
			on(name: string, handler: PrimeToolCallHandler) {
				handlers.set(name, handler);
			},
		} as PrimeExtensionApi,
	);
	const handler = handlers.get("tool_call");
	assert.ok(handler, "the Prime extension must register tool-call preflight");
	return handler;
}

test("allows a benign IPython cell after the deterministic reviewer allows it", async () => {
	const requests: unknown[] = [];
	const handler = loadPrimeToolCallHandler(async (request) => {
		requests.push(request);
		return { outcome: "allow" };
	});

	const result = await handler(
		{
			toolName: "ipython",
			toolCallId: "cell-1",
			input: { code: "1 + 1" },
		},
		{},
	);

	assert.equal(result, undefined);
	assert.equal(requests.length, 1);
	assert.deepEqual(requests[0], {
		host: "prime",
		tool: "ipython",
		operation: "execute-cell",
		payload: { code: "1 + 1" },
		cwd: realpathSync(process.cwd()),
		reviewReasons: ["all Prime IPython cells require whole-cell review"],
		privacy: { privateDataRead: false },
		payloadState: { complete: true, originalChars: 5, retainedChars: 5 },
		inputIdentity: requests[0] && (requests[0] as { inputIdentity: string }).inputIdentity,
		capabilityAnalysis: {
			authority: "advisory",
			indicators: [],
			uncertainties: [],
			findings: 0,
			aliasesExamined: 0,
			inputChars: 5,
		},
	});
	assert.match((requests[0] as { inputIdentity: string }).inputIdentity, /^sha256:[a-f0-9]{64}$/);
});


test("adds advisory capability metadata for direct and aliased calls without changing the whole cell", async (t) => {
	for (const [name, code, expected] of [
		["direct", "import requests\nrequests.get('https://example.test')", ["network"]],
		["aliased", "import subprocess as sp\nrun = sp.run\nrun(['opaque'])", ["process"]],
	] as const) {
		await t.test(name, async () => {
			let reviewed: any;
			const handler = loadPrimeToolCallHandler((action) => { reviewed = action; return { outcome: "deny" }; });
			await handler({ toolName: "ipython", toolCallId: name, input: { code } }, {});
			assert.equal(reviewed.payload.code, code);
			assert.deepEqual(reviewed.capabilityAnalysis, {
				authority: "advisory",
				indicators: expected,
				uncertainties: [],
				findings: 1,
				aliasesExamined: name === "aliased" ? 2 : 1,
				inputChars: code.length,
			});
		});
	}
});

test("reports magic and deliberately unresolved dynamic capabilities in the reviewer envelope", async (t) => {
	for (const [name, code, indicators, uncertainties] of [
		["magic", "%%bash\ncurl https://example.test\nrailway up", ["process", "shell-magic", "network", "deployment"], []],
		["dynamic", "target = choose_at_runtime()\ntarget()", [], ["unknown", "dynamic"]],
		["dynamic-execution", "fn = eval(name_from_user)", ["dynamic-execution"], ["dynamic"]],
	] as const) {
		await t.test(name, async () => {
			let reviewed: any;
			const handler = loadPrimeToolCallHandler((action) => { reviewed = action; return { outcome: "deny" }; });
			await handler({ toolName: "ipython", toolCallId: name, input: { code } }, {});
			assert.equal(reviewed.payload.code, code);
			assert.deepEqual(reviewed.capabilityAnalysis.indicators, indicators);
			assert.deepEqual(reviewed.capabilityAnalysis.uncertainties, uncertainties);
			assert.equal(reviewed.capabilityAnalysis.authority, "advisory");
		});
	}
});

test("analysis uncertainty remains explicit and the exact cell is reviewed after bounded analysis adaptation", async (t) => {
	await t.test("truncated analysis", async () => {
		const code = `${"x = 1\n".repeat(3_000)}requests.get('not-retained-by-analysis')`;
		let reviewed: any;
		const handler = loadPrimeToolCallHandler((action) => { reviewed = action; return { outcome: "deny" }; });
		await handler({ toolName: "ipython", toolCallId: "truncated-analysis", input: { code } }, {});
		assert.equal(reviewed.payload.code, code);
		assert.deepEqual(reviewed.capabilityAnalysis.uncertainties, ["truncated"]);
		assert.ok(reviewed.capabilityAnalysis.inputChars > 16_384);
	});
	await t.test("unsupported and unterminated lexical states", async () => {
		for (const code of ["def\0", "print('unterminated"]) {
			let reviewed: any;
			const handler = loadPrimeToolCallHandler((action) => { reviewed = action; return { outcome: "deny" }; });
			await handler({ toolName: "ipython", toolCallId: "unsupported-analysis", input: { code } }, {});
			assert.equal(reviewed.payload.code, code);
			assert.deepEqual(reviewed.capabilityAnalysis.uncertainties, ["unsupported"]);
		}
	});
	await t.test("a fixed analyzer failure still sends the exact cell to review", async () => {
		const code = "complete_whole_cell()";
		let reviewed: any;
		const handler = loadPrimeToolCallHandler((action) => { reviewed = action; return { outcome: "deny" }; });
		const originalIncludes = String.prototype.includes;
		String.prototype.includes = function (search: string, position?: number): boolean {
			if (String(this) === code && search === "\0") throw new Error("sensitive raw analyzer failure");
			return originalIncludes.call(this, search, position);
		};
		try {
			await handler({ toolName: "ipython", toolCallId: "failed-analysis", input: { code } }, {});
		} finally {
			String.prototype.includes = originalIncludes;
		}
		assert.equal(reviewed.payload.code, code);
		assert.deepEqual(reviewed.capabilityAnalysis, {
			authority: "advisory", indicators: [], uncertainties: ["failure"], findings: 0,
			aliasesExamined: 0, inputChars: code.length,
		});
	});
	await t.test("invalid and exotic bounded adapter results become categorical failure", () => {
		const code = "complete_whole_cell()";
		const sparse = new Array(1);
		const getterArray: unknown[] = [];
		Object.defineProperty(getterArray, "0", { get() { throw new Error("must not run"); }, enumerable: true, configurable: true });
		getterArray.length = 1;
		const hostileIterator = ["network"];
		Object.defineProperty(hostileIterator, Symbol.iterator, { value() { throw new Error("must not iterate"); } });
		const base = { authority: "advisory", indicators: [], uncertainties: [], findings: 0, aliasesExamined: 0, inputChars: code.length };
		for (const result of [
			{ authority: "authoritative" },
			new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("sensitive raw analyzer failure"); } }),
			{ ...base, indicators: sparse, findings: 1 },
			{ ...base, indicators: getterArray, findings: 1 },
			{ ...base, indicators: hostileIterator, findings: 1 },
			{ ...base, indicators: ["network", "network"], findings: 2 },
			{ ...base, indicators: ["network"], findings: 0 },
		]) {
			const adapted = sanitizeIpythonCapabilityAnalysis(code.length, result);
			assert.deepEqual(adapted, {
				authority: "advisory", indicators: [], uncertainties: ["failure"], findings: 0,
				aliasesExamined: 0, inputChars: code.length,
			});
			assert.doesNotMatch(JSON.stringify(adapted), /sensitive|raw|failure failure/);
		}
	});
});

test("computed dispatch is conservatively unresolved in the reviewer envelope", async (t) => {
	for (const [name, code] of [
		["getattr", "getattr(module, name)()"],
		["globals", "globals()[name]()"],
		["locals", "locals()[name]()"],
		["dict", "obj.__dict__[name]()"],
	] as const) {
		await t.test(name, async () => {
			let reviewed: any;
			const handler = loadPrimeToolCallHandler((action) => { reviewed = action; return { outcome: "deny" }; });
			await handler({ toolName: "ipython", toolCallId: name, input: { code } }, {});
			assert.equal(reviewed.payload.code, code);
			assert.deepEqual(reviewed.capabilityAnalysis.uncertainties, ["unknown", "dynamic"]);
		});
	}
});

test("alias analysis has bounded representation and fixed category work", () => {
	const aliases = ["import os as a0"];
	for (let index = 1; index < 64; index++) aliases.push(`a${index} = a${index - 1}.a${index - 1}`);
	aliases.push("overflow = a63.a63");
	const code = `${aliases.join("\n")}\na63()`;
	const started = Date.now();
	const result = analyzeIpythonCapabilities(`${code}${" ".repeat(16_384)}`);
	assert.equal(result.aliasesExamined, 64);
	assert.deepEqual(result.uncertainties, ["truncated"]);
	assert.ok(result.indicators.length <= 8);
	assert.ok(JSON.stringify(result).length <= 1024);
	assert.ok(Date.now() - started < 2_000, "bounded analysis should finish under a generous regression guard");
});

test("capability metadata is closed, bounded, categorical, and never authoritative", async () => {
	const code = [
		"from pathlib import Path",
		"import subprocess, requests",
		"Path('secret').read_text()",
		"subprocess.run(['secret'])",
		"requests.post('secret', data='secret')",
		"%run secret.py",
		"railway = 1",
		"skill = 1",
		"rlm('secret')",
		"exec('secret')",
	].join("\n");
	let reviewed: any;
	const handler = loadPrimeToolCallHandler((action) => { reviewed = action; return { outcome: "deny" }; });
	await handler({ toolName: "ipython", toolCallId: "closed", input: { code } }, {});
	assert.deepEqual(reviewed.capabilityAnalysis.indicators, [
		"filesystem", "process", "shell-magic", "network", "deployment", "skill", "rlm-subagent", "dynamic-execution",
	]);
	const serialized = JSON.stringify(reviewed.capabilityAnalysis);
	assert.ok(serialized.length <= 1024);
	assert.doesNotMatch(serialized, /secret|read_text|post|\.py/);
});


test("blocks a denied IPython cell before it can produce a side effect", async () => {
	const handler = loadPrimeToolCallHandler(() => ({
		outcome: "deny",
		reason: "The tracer reviewer denied the cell.",
	}));
	let sideEffect = false;

	const result = await handler(
		{
			toolName: "ipython",
			toolCallId: "cell-denied",
			input: { code: "side_effect()" },
		},
		{},
	);
	if (!result?.block) sideEffect = true;

	assert.deepEqual(result, {
		block: true,
		reason: "The tracer reviewer denied the cell.",
	});
	assert.equal(sideEffect, false);
});


test("fails closed when the tracer reviewer throws", async () => {
	const handler = loadPrimeToolCallHandler(() => {
		throw new Error("reviewer unavailable");
	});

	const result = await handler(
		{
			toolName: "ipython",
			toolCallId: "cell-failure",
			input: { code: "write_marker()" },
		},
		{},
	);

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /review failed/i);
});


test("fails closed on an invalid tracer review result", async () => {
	const handler = loadPrimeToolCallHandler(
		(() => ({ outcome: "unexpected" })) as unknown as PrimeTracerReview,
	);

	const result = await handler(
		{
			toolName: "ipython",
			toolCallId: "cell-invalid",
			input: { code: "write_marker()" },
		},
		{},
	);

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /invalid review result/i);
});


test("packs an explicit Prime-only compatibility tracer", () => {
	const packageDirectory = new URL(
		"../../prime-approval-guardian/",
		import.meta.url,
	);
	const manifest = JSON.parse(
		readFileSync(new URL("package.json", packageDirectory), "utf8"),
	) as {
		name: string;
		description: string;
		keywords: string[];
		pi: { extensions: string[] };
		primeAgent: { compatibility: string };
	};
	const packOutput = JSON.parse(
		execFileSync("npm", ["pack", "--dry-run", "--json"], {
			cwd: fileURLToPath(packageDirectory),
			encoding: "utf8",
		}),
	) as
		| Array<{ files: Array<{ path: string }> }>
		| Record<string, { files: Array<{ path: string }> }>;
	const packed = Array.isArray(packOutput)
		? packOutput
		: Object.values(packOutput);
	const files = packed[0]?.files.map(({ path }) => path) ?? [];

	assert.equal(manifest.name, "prime-approval-guardian");
	assert.equal(manifest.primeAgent.compatibility, ">=0.7.2 <0.8.0");
	assert.deepEqual(manifest.pi.extensions, ["./extensions/index.ts"]);
	assert.ok(manifest.keywords.includes("prime-agent-extension"));
	assert.ok(!manifest.keywords.includes("pi-extension"));
	assert.match(manifest.description, /Prime Agent/);
	assert.ok(files.includes("extensions/index.ts"));
	assert.ok(files.includes("src/normalized-decision.ts"));
	assert.ok(files.includes("src/capability-analysis.ts"));
	assert.ok(files.includes("src/shared-decision.ts"));
	assert.ok(files.includes("src/reviewer.ts"));
	assert.ok(files.includes("src/tool-input-lock.ts"));
	assert.equal(
		readFileSync(new URL("src/shared-decision.ts", packageDirectory), "utf8"),
		readFileSync(new URL("../src/shared-decision.ts", import.meta.url), "utf8"),
		"the packed Prime copy must exactly match the shared Guardian decision source",
	);
	assert.ok(files.includes("README.md"));
	assert.ok(files.includes("LICENSES/Apache-2.0.txt"));
});


test("blocks explicit failure and timeout outcomes", async (t) => {
	for (const outcome of ["failure", "timeout"] as const) {
		await t.test(outcome, async () => {
			const handler = loadPrimeToolCallHandler(() => ({ outcome }));
			const result = await handler(
				{
					toolName: "ipython",
					toolCallId: `cell-${outcome}`,
					input: { code: "write_marker()" },
				},
				{},
			);
			assert.equal(result?.block, true);
			assert.match(result?.reason ?? "", new RegExp(outcome, "i"));
		});
	}
});

test("blocks malformed IPython input without consulting the reviewer", async () => {
	let reviewed = false;
	const handler = loadPrimeToolCallHandler(() => {
		reviewed = true;
		return { outcome: "allow" };
	});
	const result = await handler(
		{ toolName: "ipython", toolCallId: "malformed", input: {} },
		{},
	);
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /malformed IPython input/i);
	assert.equal(reviewed, false);
});

test("leaves non-IPython tools outside this Prime-only tracer", async () => {
	let reviewed = false;
	const handler = loadPrimeToolCallHandler(() => {
		reviewed = true;
		return { outcome: "deny" };
	});
	const result = await handler(
		{
			toolName: "custom-tool",
			toolCallId: "custom",
			input: { code: "not an IPython contract" },
		},
		{},
	);
	assert.equal(result, undefined);
	assert.equal(reviewed, false);
});

test("the packaged default extension blocks IPython without a reviewer", async () => {
	const handlers = new Map<string, PrimeToolCallHandler>();
	primeApprovalGuardian({
		on(name: string, handler: PrimeToolCallHandler) {
			handlers.set(name, handler);
		},
	} as PrimeExtensionApi);
	const handler = handlers.get("tool_call");
	assert.ok(handler);
	const result = await handler(
		{
			toolName: "ipython",
			toolCallId: "default-fail-closed",
			input: { code: "write_marker()" },
		},
		{},
	);
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /configuration was unavailable|model registry is unavailable/i);
});


test("fails closed when a reviewer returns a non-string reason", async () => {
	const handler = loadPrimeToolCallHandler(
		(() => ({ outcome: "deny", reason: 42 })) as unknown as PrimeTracerReview,
	);
	const result = await handler(
		{
			toolName: "ipython",
			toolCallId: "invalid-reason",
			input: { code: "write_marker()" },
		},
		{},
	);
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /invalid review result/i);
});

test("fails closed when reviewer result inspection throws", async () => {
	const hostileResult = new Proxy(
		{},
		{
			has() {
				throw new Error("hostile result");
			},
		},
	);
	const handler = loadPrimeToolCallHandler(
		(() => hostileResult) as unknown as PrimeTracerReview,
	);
	const result = await handler(
		{
			toolName: "ipython",
			toolCallId: "hostile-result",
			input: { code: "write_marker()" },
		},
		{},
	);
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /invalid review result|review failed/i);
});


test("turns a hung reviewer into a blocking timeout", async () => {
	const handlers = new Map<string, PrimeToolCallHandler>();
	createPrimeApprovalGuardian({
		agentDir: PRIME_TEST_AGENT_DIR,
		timeoutMs: 10,
		review: () => new Promise(() => undefined),
	})({
		on(name: string, handler: PrimeToolCallHandler) {
			handlers.set(name, handler);
		},
	} as PrimeExtensionApi);
	const handler = handlers.get("tool_call");
	assert.ok(handler);
	const started = Date.now();
	const result = await handler(
		{
			toolName: "ipython",
			toolCallId: "hung-reviewer",
			input: { code: "write_marker()" },
		},
		{},
	);
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /timeout/i);
	assert.ok(Date.now() - started < 1_000, "preflight must not hang indefinitely");
});


test("the real reviewer uses the current registered model in an isolated tool-free context", async () => {
	const model = { provider: "native-review", id: "safe", api: "fake" };
	const streamCalls: unknown[] = [];
	const handler = (() => {
		const handlers = new Map<string, PrimeToolCallHandler>();
		createPrimeApprovalGuardian({
		agentDir: PRIME_TEST_AGENT_DIR,
			streamModel: async (selected, context, auth, signal) => {
				streamCalls.push({ selected, context, auth, signal: signal instanceof AbortSignal });
				return JSON.stringify({
					risk_level: "low",
					user_authorization: "unknown",
					outcome: "allow",
					rationale: "Pure calculation.",
				});
			},
		})({ on: (name, fn) => handlers.set(name, fn as PrimeToolCallHandler) } as PrimeExtensionApi);
		return handlers.get("tool_call")!;
	})();
	const context = {
		cwd: process.cwd(),
		model,
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, headers: { authorization: "opaque" } }),
		},
		signal: undefined,
	};
	const event = { toolName: "ipython", toolCallId: "real", input: { code: "2 + 2" } };
	assert.equal(await handler(event, context), undefined);
	assert.equal(Object.isFrozen(event.input), true);
	assert.deepEqual(streamCalls, [{
		selected: model,
		context: {
			systemPrompt: (streamCalls[0] as any).context.systemPrompt,
			messages: [{ role: "user", content: [{ type: "text", text: (streamCalls[0] as any).context.messages[0].content[0].text }], timestamp: (streamCalls[0] as any).context.messages[0].timestamp }],
			tools: [],
		},
		auth: { ok: true, headers: { authorization: "opaque" } },
		signal: true,
	}]);
	assert.match((streamCalls[0] as any).context.systemPrompt, /never execute/i);
	assert.match((streamCalls[0] as any).context.messages[0].content[0].text, /"host":"prime"/);
	assert.doesNotMatch(JSON.stringify((streamCalls[0] as any).context), /codex-auto-review/i);
});

test("a configured reviewer model is resolved without synthesizing codex-auto-review", async () => {
	const configured = { provider: "registered", id: "reviewer", api: "fake" };
	let selected: unknown;
	const handlers = new Map<string, PrimeToolCallHandler>();
	createPrimeApprovalGuardian({
		agentDir: PRIME_TEST_AGENT_DIR,
		reviewerModel: "registered/reviewer",
		streamModel: async (model) => {
			selected = model;
			return '{"risk_level":"low","user_authorization":"unknown","outcome":"allow","rationale":"safe"}';
		},
	})({ on: (name, fn) => handlers.set(name, fn as PrimeToolCallHandler) } as PrimeExtensionApi);
	const result = await handlers.get("tool_call")!(
		{ toolName: "ipython", toolCallId: "registered", input: { code: "3 + 3" } },
		{
			cwd: process.cwd(),
			model: { provider: "main", id: "current", api: "fake" },
			modelRegistry: {
				find: (provider: string, id: string) => provider === "registered" && id === "reviewer" ? configured : undefined,
				getApiKeyAndHeaders: async () => ({ ok: true }),
			},
		},
	);
	assert.equal(result, undefined);
	assert.equal(selected, configured);
});

test("default real review blocks auth, provider, invalid assessment, deny and timeout without side effects", async (t) => {
	for (const scenario of ["auth", "provider", "invalid", "type-confusion", "deny", "timeout"] as const) {
		await t.test(scenario, async () => {
			let sideEffect = false;
			const handlers = new Map<string, PrimeToolCallHandler>();
			createPrimeApprovalGuardian({
		agentDir: PRIME_TEST_AGENT_DIR,
				timeoutMs: 10,
				streamModel: async () => {
					if (scenario === "provider") throw new Error("provider unavailable");
					if (scenario === "timeout") return new Promise<string>(() => undefined);
					if (scenario === "invalid") return "not json";
					if (scenario === "type-confusion") {
						return JSON.stringify({
							risk_level: ["critical"],
							user_authorization: "unknown",
							outcome: "allow",
							rationale: "must not bypass strict parsing",
						});
					}
					return JSON.stringify({ risk_level: "high", user_authorization: "unknown", outcome: "deny", rationale: "denied" });
				},
			})({ on: (name, fn) => handlers.set(name, fn as PrimeToolCallHandler) } as PrimeExtensionApi);
			const result = await handlers.get("tool_call")!(
				{ toolName: "ipython", toolCallId: scenario, input: { code: "side_effect()" } },
				{
					cwd: process.cwd(),
					model: { provider: "native", id: "current", api: "fake" },
					modelRegistry: { getApiKeyAndHeaders: async () => scenario === "auth" ? ({ ok: false, error: "missing" }) : ({ ok: true }) },
				},
			);
			if (!result?.block) sideEffect = true;
			assert.equal(result?.block, true);
			assert.equal(sideEffect, false);
		});
	}
});

test("fails closed for incomplete and untrusted whole-cell inputs", async (t) => {
	for (const [name, input] of [
		["incomplete", { code: "x".repeat(64_001) }],
		["untrusted", Object.assign(Object.create({ inherited: true }), { code: "1 + 1" })],
	] as const) {
		await t.test(name, async () => {
			let reviewed = false;
			const handler = loadPrimeToolCallHandler(() => { reviewed = true; return { outcome: "allow" }; });
			const result = await handler({ toolName: "ipython", toolCallId: name, input }, { cwd: process.cwd() });
			assert.equal(result?.block, true);
			assert.equal(reviewed, false);
		});
	}
});


test("external cancellation blocks immediately and aborts a late reviewer", async () => {
	const handlers = new Map<string, PrimeToolCallHandler>();
	const controller = new AbortController();
	let reviewerSignal: AbortSignal | undefined;
	let settleReview: ((value: PrimeTracerReviewResult) => void) | undefined;
	createPrimeApprovalGuardian({
		agentDir: PRIME_TEST_AGENT_DIR,
		timeoutMs: 60_000,
		review: (_action, signal) => {
			reviewerSignal = signal;
			return new Promise((resolve) => {
				settleReview = resolve;
			});
		},
	})({ on: (name, fn) => handlers.set(name, fn as PrimeToolCallHandler) } as PrimeExtensionApi);
	const pending = handlers.get("tool_call")!(
		{ toolName: "ipython", toolCallId: "cancelled", input: { code: "side_effect()" } },
		{ cwd: process.cwd(), signal: controller.signal },
	);
	controller.abort();
	const result = await pending;
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /cancelled/i);
	assert.equal(reviewerSignal?.aborted, true);
	settleReview?.({ outcome: "allow" });
	await Promise.resolve();
	assert.equal(result?.block, true, "late reviewer settlement cannot change the decision");
});

test("fails closed for a proxy that can substitute code after review", async () => {
	let reads = 0;
	const target = { code: "reviewed_cell()" };
	const input = new Proxy(target, {
		get(object, property, receiver) {
			if (property === "code") {
				reads++;
				return reads === 1 ? "reviewed_cell()" : "substituted_cell()";
			}
			return Reflect.get(object, property, receiver);
		},
	});
	let reviewed = false;
	const handler = loadPrimeToolCallHandler(() => {
		reviewed = true;
		return { outcome: "allow" };
	});

	const result = await handler(
		{ toolName: "ipython", toolCallId: "proxy-substitution", input },
		{},
	);

	assert.equal(result?.block, true);
	assert.equal(reviewed, false);
	assert.equal(reads, 0, "proxy traps must not run during rejection");
});

test("recomputes this call's exact identity after review without borrowing a concurrent approval", async () => {
	const releases = new Map<string, () => void>();
	const handler = loadPrimeToolCallHandler(
		(action) => new Promise((resolve) => {
			releases.set(action.payload.code as string, () => resolve({ outcome: "allow" }));
		}),
	);
	const changed = { toolName: "ipython", toolCallId: "changed", input: { code: "first()" } };
	const unchanged = { toolName: "ipython", toolCallId: "unchanged", input: { code: "second()" } };

	const changedPending = handler(changed, {});
	const unchangedPending = handler(unchanged, {});
	await new Promise<void>((resolve) => setImmediate(resolve));
	changed.input.code = "substituted()";
	releases.get("second()")?.();
	releases.get("first()")?.();

	assert.equal(await unchangedPending, undefined);
	const changedResult = await changedPending;
	assert.equal(changedResult?.block, true);
	assert.match(changedResult?.reason ?? "", /input changed/i);
	assert.equal(Object.isFrozen(unchanged.input), true);
});

test("the Prime handler seam prevents later code mutation, replacement, and reordering before execution", async (t) => {
	for (const [name, mutate] of [
		["change", (event: { input: { code: string } }) => { event.input.code = "dangerous()"; }],
		["replace", (event: { input: { code: string } }) => { event.input = { code: "dangerous()" }; }],
		["reorder", (event: { input: { code: string } }) => { event.input.code = event.input.code.split("\n").reverse().join("\n"); }],
	] as const) {
		await t.test(name, async () => {
			const handlers: PrimeToolCallHandler[] = [];
			createPrimeApprovalGuardian({
				review: () => ({ outcome: "allow" }),
				agentDir: PRIME_TEST_AGENT_DIR,
			})({
				on(eventName: string, handler: PrimeToolCallHandler) {
					if (eventName === "tool_call") handlers.push(handler);
				},
			} as PrimeExtensionApi);
			handlers.push(async (event) => {
				mutate(event as { input: { code: string } });
				return undefined;
			});
			const event = { toolName: "ipython", toolCallId: name, input: { code: "first()\nsecond()" } };
			let executed = false;
			await assert.rejects(async () => {
				for (const handler of handlers) {
					const result = await handler(event, {});
					if (result?.block) return;
				}
				executed = true;
			});
			assert.equal(executed, false);
		});
	}
});

test("the identity binds every JSON-like input field", () => {
	const reviewed = guardianInputIdentity({ code: "run()", options: { order: ["a", "b"] } });
	assert.notEqual(
		reviewed,
		guardianInputIdentity({ code: "run()", options: { order: ["b", "a"] } }),
	);
	assert.notEqual(reviewed, guardianInputIdentity({ code: "run()" }));
});

test("an adjacent call cannot reuse the preceding call's approved identity", async () => {
	let releaseSecond: (() => void) | undefined;
	const handler = loadPrimeToolCallHandler((action) => {
		if (action.payload.code === "first()") return { outcome: "allow" };
		return new Promise((resolve) => {
			releaseSecond = () => resolve({ outcome: "allow" });
		});
	});
	const first = { toolName: "ipython", toolCallId: "first", input: { code: "first()" } };
	assert.equal(await handler(first, {}), undefined);
	const second = { toolName: "ipython", toolCallId: "second", input: { code: "second()" } };
	const pending = handler(second, {});
	await new Promise<void>((resolve) => setImmediate(resolve));
	second.input.code = "substituted()";
	releaseSecond?.();
	const result = await pending;

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /input changed/i);
});
