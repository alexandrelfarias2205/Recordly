import {
	BufferTarget,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedVideoPacketSource,
	type Target as MediabunnyTarget,
	Mp4OutputFormat,
	Output,
	StreamTarget,
} from "mediabunny";
import {
	EXPORT_STREAM_CHUNK_BYTES,
	ExportStreamWriter,
	isExportStreamApiAvailable,
} from "./exportStreamIpc";
import type { ExportConfig } from "./types";

export type MuxerTargetMode = "stream" | "buffer";

export type MuxerFinalizeResult =
	| { mode: "stream"; tempFilePath: string; bytesWritten: number }
	| { mode: "buffer"; blob: Blob };

export class VideoMuxer {
	private output: Output | null = null;
	private videoSource: EncodedVideoPacketSource | null = null;
	private audioSource: EncodedAudioPacketSource | null = null;
	private hasAudio: boolean;
	private target: MediabunnyTarget | null = null;
	private config: ExportConfig;
	private mode: MuxerTargetMode;
	private streamWriter: ExportStreamWriter | null = null;

	constructor(config: ExportConfig, hasAudio = false, mode?: MuxerTargetMode) {
		this.config = config;
		this.hasAudio = hasAudio;
		this.mode = mode ?? (isExportStreamApiAvailable() ? "stream" : "buffer");
	}

	getTargetMode(): MuxerTargetMode {
		return this.mode;
	}

	async initialize(): Promise<void> {
		if (this.mode === "stream") {
			// Mediabunny reuses its buffer once write() resolves, so the writer copies first.
			const writer = new ExportStreamWriter({ extension: "mp4", copyBeforeWrite: true });
			await writer.open();
			this.streamWriter = writer;
			const writableStream = new WritableStream<{
				type: "write";
				data: Uint8Array;
				position: number;
			}>({
				async write(chunk) {
					if (chunk.type !== "write") {
						return;
					}
					await writer.write(chunk.position, chunk.data);
				},
			});
			this.target = new StreamTarget(writableStream, {
				chunked: true,
				chunkSize: EXPORT_STREAM_CHUNK_BYTES,
			});
		} else {
			this.target = new BufferTarget();
		}

		this.output = new Output({
			format: new Mp4OutputFormat({
				fastStart: false,
			}),
			target: this.target,
		});

		this.videoSource = new EncodedVideoPacketSource("avc");
		this.output.addVideoTrack(this.videoSource, {
			frameRate: this.config.frameRate,
		});

		if (this.hasAudio) {
			this.audioSource = new EncodedAudioPacketSource("aac");
			this.output.addAudioTrack(this.audioSource);
		}

		await this.output.start();
	}

	async addVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): Promise<void> {
		if (!this.videoSource) {
			throw new Error("Muxer not initialized");
		}

		const packet = EncodedPacket.fromEncodedChunk(chunk);
		await this.videoSource.add(packet, meta);
	}

	async addAudioChunk(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): Promise<void> {
		if (!this.audioSource) {
			throw new Error("Audio not configured for this muxer");
		}

		const packet = EncodedPacket.fromEncodedChunk(chunk);
		await this.audioSource.add(packet, meta);
	}

	async finalize(): Promise<MuxerFinalizeResult> {
		if (!this.output || !this.target) {
			throw new Error("Muxer not initialized");
		}

		await this.output.finalize();

		if (this.mode === "stream") {
			const writer = this.streamWriter;
			if (!writer?.isOpen) {
				throw new Error("Stream target closed before finalization");
			}
			// The writer clears its stream id before awaiting close, so a concurrent
			// destroy()→abortStream() short-circuits instead of racing us for the same stream.
			const closeResult = await writer.close();
			return {
				mode: "stream",
				tempFilePath: closeResult.tempPath,
				bytesWritten: closeResult.bytesWritten,
			};
		}

		const buffer = (this.target as BufferTarget).buffer;
		if (!buffer) {
			throw new Error("Failed to finalize output");
		}
		return { mode: "buffer", blob: new Blob([buffer], { type: "video/mp4" }) };
	}

	async abortStream(): Promise<void> {
		// Best-effort cleanup on cancel — the main process also reaps stale
		// streams on before-quit via cleanupAllExportStreams.
		await this.streamWriter?.abort();
	}

	destroy(): void {
		this.output = null;
		this.videoSource = null;
		this.audioSource = null;
		this.target = null;
		if (this.streamWriter?.isOpen) {
			void this.abortStream();
		}
	}
}
