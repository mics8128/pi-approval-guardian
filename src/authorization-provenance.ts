import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { GuardianMessage } from "./review.ts";

export const DIRECT_USER_INPUT_ENTRY_TYPE =
	"approval-guardian-direct-user-input";

const DIRECT_USER_INPUT_VERSION = 1;
const MAX_PENDING_INPUTS = 32;

type InputSource = "interactive" | "rpc" | "extension";

export interface InputObservation {
	text: string;
	source: InputSource;
	streamingBehavior?: "steer" | "followUp";
}

export interface UserMessageObservation {
	role: "user";
	content: string | Array<{ type: string; text?: string }>;
	timestamp: number;
}

export interface DirectUserInputRecord {
	version: 1;
	source: "interactive" | "rpc";
	messageTimestamp: number;
	messageTextSha256: string;
	rawText?: string;
}

interface ConfirmedInput {
	input: InputObservation;
	expandedText: string;
}

/**
 * Correlates Pi's pre-expansion input event with the user message emitted later.
 * A confirmed record is persisted separately because Pi's stored user message does
 * not retain whether it came from interactive/RPC input or an extension.
 */
export class DirectUserInputTracker {
	private pending: InputObservation[] = [];
	private confirmed: ConfirmedInput[] = [];

	observe(input: InputObservation): void {
		this.pending.push({ ...input });
		trimQueue(this.pending);
	}

	confirmPrompt(expandedText: string): void {
		if (this.pending.length === 0) return;
		const exactIndex = findLastIndex(
			this.pending,
			(input) => input.text === expandedText,
		);
		const inputIndex = exactIndex >= 0 ? exactIndex : this.pending.length - 1;
		const input = this.pending[inputIndex];
		this.pending.splice(0, inputIndex + 1);
		this.confirmed.push({ input, expandedText });
		trimQueue(this.confirmed);
	}

	recordForMessage(
		message: UserMessageObservation,
	): DirectUserInputRecord | undefined {
		const expandedText = userMessageText(message.content);
		let input: InputObservation | undefined;

		const confirmedIndex = findLastIndex(
			this.confirmed,
			(candidate) => candidate.expandedText === expandedText,
		);
		if (confirmedIndex >= 0) {
			input = this.confirmed[confirmedIndex].input;
			this.confirmed.splice(0, confirmedIndex + 1);
		} else {
			// Queued steering/follow-up messages do not emit before_agent_start.
			// Trust only an exact raw-to-stored match in that path; expanded skill or
			// template content remains untrusted. Prefer the latest exact observation
			// so a newer extension-source message cannot inherit an older direct one.
			const pendingIndex = findLastIndex(
				this.pending,
				(candidate) => candidate.text === expandedText,
			);
			if (pendingIndex >= 0) {
				input = this.pending[pendingIndex];
				this.pending.splice(0, pendingIndex + 1);
			} else {
				// An expanded queued message cannot be correlated safely. Quarantine all
				// queued observations through the latest candidate so none can authorize
				// a later message that happens to equal the original command text.
				const queuedIndex = findLastIndex(
					this.pending,
					(candidate) => candidate.streamingBehavior !== undefined,
				);
				if (queuedIndex >= 0) this.pending.splice(0, queuedIndex + 1);
			}
		}

		if (!input || input.source === "extension") return undefined;
		return {
			version: DIRECT_USER_INPUT_VERSION,
			source: input.source,
			messageTimestamp: message.timestamp,
			messageTextSha256: fingerprint(expandedText),
			...(input.text === expandedText ? {} : { rawText: input.text }),
		};
	}

	reset(): void {
		this.pending = [];
		this.confirmed = [];
	}
}

export function collectGuardianMessages(
	entries: readonly SessionEntry[],
): GuardianMessage[] {
	const records = new Map<string, DirectUserInputRecord[]>();
	const messages: GuardianMessage[] = [];

	for (const entry of entries) {
		if (
			entry.type === "custom" &&
			entry.customType === DIRECT_USER_INPUT_ENTRY_TYPE &&
			isDirectUserInputRecord(entry.data)
		) {
			const key = recordKey(
				entry.data.messageTimestamp,
				entry.data.messageTextSha256,
			);
			const queued = records.get(key) ?? [];
			queued.push(entry.data);
			records.set(key, queued);
			continue;
		}
		if (entry.type !== "message") continue;

		const message = entry.message as GuardianMessage & { timestamp?: number };
		if (message.role !== "user") {
			messages.push(message);
			continue;
		}

		const expandedText = userMessageText(message.content);
		const key =
			typeof message.timestamp === "number"
				? recordKey(message.timestamp, fingerprint(expandedText))
				: undefined;
		const queued = key ? records.get(key) : undefined;
		const record = queued?.shift();
		if (queued && queued.length === 0 && key) records.delete(key);

		if (!record) {
			messages.push({
				role: "user",
				content: message.content,
				authorizationSource: "untrusted",
			});
			continue;
		}

		if (record.rawText !== undefined && record.rawText !== expandedText) {
			messages.push({
				role: "user",
				content: record.rawText,
				authorizationSource: "direct",
			});
			messages.push({
				role: "user",
				content: message.content,
				authorizationSource: "untrusted",
			});
			continue;
		}

		messages.push({
			role: "user",
			content: message.content,
			authorizationSource: "direct",
		});
	}

	return messages;
}

export function userMessageText(
	content: string | Array<{ type: string; text?: string }>,
): string {
	if (typeof content === "string") return content;
	return content
		.filter(
			(part): part is { type: string; text: string } =>
				part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

function fingerprint(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function recordKey(timestamp: number, textSha256: string): string {
	return `${timestamp}:${textSha256}`;
}

function isDirectUserInputRecord(value: unknown): value is DirectUserInputRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<DirectUserInputRecord>;
	return (
		record.version === DIRECT_USER_INPUT_VERSION &&
		(record.source === "interactive" || record.source === "rpc") &&
		typeof record.messageTimestamp === "number" &&
		Number.isFinite(record.messageTimestamp) &&
		typeof record.messageTextSha256 === "string" &&
		/^[a-f0-9]{64}$/.test(record.messageTextSha256) &&
		(record.rawText === undefined || typeof record.rawText === "string")
	);
}

function trimQueue<T>(queue: T[]): void {
	if (queue.length > MAX_PENDING_INPUTS) {
		queue.splice(0, queue.length - MAX_PENDING_INPUTS);
	}
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
	for (let index = items.length - 1; index >= 0; index--) {
		if (predicate(items[index])) return index;
	}
	return -1;
}
