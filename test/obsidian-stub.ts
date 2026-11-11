/**
 * Stand-in for the "obsidian" module, which only exists inside the app. The
 * test runner resolves every import of "obsidian" to this file; tests import
 * it directly to script the network.
 */

export const Platform = { isDesktopApp: false, isMobile: false, isMobileApp: false };

export class TFile {
	path: string;
	name: string;
	basename: string;
	extension: string;
	stat: { mtime: number; ctime: number; size: number };

	constructor(path: string, mtime = 1) {
		this.path = path;
		this.name = path.slice(path.lastIndexOf("/") + 1);
		const dot = this.name.lastIndexOf(".");
		this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
		this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
		this.stat = { mtime, ctime: mtime, size: 0 };
	}
}

export class Notice {
	constructor(public message: string, public duration?: number) {}
	setMessage(message: string): this {
		this.message = message;
		return this;
	}
	hide(): void {}
}

// Base classes the settings UI extends; loading those modules needs them, the tests don't use them.
export class Modal {}
export class SuggestModal {}
export class FuzzySuggestModal {}
export class Setting {}
export function prepareFuzzySearch(): () => null {
	return () => null;
}

// ── requestUrl ──────────────────────────────────────────────────

export interface StubRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	/** Parsed JSON body, when there is one. */
	body: unknown;
}

/** What a handler answers: a status (default 200) and a JSON value or raw text. */
export interface StubResponse {
	status?: number;
	json?: unknown;
	text?: string;
}

type Handler = (req: StubRequest) => StubResponse | Promise<StubResponse>;

let handler: Handler = (req) => {
	throw new Error(`No request handler set for ${req.method} ${req.url}`);
};

/** Requests made since the last onRequest(). */
export const requests: StubRequest[] = [];

/** Answer every requestUrl call with `h` and clear the recorded requests. */
export function onRequest(h: Handler): void {
	handler = h;
	requests.length = 0;
}

export async function requestUrl(param: {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
}) {
	const req: StubRequest = {
		url: param.url,
		method: param.method ?? "GET",
		headers: param.headers ?? {},
		body: typeof param.body === "string" ? JSON.parse(param.body) : undefined,
	};
	requests.push(req);
	const res = await handler(req);
	const text = res.text ?? (res.json === undefined ? "" : JSON.stringify(res.json));
	return {
		status: res.status ?? 200,
		headers: {},
		text,
		get json(): unknown {
			return JSON.parse(text);
		},
		get arrayBuffer(): ArrayBuffer {
			return new TextEncoder().encode(text).buffer;
		},
	};
}
