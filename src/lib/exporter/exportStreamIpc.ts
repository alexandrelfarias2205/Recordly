/**
 * Chunk boundary shared by every renderer-side writer of the export-stream IPC.
 * 16 MiB is well below Electron's IPC size limits and keeps per-chunk overhead
 * low — large enough that a 35-minute 1080p export only produces a few hundred
 * writes across the renderer/main boundary.
 */
export const EXPORT_STREAM_CHUNK_BYTES = 16 * 1024 * 1024;

export function isExportStreamApiAvailable(): boolean {
	const api = typeof window === "undefined" ? undefined : window.electronAPI;
	return (
		typeof api?.openExportStream === "function" &&
		typeof api?.writeExportStreamChunk === "function" &&
		typeof api?.closeExportStream === "function"
	);
}

export type ExportStreamCloseResult = { tempPath: string; bytesWritten: number };

type ExportStreamWriterOptions = {
	extension: string;
	/** Used in error messages, e.g. "export" -> "Failed to open export stream". */
	label?: string;
	/**
	 * Copy each chunk before the IPC call. Needed when the producer (mediabunny) reuses
	 * its buffer right after the write resolves.
	 */
	copyBeforeWrite?: boolean;
};

/**
 * Sequential/positioned writer backed by the main process export-stream IPC.
 * Keeping media on disk (instead of one huge Blob/ArrayBuffer crossing IPC) is what
 * avoids renderer OOM on long exports.
 */
export class ExportStreamWriter {
	private streamId: string | null = null;
	private readonly extension: string;
	private readonly label: string;
	private readonly copyBeforeWrite: boolean;

	constructor({
		extension,
		label = "export",
		copyBeforeWrite = false,
	}: ExportStreamWriterOptions) {
		this.extension = extension;
		this.label = label;
		this.copyBeforeWrite = copyBeforeWrite;
	}

	get isOpen(): boolean {
		return this.streamId !== null;
	}

	async open(): Promise<void> {
		if (!isExportStreamApiAvailable()) {
			throw new Error("openExportStream IPC is unavailable in this environment");
		}
		const result = await window.electronAPI.openExportStream({ extension: this.extension });
		if (!result.success || !result.streamId || !result.tempPath) {
			throw new Error(result.error || `Failed to open ${this.label} stream`);
		}
		this.streamId = result.streamId;
	}

	async write(position: number, bytes: Uint8Array): Promise<void> {
		if (!this.streamId) {
			throw new Error(`The ${this.label} stream is not open`);
		}
		let payload = bytes;
		if (this.copyBeforeWrite) {
			payload = new Uint8Array(bytes.byteLength);
			payload.set(bytes);
		}
		const result = await window.electronAPI.writeExportStreamChunk(
			this.streamId,
			position,
			payload,
		);
		if (!result.success) {
			throw new Error(result.error || `Failed to write ${this.label} chunk`);
		}
	}

	async close(): Promise<ExportStreamCloseResult> {
		const streamId = this.streamId;
		if (!streamId) {
			throw new Error(`The ${this.label} stream is not open`);
		}
		// Clear first so a concurrent abort() does not race us for the same stream.
		this.streamId = null;
		const result = await window.electronAPI.closeExportStream(streamId, undefined);
		if (!result.success || !result.tempPath) {
			throw new Error(result.error || `Failed to close ${this.label} stream`);
		}
		return { tempPath: result.tempPath, bytesWritten: result.bytesWritten ?? 0 };
	}

	/** Best-effort: drops the stream and its temp file. Never throws. */
	async abort(): Promise<void> {
		const streamId = this.streamId;
		if (!streamId) {
			return;
		}
		this.streamId = null;
		try {
			await window.electronAPI.closeExportStream(streamId, { abort: true });
		} catch {
			// The main process also reaps stale streams on before-quit.
		}
	}
}
