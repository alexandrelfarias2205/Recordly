import { afterEach, describe, expect, it, vi } from "vitest";
import { storeRecordedBlob } from "./recordingBlobStorage";

const CHUNK = 16 * 1024 * 1024;

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function createApi(overrides: Record<string, unknown> = {}) {
	return {
		openExportStream: vi.fn(async () => ({
			success: true,
			streamId: "s1",
			tempPath: "/tmp/rec.webm",
		})),
		writeExportStreamChunk: vi.fn(async () => ({ success: true })),
		closeExportStream: vi.fn(async () => ({
			success: true,
			tempPath: "/tmp/rec.webm",
			bytesWritten: 0,
		})),
		storeRecordedVideoFromTemp: vi.fn(async () => ({ success: true, path: "/rec/a.webm" })),
		storeRecordedVideo: vi.fn(async () => ({ success: true, path: "/rec/b.webm" })),
		...overrides,
	};
}

describe("storeRecordedBlob", () => {
	it("streams slices in order and moves the temp file", async () => {
		const api = createApi();
		vi.stubGlobal("window", { electronAPI: api });
		const blob = new Blob([new Uint8Array(CHUNK * 2 + 10)]);

		const result = await storeRecordedBlob(blob, "recording-1.webm");

		expect(result).toEqual({ success: true, path: "/rec/a.webm" });
		const positions = api.writeExportStreamChunk.mock.calls.map((call) => call[1]);
		expect(positions).toEqual([0, CHUNK, CHUNK * 2]);
		expect(api.openExportStream).toHaveBeenCalledWith({ extension: "webm" });
		expect(api.storeRecordedVideoFromTemp).toHaveBeenCalledWith(
			"/tmp/rec.webm",
			"recording-1.webm",
		);
		expect(api.storeRecordedVideo).not.toHaveBeenCalled();
	});

	it("falls back to the in-memory path for small blobs when streaming fails", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const api = createApi({
			writeExportStreamChunk: vi.fn(async () => ({ success: false, error: "disk full" })),
		});
		vi.stubGlobal("window", { electronAPI: api });

		const result = await storeRecordedBlob(new Blob([new Uint8Array(32)]), "rec.webm");

		expect(result).toEqual({ success: true, path: "/rec/b.webm" });
		expect(api.closeExportStream).toHaveBeenCalledWith("s1", { abort: true });
		expect(api.storeRecordedVideo).toHaveBeenCalledTimes(1);
	});

	it("uses the legacy path when the stream API is missing", async () => {
		const api = createApi();
		vi.stubGlobal("window", {
			electronAPI: { storeRecordedVideo: api.storeRecordedVideo },
		});

		const result = await storeRecordedBlob(new Blob([new Uint8Array(8)]), "rec.mp4");

		expect(result.success).toBe(true);
		expect(api.storeRecordedVideo).toHaveBeenCalledTimes(1);
	});

	it("refuses huge blobs without stream support and never reads them into memory", async () => {
		const api = createApi();
		vi.stubGlobal("window", { electronAPI: { storeRecordedVideo: api.storeRecordedVideo } });
		const blob = new Blob([]);
		Object.defineProperty(blob, "size", { value: 0x80000000 });
		const arrayBuffer = vi.spyOn(blob, "arrayBuffer");

		const result = await storeRecordedBlob(blob, "rec.webm");

		expect(result.success).toBe(false);
		expect(result.message).toMatch(/too large/i);
		expect(arrayBuffer).not.toHaveBeenCalled();
		expect(api.storeRecordedVideo).not.toHaveBeenCalled();
	});
});
