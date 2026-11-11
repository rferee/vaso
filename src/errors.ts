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

/**
 * Reject with the abort reason as soon as `signal` aborts, unless `promise`
 * settles first. For work that can't be cancelled: it goes on, and its late
 * result is dropped.
 */
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortError(signal));
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

export function isTimeoutError(err: unknown): boolean {
	return err instanceof Error && err.name === "TimeoutError";
}

/** Reject after `ms` with a timeout error (see isTimeoutError), unless `promise` settles first. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => {
			const err = new Error(`${what} timed out after ${Math.round(ms / 1000)} s`);
			err.name = "TimeoutError";
			reject(err);
		}, ms);
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
