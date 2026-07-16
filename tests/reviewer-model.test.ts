// pi-lens-ignore: find-import-file-without-extension
import assert from "node:assert/strict";
import test from "node:test";
// pi-lens-ignore: find-import-file-without-extension
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	OFFICIAL_AUTO_REVIEW_MODEL,
	resolveReviewerModel,
} from "../src/reviewer-session.ts";

const template = {
	id: "gpt-5.4-mini",
	name: "GPT-5.4 Mini",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "", // Test metadata only; no request is sent.
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272_000,
	maxTokens: 128_000,
} as const;

function registryWith(
	find: (provider: string, model: string) => unknown,
): ModelRegistry {
	return { find } as unknown as ModelRegistry;
}

test("resolves a registered custom reviewer channel unchanged", () => {
	const custom = {
		...template,
		provider: "llm-esapp",
		id: "codex-auto-review",
	};
	const registry = registryWith((provider, model) =>
		provider === custom.provider && model === custom.id ? custom : undefined,
	);
	assert.equal(
		resolveReviewerModel(registry, "llm-esapp", "codex-auto-review"),
		custom,
	);
});

test("derives the official hidden auto-review model from Codex transport metadata", () => {
	const registry = registryWith((provider, model) =>
		provider === "openai-codex" && model === "gpt-5.4-mini"
			? template
			: undefined,
	);
	const resolved = resolveReviewerModel(
		registry,
		"openai-codex",
		"codex-auto-review",
	);
	assert.equal(OFFICIAL_AUTO_REVIEW_MODEL, "openai-codex/codex-auto-review");
	assert.equal(resolved?.provider, "openai-codex");
	assert.equal(resolved?.id, "codex-auto-review");
	assert.equal(resolved?.api, "openai-codex-responses");
	assert.equal(resolved?.maxTokens, 10_000);
});

test("does not synthesize hidden models for custom providers", () => {
	const registry = registryWith(() => undefined);
	assert.equal(
		resolveReviewerModel(registry, "custom", "codex-auto-review"),
		undefined,
	);
});
