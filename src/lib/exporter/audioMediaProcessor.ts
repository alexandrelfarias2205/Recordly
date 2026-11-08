import { fetchArrayBufferBounded } from "@/lib/audio/boundedFetch";
import { AudioDecodeCancelledError, streamDecodeAudio } from "@/lib/audio/streamAudioDecode";
import { AudioTimelineProcessor } from "./audioTimelineProcessor";
import { DECODE_BACKPRESSURE_LIMIT, OFFLINE_AUDIO_SAMPLE_RATE } from "./audioProcessorShared";
import { resolveMediaElementSource } from "./localMediaSource";
import { ChunkedPcmBuffer, type PcmSource, resolvePcmStorageFormat } from "./pcmSource";

export class AudioMediaProcessor extends AudioTimelineProcessor {
	// Resolves null only when the media has no audio track. Decode failures throw, so a
	// missing mic/system track can never turn into a "successful" export without it.
	protected async decodeAudioFromUrl(url: string): Promise<PcmSource | null> {
		try {
			// null means "no audio track": do not load the whole file via the bulk path.
			return await this.streamDecodeFromUrl(url);
		} catch (error) {
			if (error instanceof AudioDecodeCancelledError) throw error;
			console.warn(
				"[AudioProcessor] Streaming decode failed, falling back to bulk decode:",
				url,
				error,
			);
		}
		return this.bulkDecodeFromUrl(url, OFFLINE_AUDIO_SAMPLE_RATE);
	}

	// Streaming decode via the shared WebDemuxer + AudioDecoder helper. Decoded chunks are
	// kept as-is (no monolithic AudioBuffer) and long sources use compact 16-bit storage.
	protected async streamDecodeFromUrl(url: string): Promise<PcmSource | null> {
		const source = await resolveMediaElementSource(url);

		try {
			let pcm = null as ChunkedPcmBuffer | null;
			const result = await streamDecodeAudio(
				source.src,
				(chunk) => {
					pcm?.append(chunk.channels);
				},
				{
					maxChannels: 2,
					backpressureLimit: DECODE_BACKPRESSURE_LIMIT,
					isCancelled: () => this.cancelled,
					onConfig: (config) => {
						pcm = new ChunkedPcmBuffer({
							sampleRate: config.sampleRate,
							numberOfChannels: config.numberOfChannels,
							storage: resolvePcmStorageFormat(
								config.durationSec,
								config.sampleRate,
								config.numberOfChannels,
							),
						});
					},
				},
			);

			if (!result || !pcm || pcm.length === 0) return null;
			return pcm;
		} finally {
			source.revoke();
		}
	}

	// Bulk decode fallback: loads the (size-bounded) file into memory and uses decodeAudioData.
	// Throws on failure or when the file exceeds the in-memory limit.
	protected async bulkDecodeFromUrl(url: string, sampleRate: number): Promise<AudioBuffer> {
		try {
			const source = await resolveMediaElementSource(url);
			try {
				const arrayBuffer = await fetchArrayBufferBounded(source.src);
				const tempCtx = new OfflineAudioContext(2, 1, sampleRate);
				return await tempCtx.decodeAudioData(arrayBuffer);
			} finally {
				source.revoke();
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to decode audio from ${url}: ${reason}`);
		}
	}

	// Get the duration of a media file by loading only its metadata.
	protected async getMediaDurationSec(url: string): Promise<number> {
		const source = await resolveMediaElementSource(url);
		try {
			const media = document.createElement("video");
			media.preload = "metadata";
			media.src = source.src;

			return await new Promise<number>((resolve, reject) => {
				const timeout = setTimeout(() => {
					cleanup();
					media.src = "";
					media.load();
					reject(new Error("Timed out getting media duration (30s)"));
				}, 30_000);

				const onLoaded = () => {
					cleanup();
					const duration = media.duration;
					media.src = "";
					media.load();
					resolve(Number.isFinite(duration) ? duration : 0);
				};
				const onError = () => {
					cleanup();
					media.src = "";
					media.load();
					reject(new Error("Failed to get media duration"));
				};
				const cleanup = () => {
					clearTimeout(timeout);
					media.removeEventListener("loadedmetadata", onLoaded);
					media.removeEventListener("error", onError);
				};

				media.addEventListener("loadedmetadata", onLoaded);
				media.addEventListener("error", onError, { once: true });
			});
		} finally {
			source.revoke();
		}
	}

	// Build non-overlapping timeline slices from the source timeline, excluding
	// trimmed regions and tagging each slice with its playback speed.
}
