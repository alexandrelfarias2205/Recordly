import { fetchArrayBufferBounded } from "@/lib/audio/boundedFetch";
import { streamDecodeAudio } from "@/lib/audio/streamAudioDecode";
import { WAVEFORM_DEFAULT_PEAK_COUNT } from "../../timeline/core/constants";
import type { AudioPeaksData } from "../../timeline/core/timelineTypes";
import { getAudioResourceCacheScope, getAudioResourceVersionKey } from "../audioResourceVersion";
import WorkerConstructor from "./waveform.worker?worker";
import { VersionedWaveformCache } from "./waveformCache";

const MAX_WAVEFORM_PEAKS = 200_000;
const MAX_WAVEFORM_CACHE_ENTRIES = 24;
// Fine-grained block size for streaming peaks (750 blocks/s, above the 500 peaks/s target).
const PEAK_BLOCKS_PER_SECOND = 750;
const PEAK_BLOCK_FRAMES = 64; // default until the sample rate is known

function getPeakBlockFrames(sampleRate: number) {
	return Math.max(1, Math.floor(sampleRate / PEAK_BLOCKS_PER_SECOND));
}

/** Thrown when the media has no decodable audio track (no fallback is attempted). */
export class NoAudioTrackError extends Error {
	constructor(readonly url: string) {
		super(`Media has no audio track: ${url}`);
		this.name = "NoAudioTrackError";
	}
}

/** Accumulates max(|sample|) over all channels in fixed-size blocks with bounded memory. */
export class PeakBlockAccumulator {
	private blocks: Float32Array;
	private blockCount = 0;
	private currentMax = 0;
	private currentFrames = 0;

	constructor(
		private readonly blockFrames = PEAK_BLOCK_FRAMES,
		expectedBlocks = 1024,
	) {
		this.blocks = new Float32Array(Math.max(16, expectedBlocks));
	}

	private pushBlock(value: number) {
		if (this.blockCount >= this.blocks.length) {
			const grown = new Float32Array(this.blocks.length * 2);
			grown.set(this.blocks);
			this.blocks = grown;
		}
		this.blocks[this.blockCount++] = value;
	}

	add(channels: Float32Array[], frames: number) {
		for (let i = 0; i < frames; i++) {
			for (let c = 0; c < channels.length; c++) {
				const val = Math.abs(channels[c][i]);
				if (val > this.currentMax) this.currentMax = val;
			}
			if (++this.currentFrames >= this.blockFrames) {
				this.pushBlock(this.currentMax);
				this.currentMax = 0;
				this.currentFrames = 0;
			}
		}
	}

	/** Returns an exact-size copy of the accumulated blocks (flushes the partial block). */
	finish(): Float32Array {
		if (this.currentFrames > 0) {
			this.pushBlock(this.currentMax);
			this.currentMax = 0;
			this.currentFrames = 0;
		}
		return this.blocks.slice(0, this.blockCount);
	}
}

/** Robust normalization: the 99.5th percentile avoids being squashed by a single spike. */
function normalizePeaks(peaks: Float32Array) {
	let max = 0;
	const sortedPeaks = [...peaks].sort((a, b) => a - b);
	const percentileIndex = Math.floor(sortedPeaks.length * 0.995);
	const robustMax = sortedPeaks[percentileIndex] || 0;

	// Fallback to absolute max if the percentile is zero (very quiet file)
	if (robustMax === 0) {
		for (let i = 0; i < peaks.length; i++) {
			if (peaks[i] > max) max = peaks[i];
		}
	} else {
		max = robustMax;
	}

	if (max > 0) {
		for (let i = 0; i < peaks.length; i++) {
			peaks[i] = Math.min(1.0, peaks[i] / max);
		}
	}
}

function getBoundedPeakCount(peakCount: number, durationSec: number) {
	return Math.min(Math.max(peakCount, Math.floor(durationSec * 500)), MAX_WAVEFORM_PEAKS);
}

export class WaveformGenerator {
	private audioContext: AudioContext | null = null;
	private worker: Worker;
	private peaksCache = new VersionedWaveformCache<AudioPeaksData>(MAX_WAVEFORM_CACHE_ENTRIES);
	private pending = new Map<string, Promise<AudioPeaksData>>();
	private workerRequestSeq = 0;
	private workerResolvers = new Map<
		number,
		{ resolve: (peaks: Float32Array) => void; reject: (err: Error) => void }
	>();

	constructor() {
		this.worker = new WorkerConstructor();

		this.worker.addEventListener(
			"message",
			(event: MessageEvent<{ requestId: number; peaks?: Float32Array; error?: string }>) => {
				const { requestId, peaks, error } = event.data;
				const resolver = this.workerResolvers.get(requestId);
				if (!resolver) return;

				this.workerResolvers.delete(requestId);
				if (error) {
					resolver.reject(new Error(error));
				} else if (peaks) {
					resolver.resolve(peaks);
				}
			},
		);

		this.worker.addEventListener("error", (error: ErrorEvent) => {
			console.error("[WaveformGenerator] Worker fatal error:", error);
			const fatalError = error.error ?? new Error(error.message || "Worker crashed");

			// Reject all pending requests if the worker itself crashes
			for (const resolver of this.workerResolvers.values()) {
				resolver.reject(fatalError);
			}
			this.workerResolvers.clear();
		});
	}

	private computePeaksWithWorker(
		channels: Float32Array[],
		samples: number,
	): Promise<Float32Array> {
		return new Promise((resolve, reject) => {
			const requestId = ++this.workerRequestSeq;
			this.workerResolvers.set(requestId, { resolve, reject });

			this.worker.postMessage(
				{
					requestId,
					channels,
					samples,
				},
				channels.map((c) => c.buffer),
			);
		});
	}

	private async computeStreamedPeaks(url: string, peakCount: number) {
		let accumulator = new PeakBlockAccumulator();
		const decoded = await streamDecodeAudio(
			url,
			(chunk) => accumulator.add(chunk.channels, chunk.frames),
			{
				maxChannels: 2,
				onConfig: (config) => {
					// Keep ~750 blocks/s at any sample rate so the 500 peaks/s target is never upsampled.
					const blockFrames = getPeakBlockFrames(config.sampleRate);
					accumulator = new PeakBlockAccumulator(
						blockFrames,
						config.durationSec
							? Math.ceil((config.durationSec * config.sampleRate) / blockFrames) + 16
							: undefined,
					);
				},
			},
		);
		if (!decoded || decoded.totalFrames <= 0) {
			throw new NoAudioTrackError(url);
		}
		const durationSec = decoded.totalFrames / decoded.sampleRate;
		const blocks = accumulator.finish();
		const peaks = await this.computePeaksWithWorker(
			[blocks],
			getBoundedPeakCount(peakCount, durationSec),
		);
		return { peaks, durationMs: durationSec * 1000 };
	}

	private async computeFullDecodePeaks(url: string, peakCount: number) {
		// Bounded: throws MediaTooLargeForInMemoryDecodeError instead of risking an OOM.
		const arrayBuffer = await fetchArrayBufferBounded(url);
		if (!this.audioContext) {
			this.audioContext = new (
				window.AudioContext ||
				(window as typeof window & { webkitAudioContext?: typeof AudioContext })
					.webkitAudioContext
			)();
		}
		const decoded = await this.audioContext.decodeAudioData(arrayBuffer);
		const channels: Float32Array[] = [];
		for (let i = 0; i < decoded.numberOfChannels; i++) {
			// We slice to transfer the underlying buffer to the worker
			channels.push(decoded.getChannelData(i).slice());
		}
		const peaks = await this.computePeaksWithWorker(
			channels,
			getBoundedPeakCount(peakCount, decoded.duration),
		);
		return { peaks, durationMs: decoded.duration * 1000 };
	}

	public async generate(
		url: string,
		peakCount = WAVEFORM_DEFAULT_PEAK_COUNT,
		resourceVersion = 0,
	): Promise<AudioPeaksData> {
		const cacheScope = `${getAudioResourceCacheScope(url)}::${peakCount}`;
		const cacheKey = getAudioResourceVersionKey(cacheScope, resourceVersion);
		this.peaksCache.activate(cacheScope, cacheKey);
		const cached = this.peaksCache.get(cacheKey);
		if (cached) return cached;

		const inflight = this.pending.get(cacheKey);
		if (inflight) return inflight;

		const request = (async () => {
			let computed: { peaks: Float32Array; durationMs: number };
			try {
				computed = await this.computeStreamedPeaks(url, peakCount);
			} catch (streamError) {
				if (streamError instanceof NoAudioTrackError) throw streamError;
				console.warn(
					`[WaveformGenerator] Streaming decode failed for ${url}, falling back to bounded full decode:`,
					streamError,
				);
				computed = await this.computeFullDecodePeaks(url, peakCount);
			}
			const { peaks } = computed;
			normalizePeaks(peaks);

			const result: AudioPeaksData = {
				peaks,
				durationMs: computed.durationMs,
			};
			this.peaksCache.setIfCurrent(cacheScope, cacheKey, result);
			this.pending.delete(cacheKey);
			return result;
		})().catch((error) => {
			this.pending.delete(cacheKey);
			this.peaksCache.deactivateIfCurrent(cacheScope, cacheKey);
			throw error;
		});

		this.pending.set(cacheKey, request);
		return request;
	}
}

export const waveformGenerator = new WaveformGenerator();
