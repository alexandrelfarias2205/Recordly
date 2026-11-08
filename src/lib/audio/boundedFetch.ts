/**
 * Upper bound for loading a whole media file into renderer memory as a decode
 * fallback. Streaming decode is the primary path; this only guards the legacy
 * `fetch` + `decodeAudioData` route so it can never reintroduce an OOM.
 */
export const MAX_IN_MEMORY_AUDIO_DECODE_BYTES = 256 * 1024 * 1024;

export class MediaTooLargeForInMemoryDecodeError extends Error {
	constructor(
		readonly url: string,
		readonly byteLength: number | null,
		readonly maxBytes: number,
	) {
		super(
			`Media is too large to decode in memory (${byteLength ?? "unknown"} bytes > ${maxBytes} bytes): ${url}`,
		);
		this.name = "MediaTooLargeForInMemoryDecodeError";
	}
}

/**
 * Fetches `url` into an ArrayBuffer, refusing before download when
 * Content-Length exceeds `maxBytes` and aborting mid-stream when the body grows
 * past it (for servers that omit the header).
 */
export async function fetchArrayBufferBounded(
	url: string,
	maxBytes = MAX_IN_MEMORY_AUDIO_DECODE_BYTES,
): Promise<ArrayBuffer> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to load media: ${response.status} ${response.statusText}`);
	}

	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel().catch(() => undefined);
		throw new MediaTooLargeForInMemoryDecodeError(url, declared, maxBytes);
	}

	if (!response.body) {
		const buffer = await response.arrayBuffer();
		if (buffer.byteLength > maxBytes) {
			throw new MediaTooLargeForInMemoryDecodeError(url, buffer.byteLength, maxBytes);
		}
		return buffer;
	}

	const reader = response.body.getReader();
	const parts: Uint8Array[] = [];
	let received = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done || !value) break;
			received += value.byteLength;
			if (received > maxBytes) {
				throw new MediaTooLargeForInMemoryDecodeError(url, null, maxBytes);
			}
			parts.push(value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}

	const buffer = new Uint8Array(received);
	let offset = 0;
	for (const part of parts) {
		buffer.set(part, offset);
		offset += part.byteLength;
	}
	return buffer.buffer;
}
