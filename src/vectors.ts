/**
 * Embedding vectors are kept as unit-length Float32Arrays: half the memory of
 * number[], cosine similarity becomes a plain dot product, and they serialise
 * to compact base64.
 */

export type Vector = Float32Array;

/** Copy `v` into a unit-length Float32Array (all zeros stays all zeros). */
export function toUnitVector(v: ArrayLike<number>): Vector {
	let mag = 0;
	for (let i = 0; i < v.length; i++) {
		const x = v[i]!;
		mag += x * x;
	}
	const inv = mag > 0 ? 1 / Math.sqrt(mag) : 0;
	const out = new Float32Array(v.length);
	for (let i = 0; i < v.length; i++) out[i] = v[i]! * inv;
	return out;
}

/** Dot product; equals cosine similarity for unit vectors. */
export function dot(a: Vector, b: Vector): number {
	const n = Math.min(a.length, b.length);
	let sum = 0;
	for (let i = 0; i < n; i++) sum += a[i]! * b[i]!;
	return sum;
}

export function encodeVector(v: Vector): string {
	const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
	let bin = "";
	const step = 0x8000;
	for (let i = 0; i < bytes.length; i += step) {
		bin += String.fromCharCode(...bytes.subarray(i, i + step));
	}
	return btoa(bin);
}

export function decodeVector(s: string): Vector {
	const bin = atob(s);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Float32Array(bytes.buffer);
}
