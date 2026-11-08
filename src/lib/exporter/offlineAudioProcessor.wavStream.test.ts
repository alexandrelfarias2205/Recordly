import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioProcessor } from "./audioEncoder";
import type { EditedAudioSink } from "./editedAudioSink";

type WavStreamHarness = {
	renderChunked(...args: unknown[]): Promise<void>;
	renderToWavStreamChunked(
		prepared: unknown,
		sink: EditedAudioSink,
	): Promise<{ tempPath: string; bytesWritten: number; mimeType: string }>;
	cancel(): void;
};

function fakeRendered(length: number): AudioBuffer {
	return {
		length,
		numberOfChannels: 1,
		getChannelData: () => new Float32Array(length),
	} as unknown as AudioBuffer;
}

function createSink(bytesWritten = 123) {
	const writes: Array<{ position: number; bytes: Uint8Array }> = [];
	const sink: EditedAudioSink = {
		open: vi.fn(async () => {}),
		write: vi.fn(async (position: number, bytes: Uint8Array) => {
			writes.push({ position, bytes });
		}),
		close: vi.fn(async () => ({ tempPath: "/tmp/edited.wav", bytesWritten })),
		abort: vi.fn(async () => {}),
	};
	return { sink, writes };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const prepared = { outputDurationMs: 1000, numChannels: 1, slices: [] };

function dataSizeOf(header: Uint8Array) {
	return new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(40, true);
}

describe("OfflineAudioProcessor.renderToWavStreamChunked", () => {
	it("writes the header first and one positioned write per rendered chunk", async () => {
		const processor = new AudioProcessor() as unknown as WavStreamHarness;
		vi.spyOn(processor, "renderChunked").mockImplementation(async (...args: unknown[]) => {
			const onChunk = args[2] as (rendered: AudioBuffer) => Promise<void>;
			await onChunk(fakeRendered(24_000));
			await onChunk(fakeRendered(24_000));
		});
		const { sink, writes } = createSink(44 + 48_000 * 2);

		const result = await processor.renderToWavStreamChunked(prepared, sink);

		expect(result).toEqual({
			tempPath: "/tmp/edited.wav",
			bytesWritten: 44 + 48_000 * 2,
			mimeType: "audio/wav",
		});
		expect(writes).toHaveLength(3);
		expect(writes[0].position).toBe(0);
		expect(writes[0].bytes.byteLength).toBe(44);
		expect(dataSizeOf(writes[0].bytes)).toBe(48_000 * 2);
		expect(writes[1].position).toBe(44);
		expect(writes[1].bytes.byteLength).toBe(24_000 * 2);
		expect(writes[2].position).toBe(44 + 24_000 * 2);
		expect(sink.close).toHaveBeenCalledTimes(1);
		expect(sink.abort).not.toHaveBeenCalled();
	});

	it("rewrites the header at position 0 when the rendered frames differ", async () => {
		const processor = new AudioProcessor() as unknown as WavStreamHarness;
		vi.spyOn(processor, "renderChunked").mockImplementation(async (...args: unknown[]) => {
			const onChunk = args[2] as (rendered: AudioBuffer) => Promise<void>;
			await onChunk(fakeRendered(47_990));
		});
		const { sink, writes } = createSink(44 + 47_990 * 2);

		await processor.renderToWavStreamChunked(prepared, sink);

		expect(writes).toHaveLength(3);
		const rewrite = writes[2];
		expect(rewrite.position).toBe(0);
		expect(dataSizeOf(rewrite.bytes)).toBe(47_990 * 2);
		expect(sink.close).toHaveBeenCalledTimes(1);
	});

	it("aborts the stream and reports cancellation", async () => {
		const processor = new AudioProcessor() as unknown as WavStreamHarness;
		vi.spyOn(processor, "renderChunked").mockImplementation(async () => processor.cancel());
		const { sink } = createSink();

		await expect(processor.renderToWavStreamChunked(prepared, sink)).rejects.toThrow(
			"Export cancelled",
		);
		expect(sink.abort).toHaveBeenCalledTimes(1);
		expect(sink.close).not.toHaveBeenCalled();
	});

	it("aborts the stream and rethrows render failures", async () => {
		const processor = new AudioProcessor() as unknown as WavStreamHarness;
		vi.spyOn(processor, "renderChunked").mockRejectedValue(new Error("render failed"));
		const { sink } = createSink();

		await expect(processor.renderToWavStreamChunked(prepared, sink)).rejects.toThrow(
			"render failed",
		);
		expect(sink.abort).toHaveBeenCalledTimes(1);
	});

	it("discards the temp and fails when the file size does not match the frames written", async () => {
		const discard = vi.fn(async () => ({ success: true }));
		vi.stubGlobal("window", { electronAPI: { discardExportedTemp: discard } });
		const processor = new AudioProcessor() as unknown as WavStreamHarness;
		vi.spyOn(processor, "renderChunked").mockImplementation(async (...args: unknown[]) => {
			const onChunk = args[2] as (rendered: AudioBuffer) => Promise<void>;
			await onChunk(fakeRendered(48_000));
		});
		const { sink } = createSink(1000);

		await expect(processor.renderToWavStreamChunked(prepared, sink)).rejects.toThrow(
			/incomplete/,
		);
		expect(discard).toHaveBeenCalledWith("/tmp/edited.wav");
	});

	it("discards the closed temp when cancelled right after closing", async () => {
		const discard = vi.fn(async () => ({ success: true }));
		vi.stubGlobal("window", { electronAPI: { discardExportedTemp: discard } });
		const processor = new AudioProcessor() as unknown as WavStreamHarness;
		vi.spyOn(processor, "renderChunked").mockImplementation(async (...args: unknown[]) => {
			const onChunk = args[2] as (rendered: AudioBuffer) => Promise<void>;
			await onChunk(fakeRendered(48_000));
		});
		const { sink } = createSink(44 + 48_000 * 2);
		vi.mocked(sink.close).mockImplementation(async () => {
			processor.cancel();
			return { tempPath: "/tmp/edited.wav", bytesWritten: 44 + 48_000 * 2 };
		});

		await expect(processor.renderToWavStreamChunked(prepared, sink)).rejects.toThrow(
			"Export cancelled",
		);
		expect(discard).toHaveBeenCalledWith("/tmp/edited.wav");
	});
});

describe("AudioProcessor.renderEditedAudioTrackToTempFile fallback", () => {
	const stubStreamApi = () =>
		vi.stubGlobal("window", {
			electronAPI: {
				openExportStream: vi.fn(),
				writeExportStreamChunk: vi.fn(),
				closeExportStream: vi.fn(),
			},
		});

	type TempFileHarness = {
		prepareOfflineRender: () => Promise<unknown>;
		renderToWavStreamChunked: () => Promise<unknown>;
		renderEditedAudioTrackToTempFile(url: string): Promise<unknown>;
		cancel(): void;
	};

	it("returns null for short outputs so the caller uses the Blob path", async () => {
		stubStreamApi();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const processor = new AudioProcessor() as unknown as TempFileHarness;
		vi.spyOn(processor, "prepareOfflineRender").mockResolvedValue({
			outputDurationMs: 60_000,
		});
		vi.spyOn(processor, "renderToWavStreamChunked").mockRejectedValue(new Error("ipc down"));

		await expect(processor.renderEditedAudioTrackToTempFile("a.mp4")).resolves.toBeNull();
	});

	it("rethrows for long outputs", async () => {
		stubStreamApi();
		const processor = new AudioProcessor() as unknown as TempFileHarness;
		vi.spyOn(processor, "prepareOfflineRender").mockResolvedValue({
			outputDurationMs: 11 * 60 * 1000,
		});
		vi.spyOn(processor, "renderToWavStreamChunked").mockRejectedValue(new Error("ipc down"));

		await expect(processor.renderEditedAudioTrackToTempFile("a.mp4")).rejects.toThrow(
			"ipc down",
		);
	});

	it("rethrows cancellation even for short outputs", async () => {
		stubStreamApi();
		const processor = new AudioProcessor() as unknown as TempFileHarness;
		vi.spyOn(processor, "prepareOfflineRender").mockResolvedValue({
			outputDurationMs: 1000,
		});
		vi.spyOn(processor, "renderToWavStreamChunked").mockRejectedValue(
			new Error("Export cancelled"),
		);

		await expect(processor.renderEditedAudioTrackToTempFile("a.mp4")).rejects.toThrow(
			"Export cancelled",
		);
	});
});
