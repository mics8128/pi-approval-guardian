export interface LockableToolInputEvent {
	input: unknown;
}

export function lockExactToolInput(
	event: LockableToolInputEvent,
	expectedIdentity: string,
	identityOf: (input: unknown) => string,
): void {
	const input = event.input;
	// Keep the identity check adjacent to the irreversible lock. Nothing async may
	// separate the reviewed value from the value protected for execution.
	if (identityOf(input) !== expectedIdentity) {
		throw new Error("Tool input changed after Guardian review began.");
	}
	deepFreeze(input);
	const descriptor = Object.getOwnPropertyDescriptor(event, "input");
	Object.defineProperty(event, "input", {
		value: input,
		enumerable: descriptor?.enumerable ?? true,
		writable: false,
		configurable: false,
	});
}

function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
	if (typeof value !== "object" || value === null || seen.has(value)) return;
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen);
	}
	Object.freeze(value);
}
