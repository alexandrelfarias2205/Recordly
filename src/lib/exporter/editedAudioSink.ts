import type { AudioProcessor } from "./audioEncoder";
import type { ExportStreamWriter } from "./exportStreamIpc";

/**
 * Sequential/positioned writer for the edited-audio WAV, backed by the main
 * process export-stream IPC (see `ExportStreamWriter`).
 */
export type EditedAudioSink = Pick<ExportStreamWriter, "open" | "write" | "close" | "abort">;

/** Best-effort removal of an owned export temp; failures are logged, never thrown. */
export async function discardEditedAudioTemp(tempPath: string): Promise<void> {
	try {
		const result = await window.electronAPI?.discardExportedTemp?.(tempPath);
		if (result && result.success === false) {
			console.warn(
				"[AudioProcessor] Failed to discard edited audio temp:",
				tempPath,
				result.error,
			);
		}
	} catch (error) {
		console.warn("[AudioProcessor] Failed to discard edited audio temp:", tempPath, error);
	}
}

/**
 * Tracks the main-process temp holding the rendered edited audio between the render and
 * the mux, so every exit path (success, failure, cancel) either hands it off or discards it.
 */
export class PendingEditedAudioTemp {
	private tempPath: string | null = null;

	get path(): string | null {
		return this.tempPath;
	}

	set(tempPath: string): void {
		this.tempPath = tempPath;
	}

	/** The main process removes the temp after the mux, so just forget it. */
	release(): void {
		this.tempPath = null;
	}

	/**
	 * Release after a successful mux; otherwise the main process may have failed before
	 * removing the temp, so discard it here.
	 */
	settle(success: boolean): void {
		if (success) {
			this.release();
		} else {
			this.discard();
		}
	}

	discard(): void {
		const tempPath = this.tempPath;
		this.tempPath = null;
		if (!tempPath || typeof window === "undefined") {
			return;
		}
		void discardEditedAudioTemp(tempPath);
	}
}

export type RenderedEditedAudio = {
	editedAudioData?: ArrayBuffer;
	editedAudioPath?: string;
	editedAudioMimeType: string | null;
};

/**
 * Renders the edited audio for the native mux, preferring a temp file (no large buffer
 * crossing IPC) and falling back to an in-memory Blob when the stream IPC is unavailable.
 * `runStage` wraps each render with the exporter's timing/timeout handling.
 */
export async function renderEditedAudioForMux({
	processor,
	renderArgs,
	pendingTemp,
	runStage,
	throwIfCancelled,
}: {
	processor: AudioProcessor;
	renderArgs: Readonly<Parameters<AudioProcessor["renderEditedAudioTrackToTempFile"]>>;
	pendingTemp: PendingEditedAudioTemp;
	runStage: <T>(task: () => Promise<T>) => Promise<T>;
	throwIfCancelled?: () => void;
}): Promise<RenderedEditedAudio> {
	const tempFile = await runStage(() =>
		processor.renderEditedAudioTrackToTempFile(...renderArgs),
	);
	if (tempFile) {
		pendingTemp.set(tempFile.tempPath);
		throwIfCancelled?.();
		return {
			editedAudioPath: tempFile.tempPath,
			editedAudioMimeType: tempFile.mimeType || null,
		};
	}

	const audioBlob = await runStage(() => processor.renderEditedAudioTrack(...renderArgs));
	throwIfCancelled?.();
	const editedAudioData = await audioBlob.arrayBuffer();
	throwIfCancelled?.();
	return {
		editedAudioData,
		editedAudioMimeType: audioBlob.type || null,
	};
}
