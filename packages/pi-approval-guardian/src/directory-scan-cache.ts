import { performance } from "node:perf_hooks";

export const DIRECTORY_SCAN_CACHE_TTL_MS = 1_000;
export const DIRECTORY_SCAN_CACHE_MAX_ENTRIES = 128;

interface DirectoryScanCacheEntry {
	value: boolean;
	expiresAt: number;
}

export interface DirectoryScanCacheOptions {
	ttlMs?: number;
	maxEntries?: number;
	now?: () => number;
}

/**
 * Small process-local LRU cache for bounded private-path directory scans.
 * Entries are intentionally short-lived and callers must clear the cache after
 * any tool that may mutate the filesystem.
 */
export class DirectoryScanCache {
	private readonly entries = new Map<string, DirectoryScanCacheEntry>();
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	private readonly now: () => number;

	constructor(options: DirectoryScanCacheOptions = {}) {
		this.ttlMs = options.ttlMs ?? DIRECTORY_SCAN_CACHE_TTL_MS;
		this.maxEntries = options.maxEntries ?? DIRECTORY_SCAN_CACHE_MAX_ENTRIES;
		this.now = options.now ?? (() => performance.now());
	}

	get(
		absolutePath: string,
		glob: string | undefined,
		scanLimit: number,
	): boolean | undefined {
		const key = cacheKey(absolutePath, glob, scanLimit);
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= this.now()) {
			this.entries.delete(key);
			return undefined;
		}
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.value;
	}

	set(
		absolutePath: string,
		glob: string | undefined,
		scanLimit: number,
		value: boolean,
	): void {
		if (this.ttlMs <= 0 || this.maxEntries <= 0) return;
		const key = cacheKey(absolutePath, glob, scanLimit);
		this.entries.delete(key);
		this.entries.set(key, {
			value,
			expiresAt: this.now() + this.ttlMs,
		});
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	clear(): void {
		this.entries.clear();
	}

	get size(): number {
		return this.entries.size;
	}
}

function cacheKey(
	absolutePath: string,
	glob: string | undefined,
	scanLimit: number,
): string {
	return JSON.stringify([absolutePath, glob ?? null, scanLimit]);
}
