import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioProcessor } from "./audioEncoder";
import type { PendingEditedAudioTemp } from "./editedAudioSink";
import { ModernVideoExporter } from "./modernVideoExporter";
import type { MuxerFinalizeResult } from "./muxer";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("modern export audio cancellation", () => {
	it.each([
		"audio-render",
		"audio-buffer",
		"video-buffer",
	])("does not start FFmpeg after cancellation during %s", async (stage) => {
		const mux = vi.fn();
		vi.stubGlobal("window", { electronAPI: { muxExportedVideoAudio: mux } });
		const exporter = new ModernVideoExporter({
			videoUrl: "file:///source.mp4",
			width: 320,
			height: 180,
			frameRate: 30,
			bitrate: 1_000_000,
			wallpaper: "#000000",
			zoomRegions: [],
			showShadow: false,
			shadowIntensity: 0,
			backgroundBlur: 0,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		});
		const audio = new Blob([], { type: "audio/wav" });
		vi.spyOn(AudioProcessor.prototype, "renderEditedAudioTrack").mockImplementation(
			async () => {
				if (stage === "audio-render") exporter.cancel();
				return audio;
			},
		);
		vi.spyOn(audio, "arrayBuffer").mockImplementation(async () => {
			if (stage === "audio-buffer") exporter.cancel();
			return new ArrayBuffer(0);
		});
		const video = new Blob([], { type: "video/mp4" });
		vi.spyOn(video, "arrayBuffer").mockImplementation(async () => {
			if (stage === "video-buffer") exporter.cancel();
			return new ArrayBuffer(0);
		});
		const access = exporter as unknown as {
			finalizeExportWithFfmpegAudio(
				video: MuxerFinalizeResult,
				plan: unknown,
			): Promise<unknown>;
		};
		await expect(
			access.finalizeExportWithFfmpegAudio(
				{ mode: "buffer", blob: video },
				{ audioMode: "edited-track", strategy: "offline-render-fallback" },
			),
		).rejects.toThrow("Export cancelled");
		expect(mux).not.toHaveBeenCalled();
	});

	it("sends the edited audio temp path instead of buffering the WAV over IPC", async () => {
		const mux = vi.fn(async () => ({ success: true, tempPath: "/tmp/out.mp4" }));
		const discard = vi.fn(async () => ({ success: true }));
		vi.stubGlobal("window", {
			electronAPI: {
				openExportStream: vi.fn(async () => ({
					success: true,
					streamId: "stream-1",
					tempPath: "/tmp/edited.wav",
				})),
				writeExportStreamChunk: vi.fn(async () => ({ success: true })),
				closeExportStream: vi.fn(async () => ({
					success: true,
					tempPath: "/tmp/edited.wav",
					bytesWritten: 44 + 48_000 * 2,
				})),
				discardExportedTemp: discard,
				muxExportedVideoAudioFromPath: mux,
			},
		});
		const processorProto = AudioProcessor.prototype as unknown as {
			prepareOfflineRender: () => Promise<unknown>;
			renderChunked: (...args: unknown[]) => Promise<void>;
		};
		vi.spyOn(processorProto, "prepareOfflineRender").mockResolvedValue({
			outputDurationMs: 1000,
			numChannels: 1,
			slices: [],
		});
		vi.spyOn(processorProto, "renderChunked").mockImplementation(async (...args) => {
			const onChunk = args[2] as (rendered: AudioBuffer) => Promise<void>;
			await onChunk({
				length: 48_000,
				numberOfChannels: 1,
				getChannelData: () => new Float32Array(48_000),
			} as unknown as AudioBuffer);
		});
		const exporter = new ModernVideoExporter({
			videoUrl: "file:///source.mp4",
			width: 320,
			height: 180,
			frameRate: 30,
			bitrate: 1_000_000,
			wallpaper: "#000000",
			zoomRegions: [],
			showShadow: false,
			shadowIntensity: 0,
			backgroundBlur: 0,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		});
		const access = exporter as unknown as {
			finalizeExportWithFfmpegAudio(
				video: MuxerFinalizeResult,
				plan: unknown,
			): Promise<unknown>;
		};

		await access.finalizeExportWithFfmpegAudio(
			{ mode: "stream", tempFilePath: "/tmp/video.mp4", bytesWritten: 1 },
			{ audioMode: "edited-track", strategy: "offline-render-fallback" },
		);

		expect(mux).toHaveBeenCalledTimes(1);
		const [videoPath, options] = mux.mock.calls[0] as unknown as [
			string,
			Record<string, unknown>,
		];
		expect(videoPath).toBe("/tmp/video.mp4");
		expect(options.editedAudioPath).toBe("/tmp/edited.wav");
		expect(options.editedAudioMimeType).toBe("audio/wav");
		expect(options.editedAudioData).toBeUndefined();
		// The main process removes the temp after muxing, so the renderer must not.
		expect(discard).not.toHaveBeenCalled();
	});

	it("discards the pending edited audio temp when the export is cleaned up before muxing", async () => {
		const discard = vi.fn(async () => ({ success: true }));
		vi.stubGlobal("window", { electronAPI: { discardExportedTemp: discard } });
		const exporter = new ModernVideoExporter({
			videoUrl: "file:///source.mp4",
			width: 320,
			height: 180,
			frameRate: 30,
			bitrate: 1_000_000,
			wallpaper: "#000000",
			zoomRegions: [],
			showShadow: false,
			shadowIntensity: 0,
			backgroundBlur: 0,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		});
		const access = exporter as unknown as {
			pendingEditedAudioTemp: PendingEditedAudioTemp;
			cleanup(): void;
		};
		access.pendingEditedAudioTemp.set("/tmp/edited.wav");

		access.cleanup();

		expect(discard).toHaveBeenCalledWith("/tmp/edited.wav");
		expect(access.pendingEditedAudioTemp.path).toBeNull();
	});

	it("discards the edited audio temp when the mux reports failure", async () => {
		const mux = vi.fn(async () => ({ success: false, error: "ffmpeg failed" }));
		const discard = vi.fn(async () => ({ success: true }));
		vi.stubGlobal("window", {
			electronAPI: { discardExportedTemp: discard, muxExportedVideoAudioFromPath: mux },
		});
		const exporter = new ModernVideoExporter({
			videoUrl: "file:///source.mp4",
			width: 320,
			height: 180,
			frameRate: 30,
			bitrate: 1_000_000,
			wallpaper: "#000000",
			zoomRegions: [],
			showShadow: false,
			shadowIntensity: 0,
			backgroundBlur: 0,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		});
		const access = exporter as unknown as {
			pendingEditedAudioTemp: PendingEditedAudioTemp;
			finalizeExportWithFfmpegAudio(
				video: MuxerFinalizeResult,
				plan: unknown,
			): Promise<unknown>;
			renderEditedAudioForNativeMux: () => Promise<unknown>;
		};
		vi.spyOn(access, "renderEditedAudioForNativeMux").mockImplementation(async () => {
			access.pendingEditedAudioTemp.set("/tmp/edited.wav");
			return { editedAudioPath: "/tmp/edited.wav", editedAudioMimeType: "audio/wav" };
		});

		const result = await access.finalizeExportWithFfmpegAudio(
			{ mode: "stream", tempFilePath: "/tmp/video.mp4", bytesWritten: 1 },
			{ audioMode: "edited-track", strategy: "offline-render-fallback" },
		);

		expect(result).toMatchObject({ success: false });
		expect(discard).toHaveBeenCalledWith("/tmp/edited.wav");
	});
});
