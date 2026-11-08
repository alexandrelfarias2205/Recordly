/**
 * Read-only planar PCM source used by the offline audio pipeline.
 * A Web Audio `AudioBuffer` satisfies this interface structurally, so bulk-decoded
 * buffers and chunked streaming-decoded tracks can be consumed the same way.
 */
export interface PcmSource {
	readonly sampleRate: number;
	readonly numberOfChannels: number;
	/** Length in sample frames. */
	readonly length: number;
	/** Duration in seconds. */
	readonly duration: number;
	/**
	 * Copies up to `destination.length` frames of `channelNumber` starting at
	 * `bufferOffset`. Frames past the end of the source are left untouched in
	 * `destination` (an offset at or beyond the end copies nothing).
	 */
	copyFromChannel(destination: Float32Array, channelNumber: number, bufferOffset?: number): void;
}

export type PcmStorageFormat = "float32" | "int16";

/**
 * Sources with more samples than this (frames x channels) are stored as 16-bit
 * integers, halving memory. The threshold is 10 minutes of 48 kHz stereo:
 * ~230 MB as float32 per source, which is fine, while a 68 minute recording is
 * ~1.6 GB per source, which is not. The loss is below the 16-bit quantization
 * floor of the AAC/PCM originals.
 */
export const COMPACT_PCM_STORAGE_MIN_SAMPLES = 10 * 60 * 48_000 * 2;

/**
 * Picks the storage format for a source from its estimated duration.
 * An unknown duration is treated as long, since the cost of guessing short
 * is an out-of-memory crash while the cost of guessing long is 16-bit rounding.
 */
export function resolvePcmStorageFormat(
	durationSec: number | null | undefined,
	sampleRate: number,
	numberOfChannels: number,
): PcmStorageFormat {
	if (durationSec === null || durationSec === undefined || !Number.isFinite(durationSec)) {
		return "int16";
	}
	const estimatedSamples = durationSec * sampleRate * Math.max(1, numberOfChannels);
	return estimatedSamples > COMPACT_PCM_STORAGE_MIN_SAMPLES ? "int16" : "float32";
}

type PcmChunk = Float32Array | Int16Array;

/**
 * Decoded AudioData arrives in ~1024-frame pieces; keeping one typed array per piece
 * would cost ~190k objects per channel for a 68 minute source. Small appends are
 * coalesced into blocks of at least this many frames before being stored.
 */
export const PCM_CHUNK_COALESCE_FRAMES = 32_768;

/**
 * Accumulates decoded PCM chunks per channel without ever building one
 * monolithic AudioBuffer. Reads go through a cumulative frame index.
 *
 * Appended frames are copied into a working block that is stored once it reaches
 * PCM_CHUNK_COALESCE_FRAMES. A partial block is flushed implicitly on the first read
 * (`copyFromChannel`); `length`/`duration` always include not-yet-flushed frames.
 */
export class ChunkedPcmBuffer implements PcmSource {
	readonly sampleRate: number;
	readonly numberOfChannels: number;
	readonly storage: PcmStorageFormat;

	private readonly chunksByChannel: PcmChunk[][];
	// chunkStarts[i] is the first frame of chunk i (same for every channel).
	private readonly chunkStarts: number[] = [];
	private storedFrames = 0;
	private pending: Float32Array[] | null = null;
	private pendingFrames = 0;

	constructor(options: {
		sampleRate: number;
		numberOfChannels: number;
		storage?: PcmStorageFormat;
	}) {
		this.sampleRate = options.sampleRate;
		this.numberOfChannels = options.numberOfChannels;
		this.storage = options.storage ?? "float32";
		this.chunksByChannel = Array.from({ length: options.numberOfChannels }, () => []);
	}

	get length(): number {
		return this.storedFrames + this.pendingFrames;
	}

	get duration(): number {
		return this.length / this.sampleRate;
	}

	/** Appends one decoded chunk (one array per channel, all the same length). The input is copied. */
	append(channels: Float32Array[]): void {
		if (channels.length < this.numberOfChannels) {
			throw new Error(
				`Expected ${this.numberOfChannels} channels, received ${channels.length}`,
			);
		}
		const frames = channels[0]?.length ?? 0;
		for (let ch = 1; ch < this.numberOfChannels; ch++) {
			if (channels[ch].length !== frames) {
				throw new Error("PCM channels in one chunk must have the same length");
			}
		}

		let consumed = 0;
		while (consumed < frames) {
			if (!this.pending) {
				this.pending = Array.from(
					{ length: this.numberOfChannels },
					() => new Float32Array(PCM_CHUNK_COALESCE_FRAMES),
				);
			}
			const count = Math.min(
				PCM_CHUNK_COALESCE_FRAMES - this.pendingFrames,
				frames - consumed,
			);
			for (let ch = 0; ch < this.numberOfChannels; ch++) {
				this.pending[ch].set(
					channels[ch].subarray(consumed, consumed + count),
					this.pendingFrames,
				);
			}
			this.pendingFrames += count;
			consumed += count;
			if (this.pendingFrames === PCM_CHUNK_COALESCE_FRAMES) {
				this.flushPending();
			}
		}
	}

	// Moves the working block into stored chunks (converting to int16 when compact).
	private flushPending(): void {
		const pending = this.pending;
		const frames = this.pendingFrames;
		if (!pending || frames === 0) {
			return;
		}
		for (let ch = 0; ch < this.numberOfChannels; ch++) {
			const block =
				frames === pending[ch].length ? pending[ch] : pending[ch].slice(0, frames);
			this.chunksByChannel[ch].push(this.storage === "int16" ? floatToInt16(block) : block);
		}
		this.chunkStarts.push(this.storedFrames);
		this.storedFrames += frames;
		this.pending = null;
		this.pendingFrames = 0;
	}

	copyFromChannel(destination: Float32Array, channelNumber: number, bufferOffset = 0): void {
		if (channelNumber < 0 || channelNumber >= this.numberOfChannels) {
			throw new RangeError(`Channel ${channelNumber} is out of range`);
		}
		this.flushPending();
		const start = Math.max(0, Math.floor(bufferOffset));
		if (start >= this.storedFrames || destination.length === 0) {
			return;
		}

		const framesToCopy = Math.min(destination.length, this.storedFrames - start);
		const chunks = this.chunksByChannel[channelNumber];
		let chunkIndex = this.findChunkIndex(start);
		let written = 0;

		while (written < framesToCopy && chunkIndex < chunks.length) {
			const chunk = chunks[chunkIndex];
			const chunkStart = this.chunkStarts[chunkIndex];
			const inChunkOffset = start + written - chunkStart;
			const count = Math.min(chunk.length - inChunkOffset, framesToCopy - written);

			if (chunk instanceof Float32Array) {
				destination.set(chunk.subarray(inChunkOffset, inChunkOffset + count), written);
			} else {
				for (let i = 0; i < count; i++) {
					destination[written + i] = chunk[inChunkOffset + i] / 0x8000;
				}
			}
			written += count;
			chunkIndex += 1;
		}
	}

	// Binary search for the last chunk whose start frame is <= frame.
	private findChunkIndex(frame: number): number {
		let low = 0;
		let high = this.chunkStarts.length - 1;
		while (low < high) {
			const mid = (low + high + 1) >>> 1;
			if (this.chunkStarts[mid] <= frame) {
				low = mid;
			} else {
				high = mid - 1;
			}
		}
		return low;
	}
}

function floatToInt16(samples: Float32Array): Int16Array {
	const out = new Int16Array(samples.length);
	for (let i = 0; i < samples.length; i++) {
		const sample = samples[i];
		// NaN falls through to 0; values outside [-1, 1] are clamped.
		const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample || 0;
		out[i] = Math.max(-0x8000, Math.min(0x7fff, Math.round(clamped * 0x8000)));
	}
	return out;
}

/**
 * Materializes `[startFrame, startFrame + frameCount)` of a source as a small
 * AudioBuffer so Web Audio nodes can play just that window.
 */
export function createAudioBufferWindow(
	ctx: BaseAudioContext,
	source: PcmSource,
	startFrame: number,
	frameCount: number,
): AudioBuffer {
	const start = Math.max(0, Math.min(source.length, Math.floor(startFrame)));
	const frames = Math.max(1, Math.min(source.length - start, Math.floor(frameCount)));
	const windowBuffer = ctx.createBuffer(source.numberOfChannels, frames, source.sampleRate);
	for (let ch = 0; ch < source.numberOfChannels; ch++) {
		source.copyFromChannel(windowBuffer.getChannelData(ch), ch, start);
	}
	return windowBuffer;
}
