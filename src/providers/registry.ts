import type { EndpointConfig, ProviderType } from "../types";
import type { LLMProvider } from "./types";
import { ollamaProvider } from "./ollama";
import { openaiCompatProvider } from "./openai-compat";
import { openrouterProvider } from "./openrouter";
import { lmstudioProvider } from "./lmstudio";
import { getLogger } from "../logger";
import type { LogCategory } from "../logger";

// ── Provider lookup ─────────────────────────────────────────────

const providers: Record<ProviderType, LLMProvider> = {
	ollama: ollamaProvider,
	"openai-compat": openaiCompatProvider,
	openrouter: openrouterProvider,
	lmstudio: lmstudioProvider,
};

/** Get the provider singleton for a given type. */
export function getProvider(type: ProviderType): LLMProvider {
	return providers[type];
}

/** Get the provider for an endpoint config. */
export function getProviderForEndpoint(ep: EndpointConfig): LLMProvider {
	return getProvider(ep.providerType);
}

// ── Endpoint resolution (with health-check cache) ───────────────

const resolveCache = new Map<
	string,
	{ ep: EndpointConfig; expiresAt: number }
>();
const RESOLVE_TTL_MS = 30_000;

function resolveCacheKey(endpoints: EndpointConfig[]): string {
	return endpoints.map((e) => e.id).join(",");
}

/**
 * Walk the endpoint list in order, health-checking each via its provider.
 * Returns the first reachable endpoint. Caches the result for 30 s.
 */
export async function resolveEndpoint(
	endpoints: EndpointConfig[],
	category: LogCategory = "embed"
): Promise<EndpointConfig> {
	const key = resolveCacheKey(endpoints);
	const cached = resolveCache.get(key);
	if (cached && Date.now() < cached.expiresAt) {
		return cached.ep;
	}

	const log = getLogger();
	log.debug(
		category,
		`Resolving endpoint from ${endpoints.length} candidate(s)`
	);

	for (const ep of endpoints) {
		if (!ep.url) continue;
		try {
			const provider = getProviderForEndpoint(ep);
			log.debug(
				category,
				`  Trying ${ep.name} (${ep.url}, model: ${ep.model}, provider: ${ep.providerType})`
			);
			await provider.healthCheck(ep);
			log.debug(category, `  ✓ ${ep.name} reachable`);
			resolveCache.set(key, {
				ep,
				expiresAt: Date.now() + RESOLVE_TTL_MS,
			});
			return ep;
		} catch (err) {
			log.warn(category, `  ✗ ${ep.name} unreachable`, err);
		}
	}

	resolveCache.delete(key);
	throw new Error(
		`No reachable endpoint (tried ${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"})`
	);
}

/** Clear the resolve cache (e.g. after settings change). */
export function clearResolveCache(): void {
	resolveCache.clear();
}
