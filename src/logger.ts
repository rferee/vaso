import type { DataAdapter } from "obsidian";

export type LogLevel = "error" | "warn" | "info" | "debug";
export type LogCategory =
	| "index"
	| "embed"
	| "infer"
	| "search"
	| "context"
	| "cache"
	| "main"
	| "settings";

export interface LoggerConfig {
	enabled: boolean;
	maxFileSizeBytes: number;
	flushIntervalMs: number;
}

const LOG_FILE = "vaso-debug.log";

/** Truncate a value to a short string for log output. */
function serialize(v: unknown): string {
	if (v instanceof Error) return v.message;
	if (typeof v === "string") return v;
	try {
		const s = JSON.stringify(v);
		return s.length > 500 ? s.slice(0, 500) + "…" : s;
	} catch {
		return String(v);
	}
}

export class DebugLogger {
	private adapter: DataAdapter;
	private logPath: string;
	private config: LoggerConfig;
	private buffer: string[] = [];
	private flushTimer: ReturnType<typeof setInterval> | null = null;
	private isFlushing = false;

	constructor(adapter: DataAdapter, pluginDir: string, config: LoggerConfig) {
		this.adapter = adapter;
		this.logPath = pluginDir ? `${pluginDir}/${LOG_FILE}` : LOG_FILE;
		this.config = { ...config };
		if (this.config.enabled) {
			this.startTimer();
		}
	}

	// ── Public API ──────────────────────────────────────────

	debug(category: LogCategory, message: string, ...data: unknown[]): void {
		console.log(`[Vaso] ${message}`, ...data);
		this.pushLine("DEBUG", category, message, data);
	}

	info(category: LogCategory, message: string, ...data: unknown[]): void {
		console.log(`[Vaso] ${message}`, ...data);
		this.pushLine("INFO", category, message, data);
	}

	warn(category: LogCategory, message: string, ...data: unknown[]): void {
		console.warn(`[Vaso] ${message}`, ...data);
		this.pushLine("WARN", category, message, data);
	}

	error(category: LogCategory, message: string, ...data: unknown[]): void {
		console.error(`[Vaso] ${message}`, ...data);
		this.pushLine("ERROR", category, message, data);
	}

	updateConfig(patch: Partial<LoggerConfig>): void {
		const wasEnabled = this.config.enabled;
		Object.assign(this.config, patch);
		if (this.config.enabled && !wasEnabled) {
			this.startTimer();
		} else if (!this.config.enabled && wasEnabled) {
			this.stopTimer();
		}
	}

	async flush(): Promise<void> {
		if (this.isFlushing || this.buffer.length === 0) return;
		this.isFlushing = true;
		try {
			const chunk = this.buffer.join("\n") + "\n";
			this.buffer.length = 0;

			// Rotate if over size limit
			try {
				const stat = await this.adapter.stat(this.logPath);
				if (stat && stat.size >= this.config.maxFileSizeBytes) {
					await this.adapter.remove(this.logPath);
				}
			} catch { /* file may not exist yet — fine */ }

			await this.adapter.append(this.logPath, chunk);
		} catch (err) {
			// Never break the plugin — log to console as last resort
			console.warn("[Vaso] Log flush failed:", err);
		} finally {
			this.isFlushing = false;
		}
	}

	async destroy(): Promise<void> {
		this.stopTimer();
		await this.flush();
	}

	// ── Internals ───────────────────────────────────────────

	private pushLine(level: string, category: LogCategory, message: string, data: unknown[]): void {
		if (!this.config.enabled) return;
		const ts = new Date().toISOString();
		let line = `[${ts}] [${level}] [${category}] ${message}`;
		if (data.length > 0) {
			line += " " + data.map(serialize).join(" ");
		}
		this.buffer.push(line);
	}

	private startTimer(): void {
		if (this.flushTimer) return;
		this.flushTimer = setInterval(() => {
			this.flush();
		}, this.config.flushIntervalMs);
	}

	private stopTimer(): void {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
	}
}

// ── Singleton ───────────────────────────────────────────────────

/** Surface used by the rest of the plugin — DebugLogger and the console fallback both implement this. */
export type Logger = Pick<DebugLogger, "debug" | "info" | "warn" | "error" | "updateConfig" | "flush" | "destroy">;

let instance: DebugLogger | null = null;

export function initLogger(adapter: DataAdapter, pluginDir: string, config: LoggerConfig): DebugLogger {
	instance = new DebugLogger(adapter, pluginDir, config);
	return instance;
}

/** Console-only fallback used before initLogger() runs (or after destroy). */
const consoleFallback: Logger = {
	debug: (_c, m, ...d) => console.log(`[Vaso] ${m}`, ...d),
	info:  (_c, m, ...d) => console.log(`[Vaso] ${m}`, ...d),
	warn:  (_c, m, ...d) => console.warn(`[Vaso] ${m}`, ...d),
	error: (_c, m, ...d) => console.error(`[Vaso] ${m}`, ...d),
	updateConfig: () => { /* no-op */ },
	flush: () => Promise.resolve(),
	destroy: () => Promise.resolve(),
};

export function getLogger(): Logger {
	return instance ?? consoleFallback;
}
