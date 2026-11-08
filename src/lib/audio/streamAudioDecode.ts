import { WebDemuxer } from "web-demuxer";

/**
 * Planar float32 PCM for one decoded AudioData, capped at `maxChannels`.
 * Missing channels are padded with silence so every chunk has the same shape.
 */
export interface StreamedAudioChunk {
	channels: Float32Array[];
	frames: number;
	timestampUs: number;
}

export interface StreamedAudioConfig {
	sampleRate: number;
	numberOfChannels: number;
	/** Container duration in seconds, or null when the demuxer cannot report it. */
	durationSec: number | null;
	codec: string;
}

export interface StreamAudioDecodeOptions {
	/** Upper bound on delivered channels (default 2). */
	maxChannels?: number;
	/** Max queued decodes before the reader waits (default 20). */
	backpressureLimit?: number;
	isCancelled?: () => boolean;
	onConfig?: (config: StreamedAudioConfig) => void;
}

export interface StreamAudioDecodeResult {
	sampleRate: number;
	numberOfChannels: number;
	totalFrames: number;
}

const DEFAULT_MAX_CHANNELS = 2;
const DEFAULT_BACKPRESSURE_LIMIT = 20;

/** Thrown when `isCancelled()` turns true mid-decode; callers must not treat it as a decode failure. */
export class AudioDecodeCancelledError extends Error {
	constructor() {
		super("Audio decode cancelled");
		this.name = "AudioDecodeCancelledError";
	}
}

export function getWebDemuxerWasmUrl(): string {
	return new URL("./wasm/web-demuxer.wasm", window.location.href).href;
}

/** Convert raw AudioData bytes to float32 samples based on the sample format. */
export function rawAudioSamplesToFloat32(
	bytes: ArrayBuffer,
	format: string,
	sampleCount: number,
): Float32Array {
	if (format.startsWith("f32")) {
		return new Float32Array(bytes);
	}
	if (format.startsWith("s16")) {
		const int16 = new Int16Array(bytes);
		const f32 = new Float32Array(sampleCount);
		for (let i = 0; i < sampleCount; i++) {
			f32[i] = int16[i] / 0x8000;
		}
		return f32;
	}
	if (format.startsWith("s32")) {
		const int32 = new Int32Array(bytes);
		const f32 = new Float32Array(sampleCount);
		for (let i = 0; i < sampleCount; i++) {
			f32[i] = int32[i] / 0x80000000;
		}
		return f32;
	}
	if (format.startsWith("u8")) {
		const uint8 = new Uint8Array(bytes);
		const f32 = new Float32Array(sampleCount);
		for (let i = 0; i < sampleCount; i++) {
			f32[i] = (uint8[i] - 128) / 128;
		}
		return f32;
	}
	// Unknown format — attempt float32 interpretation
	return new Float32Array(bytes);
}

/** Copy one AudioData into planar float32 arrays (capped at `maxChannels`). */
export function audioDataToPlanarFloat32(data: AudioData, maxChannels: number): Float32Array[] {
	const frames = data.numberOfFrames;
	const dataChannels = Math.min(data.numberOfChannels, maxChannels);
	const format = data.format;
	const channels: Float32Array[] = [];

	if (format?.includes("planar")) {
		for (let ch = 0; ch < dataChannels; ch++) {
			const size = data.allocationSize({ planeIndex: ch });
			const bytes = new ArrayBuffer(size);
			data.copyTo(bytes, { planeIndex: ch });
			channels.push(rawAudioSamplesToFloat32(bytes, format, frames));
		}
	} else if (format) {
		// Interleaved — deinterleave using the full source channel count as stride.
		const srcChannels = data.numberOfChannels;
		const size = data.allocationSize({ planeIndex: 0 });
		const bytes = new ArrayBuffer(size);
		data.copyTo(bytes, { planeIndex: 0 });
		const interleaved = rawAudioSamplesToFloat32(bytes, format, frames * srcChannels);
		for (let ch = 0; ch < dataChannels; ch++) {
			const chData = new Float32Array(frames);
			for (let i = 0; i < frames; i++) {
				chData[i] = interleaved[i * srcChannels + ch];
			}
			channels.push(chData);
		}
	}

	if (!format) {
		throw new Error("AudioData has no sample format; refusing to emit silence");
	}

	for (let ch = channels.length; ch < maxChannels; ch++) {
		channels.push(new Float32Array(frames));
	}

	return channels;
}

/**
 * Demux + decode the audio track of `mediaSrc` chunk-by-chunk via WebDemuxer and
 * WebCodecs AudioDecoder, delivering planar float32 PCM to `onChunk` without ever
 * holding the compressed file or the decoded track in one contiguous buffer.
 *
 * Resolves to null when the media has no audio track. Throws on decode errors and
 * throws AudioDecodeCancelledError when cancelled, so a partial track is never
 * mistaken for a complete one. Callers own what they do with each chunk.
 */
export async function streamDecodeAudio(
	mediaSrc: string,
	onChunk: (chunk: StreamedAudioChunk) => void,
	options: StreamAudioDecodeOptions = {},
): Promise<StreamAudioDecodeResult | null> {
	const maxChannels = Math.max(1, options.maxChannels ?? DEFAULT_MAX_CHANNELS);
	const backpressureLimit = options.backpressureLimit ?? DEFAULT_BACKPRESSURE_LIMIT;
	const isCancelled = options.isCancelled ?? (() => false);

	let demuxer: WebDemuxer | null = null;
	try {
		demuxer = new WebDemuxer({ wasmFilePath: getWebDemuxerWasmUrl() });
		await demuxer.load(mediaSrc);

		let audioConfig: AudioDecoderConfig;
		try {
			audioConfig = (await demuxer.getDecoderConfig("audio")) as AudioDecoderConfig;
		} catch {
			return null; // No audio track
		}

		const sampleRate = audioConfig.sampleRate || 48_000;
		const numberOfChannels = Math.min(audioConfig.numberOfChannels || 2, maxChannels);

		let durationSec: number | null = null;
		try {
			const info = await demuxer.getMediaInfo();
			durationSec =
				typeof info?.duration === "number" &&
				Number.isFinite(info.duration) &&
				info.duration > 0
					? info.duration
					: null;
		} catch {
			durationSec = null;
		}
		options.onConfig?.({
			sampleRate,
			numberOfChannels,
			durationSec,
			codec: audioConfig.codec,
		});

		let totalFrames = 0;
		let decodeError: Error | null = null;
		const decodeCapacityWaiters = new Set<() => void>();

		const notifyDecodeCapacityAvailable = () => {
			if (decodeCapacityWaiters.size === 0) {
				return;
			}
			const waiters = [...decodeCapacityWaiters];
			decodeCapacityWaiters.clear();
			for (const resolve of waiters) {
				resolve();
			}
		};

		const waitForDecodeCapacity = () =>
			new Promise<void>((resolve) => {
				decodeCapacityWaiters.add(resolve);
			});

		const decoder = new AudioDecoder({
			output: (data: AudioData) => {
				try {
					if (decodeError || isCancelled()) {
						return;
					}
					const channels = audioDataToPlanarFloat32(data, numberOfChannels);
					totalFrames += data.numberOfFrames;
					onChunk({ channels, frames: data.numberOfFrames, timestampUs: data.timestamp });
				} catch (error) {
					decodeError = error instanceof Error ? error : new Error(String(error));
				} finally {
					data.close();
					notifyDecodeCapacityAvailable();
				}
			},
			error: (err: DOMException) => {
				decodeError = new Error(`Streaming audio decode error: ${err.message}`);
				notifyDecodeCapacityAvailable();
			},
		});

		decoder.configure(audioConfig);

		const audioStream = demuxer.read("audio") as ReadableStream<EncodedAudioChunk>;
		const reader = audioStream.getReader();

		try {
			while (!isCancelled()) {
				if (decodeError) throw decodeError;
				const { done, value: chunk } = await reader.read();
				if (done || !chunk) break;

				decoder.decode(chunk);

				while (decoder.decodeQueueSize > backpressureLimit && !isCancelled()) {
					if (decodeError) throw decodeError;
					await waitForDecodeCapacity();
				}
			}

			if (isCancelled()) {
				throw new AudioDecodeCancelledError();
			}
			if (decoder.state === "configured") {
				await decoder.flush();
			}
			if (decodeError) throw decodeError;
		} finally {
			notifyDecodeCapacityAvailable();
			try {
				await reader.cancel();
			} catch {
				/* reader already closed */
			}
			if (decoder.state !== "closed") {
				decoder.close();
			}
		}

		if (isCancelled()) {
			throw new AudioDecodeCancelledError();
		}
		if (totalFrames === 0) {
			return null;
		}

		return { sampleRate, numberOfChannels, totalFrames };
	} finally {
		try {
			demuxer?.destroy();
		} catch {
			/* cleanup */
		}
	}
}
