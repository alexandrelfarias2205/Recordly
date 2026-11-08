import {
	getFileExtension,
	streamExportBlobToTempFile,
} from "@/components/video-editor/export/exportPersistence";
import { isExportStreamApiAvailable } from "@/lib/exporter/exportStreamIpc";
import { isExportTooLargeForInMemorySave } from "@/lib/exporter/exportSavePolicy";

export type StoreRecordedVideoResult = {
	success: boolean;
	path?: string;
	message?: string;
};

function hasTempStreamApi(): boolean {
	return (
		isExportStreamApiAvailable() &&
		typeof window.electronAPI.storeRecordedVideoFromTemp === "function"
	);
}

/**
 * Stores a finished recording without materializing it as one ArrayBuffer.
 * Large blobs are streamed to an app-owned temp file in slices and moved by the main process.
 */
export async function storeRecordedBlob(
	blob: Blob,
	fileName: string,
): Promise<StoreRecordedVideoResult> {
	let streamError: unknown = null;

	if (hasTempStreamApi()) {
		try {
			const tempPath = await streamExportBlobToTempFile(blob, getFileExtension(fileName));
			if (tempPath) {
				return await window.electronAPI.storeRecordedVideoFromTemp(tempPath, fileName);
			}
		} catch (error) {
			streamError = error;
			console.warn("[recording] Temp-file blob save failed", error);
		}
	}

	if (isExportTooLargeForInMemorySave(blob.size)) {
		const reason = streamError instanceof Error ? ` (${streamError.message})` : "";
		return {
			success: false,
			message: `The recording is too large to save through the in-memory path${reason}.`,
		};
	}

	const arrayBuffer = await blob.arrayBuffer();
	return window.electronAPI.storeRecordedVideo(arrayBuffer, fileName);
}
