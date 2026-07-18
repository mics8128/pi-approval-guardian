import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { GuardianReviewResult } from "./gate.ts";

export function lockReviewedToolInput(event: ToolCallEvent): void {
	const input = event.input;
	deepFreezeJsonLike(input);
	const descriptor = Object.getOwnPropertyDescriptor(event, "input");
	Object.defineProperty(event, "input", {
		value: input,
		enumerable: descriptor?.enumerable ?? true,
		writable: false,
		configurable: false,
	});
}

export function lockAllowedToolInput(
	event: ToolCallEvent,
	result: GuardianReviewResult,
): GuardianReviewResult {
	if (result.kind !== "allowed") return result;
	try {
		lockReviewedToolInput(event);
		return result;
	} catch (error) {
		return {
			kind: "failure",
			message: `Approved tool input could not be locked safely: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function deepFreezeJsonLike(value: unknown): void {
	assertJsonLike(value);
	freezeJsonLike(value);
}

function assertJsonLike(
	value: unknown,
	visited = new WeakSet<object>(),
	active = new WeakSet<object>(),
): void {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("non-finite number");
		return;
	}
	if (typeof value !== "object") {
		throw new Error(`non-JSON ${typeof value} value`);
	}
	if (active.has(value)) throw new Error("cyclic object graph");
	if (visited.has(value)) return;
	active.add(value);
	const prototype = Object.getPrototypeOf(value);
	if (Array.isArray(value)) {
		if (prototype !== Array.prototype) {
			throw new Error("array with custom prototype");
		}
		let indexCount = 0;
		for (const key of Reflect.ownKeys(value)) {
			if (key === "length") continue;
			if (typeof key === "symbol") throw new Error("symbol-keyed property");
			const index = Number(key);
			if (
				!Number.isInteger(index) ||
				index < 0 ||
				String(index) !== key ||
				index >= value.length
			) {
				throw new Error(`non-JSON array property ${key}`);
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
				throw new Error(`non-JSON array index ${key}`);
			}
			indexCount++;
			assertJsonLike(descriptor.value, visited, active);
		}
		if (indexCount !== value.length) throw new Error("sparse array");
	} else {
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error(
				`non-plain object ${prototype?.constructor?.name ?? "unknown"}`,
			);
		}
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key === "symbol") throw new Error("symbol-keyed property");
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
				throw new Error(`non-JSON property ${key}`);
			}
			assertJsonLike(descriptor.value, visited, active);
		}
	}
	active.delete(value);
	visited.add(value);
}

function freezeJsonLike(value: unknown, seen = new WeakSet<object>()): void {
	if (typeof value !== "object" || value === null || seen.has(value)) return;
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && "value" in descriptor) freezeJsonLike(descriptor.value, seen);
	}
	Object.freeze(value);
}
