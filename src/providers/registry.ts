import type { EndpointConfig, ProviderType } from "../types";
import type { LLMProvider } from "./types";
import { ollamaProvider } from "./ollama";
import { openaiCompatProvider } from "./openai-compat";
import { openrouterProvider } from "./openrouter";
import { lmstudioProvider } from "./lmstudio";
import { errorMessage, withTimeout } from "../errors";
import { redactUrl } from "./http";
import { getLogger } from "../logger";
import type { LogCategory } from "../logger";

const providers: Record<ProviderType, LLMProvider> = {
	ollama: ollamaProvider,
	"openai-compat": openaiCompatProvider,
	openrouter: openrouterProvider,
	lmstudio: lmstudioProvider,
};

export function getProviderForEndpoint(ep: EndpointConfig): LLMProvider {
	return providers[ep.providerType];
}

/**
 * An unreachable LAN or Tailscale host can take a minute to fail at the TCP
 * level, which would stall every request behind the failover check.
 */
const HEALTH_TIMEOUT_MS = 6000;

/** Health-check one endpoint. Throws with a readable reason when it's unusable. */
export async function checkEndpoint(ep: EndpointConfig): Promise<void> {
	if (!ep.url.trim()) throw new Error("No URL set");
	if (!ep.model.trim()) throw new Error("No model set");
	await withTimeout(getProviderForEndpoint(ep).healthCheck(ep), HEALTH_TIMEOUT_MS, "Health check");
}

// ── Endpoint resolution (with health-check cache) ───────────────

const resolveCache = new Map<string, { ep: EndpointConfig; expiresAt: number }>();
const RESOLVE_TTL_MS = 30_000;

function resolveCacheKey(endpoints: EndpointConfig[]): string {
	return endpoints.map((e) => `${e.id}|${e.providerType}|${e.url}|${e.model}`).join(",");
}

/**
 * Walk the endpoint list in order and return the first one that passes its
 * health check. The answer is cached for 30 s.
 */
export async function resolveEndpoint(
	endpoints: EndpointConfig[],
	category: LogCategory,
): Promise<EndpointConfig> {
	const key = resolveCacheKey(endpoints);
	const cached = resolveCache.get(key);
	if (cached && Date.now() < cached.expiresAt) return cached.ep;

	const log = getLogger();
	const failures: string[] = [];
	for (const ep of endpoints) {
		try {
			await checkEndpoint(ep);
			log.debug(category, `Using ${ep.name} (${redactUrl(ep.url)}, ${ep.model})`);
			resolveCache.set(key, { ep, expiresAt: Date.now() + RESOLVE_TTL_MS });
			return ep;
		} catch (err) {
			failures.push(`${ep.name || redactUrl(ep.url)}: ${errorMessage(err)}`);
			log.warn(category, `${ep.name} (${redactUrl(ep.url)}) unreachable`, err);
		}
	}

	resolveCache.delete(key);
	const kind = category === "embed" ? "embedding" : "inference";
	throw new Error(
		endpoints.length === 0
			? `No ${kind} endpoint configured`
			: `No reachable ${kind} endpoint — ${failures.join("; ")}`,
	);
}

/** Forget cached resolutions (after a settings change). */
export function clearResolveCache(): void {
	resolveCache.clear();
}

/** Forget cached resolutions to `ep` (after a request to it failed), so the next request checks the list again. */
export function forgetEndpoint(ep: EndpointConfig): void {
	for (const [key, cached] of resolveCache) if (cached.ep.id === ep.id) resolveCache.delete(key);
}
