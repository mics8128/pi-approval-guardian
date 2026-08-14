import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

function assistantMessage(model: any) {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function textFromToolResult(result: any): string {
	return Array.isArray(result?.content)
		? result.content
				.filter((item: any) => item?.type === "text")
				.map((item: any) => item.text)
				.join("\n")
		: String(result?.content ?? "");
}

function streamSimple(model: any, context: any) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const message: any = assistantMessage(model);
		stream.push({ type: "start", partial: message });
		if (Array.isArray(context.tools) && context.tools.length === 0) {
			const outcome = process.env.PRIME_GUARDIAN_REVIEW_OUTCOME ?? "deny";
			if (outcome === "timeout") return;
			if (outcome === "failure") {
				message.stopReason = "error";
				message.errorMessage = "nested reviewer provider failure";
				stream.push({ type: "error", reason: "error", error: message });
				stream.end();
				return;
			}
			const text = outcome === "invalid"
				? "invalid nested assessment"
				: JSON.stringify({ risk_level: outcome === "allow" ? "low" : "high", user_authorization: "unknown", outcome, rationale: `nested reviewer ${outcome}` });
			message.content.push({ type: "text", text });
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end();
			return;
		}
		const toolResult = [...context.messages]
			.reverse()
			.find(
				(item: any) =>
					item.role === "toolResult" && item.toolCallId === "native-ipython-1",
			);
		if (!toolResult) {
			const marker = process.env.PRIME_GUARDIAN_SMOKE_MARKER;
			if (!marker) throw new Error("PRIME_GUARDIAN_SMOKE_MARKER is required");
			const code = `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("executed")\nprint("IPYTHON_NATIVE_SMOKE")`;
			const toolCall: any = {
				type: "toolCall",
				id: "native-ipython-1",
				name: "ipython",
				arguments: { code },
			};
			message.content.push(toolCall);
			message.stopReason = "toolUse";
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
			stream.push({
				type: "toolcall_delta",
				contentIndex: 0,
				delta: JSON.stringify(toolCall.arguments),
				partial: message,
			});
			stream.push({
				type: "toolcall_end",
				contentIndex: 0,
				toolCall,
				partial: message,
			});
		} else {
			const resultText = textFromToolResult(toolResult);
			const text = toolResult.isError
				? "BLOCKED_OK"
				: resultText.includes("IPYTHON_NATIVE_SMOKE")
					? "ALLOW_OK"
					: `SMOKE_BAD:${resultText}`;
			message.content.push({ type: "text", text });
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			stream.push({
				type: "text_delta",
				contentIndex: 0,
				delta: text,
				partial: message,
			});
			stream.push({
				type: "text_end",
				contentIndex: 0,
				content: text,
				partial: message,
			});
		}
		stream.push({
			type: "done",
			reason: message.stopReason,
			message,
		});
		stream.end();
	});
	return stream;
}

export default function fakePrimeSmokeProvider(pi: ExtensionAPI): void {
	pi.registerProvider("native-smoke", {
		baseUrl: process.env.PRIME_GUARDIAN_FAKE_REVIEW_URL ?? "http://127.0.0.1.invalid",
		apiKey: "unused",
		api: "openai-completions",
		streamSimple,
		models: [
			...[
				["deterministic", "Deterministic native smoke"],
				["guardian-reviewer", "Distinct global Guardian reviewer"],
			].map(([id, name]) => ({
				id,
				name,
				reasoning: false,
				input: ["text"] as Array<"text" | "image">,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32_000,
				maxTokens: 1_000,
			})),
		],
	});
}
