import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaTooLargeForInMemoryDecodeError } from "@/lib/audio/boundedFetch";
import { AudioDecodeCancelledError } from "@/lib/audio/streamAudioDecode";
import { AudioProcessor } from "./audioEncoder";

const fetchBounded = vi.hoisted(() => vi.fn());

vi.mock("@/lib/audio/boundedFetch", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/audio/boundedFetch")>()),
	fetchArrayBufferBounded: fetchBounded,
}));
vi.mock("./localMediaSource", () => ({
	resolveMediaElementSource: vi.fn(async (url: string) => ({ src: url, revoke: () => {} })),
}));

type DecodeHarness = {
	decodeAudioFromUrl(url: string): Promise<unknown>;
	streamDecodeFromUrl(url: string): Promise<unknown>;
	bulkDecodeFromUrl(url: string, sampleRate: number): Promise<unknown>;
};

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	fetchBounded.mockReset();
});

describe("AudioMediaProcessor.decodeAudioFromUrl", () => {
	it("returns null for a media without audio without loading it in memory", async () => {
		const processor = new AudioProcessor() as unknown as DecodeHarness;
		vi.spyOn(processor, "streamDecodeFromUrl").mockResolvedValue(null);
		const bulk = vi.spyOn(processor, "bulkDecodeFromUrl");

		await expect(processor.decodeAudioFromUrl("file:///video.mp4")).resolves.toBeNull();
		expect(bulk).not.toHaveBeenCalled();
	});

	it("rethrows cancellation instead of falling back to bulk decode", async () => {
		const processor = new AudioProcessor() as unknown as DecodeHarness;
		vi.spyOn(processor, "streamDecodeFromUrl").mockRejectedValue(
			new AudioDecodeCancelledError(),
		);
		const bulk = vi.spyOn(processor, "bulkDecodeFromUrl");

		await expect(processor.decodeAudioFromUrl("file:///video.mp4")).rejects.toBeInstanceOf(
			AudioDecodeCancelledError,
		);
		expect(bulk).not.toHaveBeenCalled();
	});

	it("falls back to bulk decode when streaming fails", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const processor = new AudioProcessor() as unknown as DecodeHarness;
		vi.spyOn(processor, "streamDecodeFromUrl").mockRejectedValue(new Error("decoder error"));
		const decoded = { duration: 1 };
		const bulk = vi.spyOn(processor, "bulkDecodeFromUrl").mockResolvedValue(decoded);

		await expect(processor.decodeAudioFromUrl("file:///mic.m4a")).resolves.toBe(decoded);
		expect(bulk).toHaveBeenCalledWith("file:///mic.m4a", 48_000);
	});

	it("throws with the url when the bulk fallback exceeds the in-memory limit", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const processor = new AudioProcessor() as unknown as DecodeHarness;
		vi.spyOn(processor, "streamDecodeFromUrl").mockRejectedValue(new Error("decoder error"));
		fetchBounded.mockRejectedValue(
			new MediaTooLargeForInMemoryDecodeError("file:///big.m4a", 999, 100),
		);
		vi.stubGlobal("OfflineAudioContext", class {});

		await expect(processor.decodeAudioFromUrl("file:///big.m4a")).rejects.toThrow(
			/file:\/\/\/big\.m4a/,
		);
	});

	it("throws with the url when the bulk decode itself fails", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const processor = new AudioProcessor() as unknown as DecodeHarness;
		vi.spyOn(processor, "streamDecodeFromUrl").mockRejectedValue(new Error("decoder error"));
		fetchBounded.mockResolvedValue(new ArrayBuffer(8));
		vi.stubGlobal(
			"OfflineAudioContext",
			class {
				decodeAudioData() {
					return Promise.reject(new Error("bad data"));
				}
			},
		);

		await expect(processor.decodeAudioFromUrl("file:///mic.m4a")).rejects.toThrow(
			/mic\.m4a.*bad data/,
		);
	});
});
