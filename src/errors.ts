/** Short human-readable message for any thrown value. */
export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "object" && err !== null && "status" in err) {
		return `HTTP ${String((err as { status: unknown }).status)}`;
	}
	return String(err);
}

export function isAbortError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"name" in err &&
		(err as { name: unknown }).name === "AbortError"
	);
}

export function abortError(signal?: AbortSignal): unknown {
	return signal?.reason ?? new DOMException("Aborted", "AbortError");
}

/** Reject after `ms` with a timeout error, unless `promise` settles first. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(
			() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)),
			ms,
		);
		promise.then(
			(v) => {
				window.clearTimeout(timer);
				resolve(v);
			},
			(e: unknown) => {
				window.clearTimeout(timer);
				reject(e);
			},
		);
	});
}
