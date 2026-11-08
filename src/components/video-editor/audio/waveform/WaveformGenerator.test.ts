import { beforeEach, describe, expect, it, vi } from "vitest";

const streamDecodeAudio = vi.fn();
vi.mock("@/lib/audio/streamAudioDecode", () => ({
	streamDecodeAudio: (...args: unknown[]) => streamDecodeAudio(...args),
}));

const fetchArrayBufferBounded = vi.fn();
vi.mock("@/lib/audio/boundedFetch", () => ({
	fetchArrayBufferBounded: (...args: unknown[]) => fetchArrayBufferBounded(...args),
}));

// Fake worker mirroring waveform.worker.ts (max-pool of channel 0..n into `samples` buckets).
vi.mock("./waveform.worker?worker", () => ({
	default: class FakeWorker {
		private listeners: Array<(e: { data: unknown }) => void> = [];
		addEventListener(type: string, cb: (e: { data: unknown }) => void) {
			if (type === "message") this.listeners.push(cb);
		}
		postMessage(msg: { requestId: number; channels: Float32Array[]; samples: number }) {
			const { requestId, channels, samples } = msg;
			const total = channels[0].length;
			const size = total / samples;
			const peaks = new Float32Array(samples);
			for (let i = 0; i < samples; i++) {
				const start = Math.floor(i * size);
				const end = Math.max(start + 1, Math.floor((i + 1) * size));
				let max = 0;
				for (let j = start; j < end && j < total; j++) {
					for (const ch of channels) max = Math.max(max, Math.abs(ch[j]));
				}
				peaks[i] = max;
			}
			queueMicrotask(() => {
				for (const l of this.listeners) l({ data: { requestId, peaks } });
			});
		}
	},
}));

import { NoAudioTrackError, PeakBlockAccumulator, WaveformGenerator } from "./WaveformGenerator";

describe("PeakBlockAccumulator", () => {
	it("takes the max abs over all channels per block and flushes the partial block", () => {
		const acc = new PeakBlockAccumulator(4, 2);
		const left = new Float32Array([0.1, -0.2, 0.3, 0.1, 0.05, 0.0]);
		const right = new Float32Array([0, 0, -0.9, 0, 0.5, 0.2]);
		acc.add([left, right], 6);
		expect(Array.from(acc.finish())).toEqual([Math.fround(0.9), Math.fround(0.5)]);
	});
});

describe("WaveformGenerator", () => {
	beforeEach(() => {
		streamDecodeAudio.mockReset();
		fetchArrayBufferBounded.mockReset();
		vi.restoreAllMocks();
	});

	it("computes normalized peaks and duration from streamed chunks", async () => {
		streamDecodeAudio.mockImplementation(async (_url, onChunk, options) => {
			options.onConfig?.({
				sampleRate: 1000,
				numberOfChannels: 2,
				durationSec: 2,
				codec: "x",
			});
			const frames = 1000;
			const quiet = new Float32Array(frames).fill(0.1);
			const loud = new Float32Array(frames).fill(0.1);
			loud[10] = 0.5;
			onChunk({ channels: [quiet, quiet], frames, timestampUs: 0 });
			onChunk({ channels: [loud, quiet], frames, timestampUs: 1_000_000 });
			return { sampleRate: 1000, numberOfChannels: 2, totalFrames: 2000 };
		});
		const gen = new WaveformGenerator();
		const result = await gen.generate("http://127.0.0.1/video?path=a", 10, 0);
		expect(result.durationMs).toBe(2000);
		expect(result.peaks.length).toBe(1000);
		expect(Math.max(...result.peaks)).toBeLessThanOrEqual(1);
		expect(Math.max(...result.peaks)).toBeGreaterThan(0);
	});

	function stubAudioContext() {
		const decodeAudioData = vi.fn().mockResolvedValue({
			duration: 1,
			numberOfChannels: 1,
			getChannelData: () => new Float32Array(1000).fill(0.25),
		});
		vi.stubGlobal(
			"AudioContext",
			class {
				decodeAudioData = decodeAudioData;
			},
		);
		vi.stubGlobal("window", globalThis);
		return decodeAudioData;
	}

	it("rejects with NoAudioTrackError without fetching when there is no audio track", async () => {
		streamDecodeAudio.mockResolvedValue(null);
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const decodeAudioData = stubAudioContext();

		const gen = new WaveformGenerator();
		await expect(gen.generate("blob:silent", 10, 0)).rejects.toBeInstanceOf(NoAudioTrackError);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(fetchArrayBufferBounded).not.toHaveBeenCalled();
		expect(decodeAudioData).not.toHaveBeenCalled();
	});

	it("keeps resolution at low sample rates and places a spike at the expected index", async () => {
		const sampleRate = 16_000;
		const frames = sampleRate * 4; // 4 s
		streamDecodeAudio.mockImplementation(async (_url, onChunk, options) => {
			options.onConfig?.({ sampleRate, numberOfChannels: 1, durationSec: 4, codec: "x" });
			const silence = new Float32Array(frames);
			silence[frames / 2] = 1; // spike at t = 2 s
			onChunk({ channels: [silence], frames, timestampUs: 0 });
			return { sampleRate, numberOfChannels: 1, totalFrames: frames };
		});
		const gen = new WaveformGenerator();
		const { peaks, durationMs } = await gen.generate("blob:low", 10, 0);
		expect(durationMs).toBe(4000);
		// 4 s * 500 peaks/s
		expect(peaks.length).toBe(2000);
		const maxIndex = peaks.indexOf(Math.max(...peaks));
		expect(peaks[maxIndex]).toBe(1);
		expect(Math.abs(maxIndex - 1000)).toBeLessThanOrEqual(1);
		// Silence elsewhere: far from the spike must stay at zero (no smearing).
		expect(peaks[500]).toBe(0);
		expect(peaks[1500]).toBe(0);
	});

	it("falls back to bounded full decode and warns on every stream failure", async () => {
		streamDecodeAudio.mockRejectedValue(new Error("unsupported"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const decodeAudioData = stubAudioContext();
		fetchArrayBufferBounded.mockResolvedValue(new ArrayBuffer(8));

		const gen = new WaveformGenerator();
		const a = await gen.generate("blob:a", 10, 0);
		await gen.generate("blob:b", 10, 0);
		expect(a.durationMs).toBe(1000);
		expect(decodeAudioData).toHaveBeenCalledTimes(2);
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it("propagates too-large errors without decoding", async () => {
		streamDecodeAudio.mockRejectedValue(new Error("unsupported"));
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const decodeAudioData = stubAudioContext();
		fetchArrayBufferBounded.mockRejectedValue(new Error("too large"));

		const gen = new WaveformGenerator();
		await expect(gen.generate("blob:big", 10, 0)).rejects.toThrow("too large");
		expect(decodeAudioData).not.toHaveBeenCalled();
	});
});
