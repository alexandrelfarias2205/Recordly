import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

type ExportStreamSession = {
	streamId: string;
	sessionDir: string;
	tempPath: string;
	fileHandle: fs.promises.FileHandle;
	bytesWritten: number;
	highestWatermark: number;
	writeQueue: Promise<void>;
	aborted: boolean;
	// First write failure, surfaced again on a non-abort close.
	writeError: unknown;
	hasWriteError: boolean;
};

const exportStreamSessions = new Map<string, ExportStreamSession>();

const EXTENSION_ALLOWLIST = /^[a-z0-9]{1,8}$/;
const SESSION_DIR_PREFIX = "recordly-export-";

// Paths that the export pipeline itself produced (stream temp files plus any
// successor temp files returned by main-process helpers such as
// muxNativeVideoExportAudio). Every renderer-facing handler that moves or
// deletes a path must assert membership here before touching disk, so a
// compromised renderer can never route arbitrary file paths into the IPC.
const ownedExportPaths = new Set<string>();

function normalizeOwnedPath(candidate: string): string {
	return path.resolve(candidate);
}

export function registerOwnedExportPath(candidate: string): void {
	ownedExportPaths.add(normalizeOwnedPath(candidate));
}

export function releaseOwnedExportPath(candidate: string): void {
	ownedExportPaths.delete(normalizeOwnedPath(candidate));
}

export function isOwnedExportPath(candidate: string): boolean {
	return ownedExportPaths.has(normalizeOwnedPath(candidate));
}

function generateStreamId() {
	return `recordly-export-stream-${randomUUID()}`;
}

export async function openExportStream(options?: { extension?: string }): Promise<{
	streamId: string;
	tempPath: string;
}> {
	const extension = options?.extension ?? "mp4";
	if (!EXTENSION_ALLOWLIST.test(extension)) {
		throw new Error(`Invalid export stream extension: ${extension}`);
	}
	const streamId = generateStreamId();

	// Per-session 0700 directory defeats TOCTOU/symlink races on shared
	// tempdirs (e.g. /tmp on Linux): only the current user can enter the dir,
	// so an adversary cannot pre-plant a symlink at the file path.
	const sessionDir = await fsp.mkdtemp(path.join(app.getPath("temp"), SESSION_DIR_PREFIX));
	try {
		await fsp.chmod(sessionDir, 0o700);
	} catch {
		// chmod is a defense-in-depth on platforms where mkdtemp already sets
		// a safe mode. Non-Linux filesystems may ignore mode bits entirely.
	}
	const tempPath = path.join(sessionDir, `${streamId}.${extension}`);
	const fileHandle = await fsp.open(
		tempPath,
		fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL,
		0o600,
	);

	exportStreamSessions.set(streamId, {
		streamId,
		sessionDir,
		tempPath,
		fileHandle,
		bytesWritten: 0,
		highestWatermark: 0,
		writeQueue: Promise.resolve(),
		aborted: false,
		writeError: undefined,
		hasWriteError: false,
	});
	registerOwnedExportPath(tempPath);

	return { streamId, tempPath };
}

export async function writeToExportStream(
	streamId: string,
	position: number,
	chunk: Uint8Array,
): Promise<void> {
	const session = exportStreamSessions.get(streamId);
	if (!session) {
		throw new Error(`Export stream not found: ${streamId}`);
	}

	if (session.aborted) {
		throw new Error("Export stream was aborted");
	}

	// Serialize writes against the session to keep byte counters consistent when
	// the renderer issues concurrent chunks.
	const previous = session.writeQueue;
	const next = previous.then(async () => {
		if (session.aborted) {
			return;
		}
		const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		// fileHandle.write may be short (e.g. disk full); loop until everything lands.
		let written = 0;
		try {
			// A negative position would silently write at the current file offset.
			if (!Number.isSafeInteger(position) || position < 0) {
				throw new Error(`Invalid export stream write position: ${position}`);
			}
			while (written < buffer.byteLength) {
				const result = await session.fileHandle.write(
					buffer,
					written,
					buffer.byteLength - written,
					position + written,
				);
				if (result.bytesWritten <= 0) {
					throw new Error("Export stream write made no progress (disk full?)");
				}
				written += result.bytesWritten;
				session.bytesWritten += result.bytesWritten;
			}
		} catch (error) {
			if (!session.hasWriteError) {
				session.hasWriteError = true;
				session.writeError = error;
			}
			throw error;
		}
		const end = position + buffer.byteLength;
		if (end > session.highestWatermark) {
			session.highestWatermark = end;
		}
	});
	session.writeQueue = next.catch(() => undefined);
	await next;
}

export async function closeExportStream(
	streamId: string,
	options?: { abort?: boolean },
): Promise<{ tempPath: string | null; bytesWritten: number }> {
	const session = exportStreamSessions.get(streamId);
	if (!session) {
		throw new Error(`Export stream not found: ${streamId}`);
	}

	const abort = options?.abort === true;
	if (abort) {
		session.aborted = true;
	}

	await session.writeQueue.catch(() => undefined);

	let closeError: unknown;
	let closeFailed = false;
	try {
		await session.fileHandle.close();
	} catch (error) {
		// Ignored on abort so cleanup stays best-effort; fatal on a normal close.
		closeFailed = true;
		closeError = error;
	}

	exportStreamSessions.delete(streamId);

	const failed = !abort && (session.hasWriteError || closeFailed);
	if (abort || failed) {
		releaseOwnedExportPath(session.tempPath);
		try {
			await fsp.rm(session.tempPath, { force: true });
		} catch {
			// Temp file may be gone already.
		}
		try {
			await fsp.rm(session.sessionDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		if (failed) {
			throw session.hasWriteError ? session.writeError : closeError;
		}
		// Aborted streams return `tempPath: null` so callers cannot accidentally
		// reuse a path that no longer references a file on disk (or, worse, a
		// path a later session may recycle).
		return { tempPath: null, bytesWritten: 0 };
	}

	return {
		tempPath: session.tempPath,
		bytesWritten: session.highestWatermark,
	};
}

/** Best-effort removal of the per-export session dir once its file is gone. */
export async function removeExportSessionDirIfEmpty(filePath: string): Promise<void> {
	try {
		const dir = path.dirname(filePath);
		if (path.basename(dir).startsWith(SESSION_DIR_PREFIX)) {
			// rmdir fails on non-empty dirs, which is the desired guard.
			await fsp.rmdir(dir);
		}
	} catch {
		// Directory may be gone, non-empty, or the fs may not support it.
	}
}

/** Removes and releases an owned export temp. Ignores non-owned input and never throws. */
export async function discardOwnedExportPath(candidate: unknown): Promise<void> {
	if (typeof candidate !== "string" || !isOwnedExportPath(candidate)) {
		return;
	}
	try {
		await fsp.rm(candidate, { force: true });
	} catch {
		// Best-effort cleanup.
	}
	await removeExportSessionDirIfEmpty(candidate);
	releaseOwnedExportPath(candidate);
}

export function hasExportStream(streamId: string): boolean {
	return exportStreamSessions.has(streamId);
}

export async function cleanupAllExportStreams(): Promise<void> {
	const sessions = Array.from(exportStreamSessions.values());
	exportStreamSessions.clear();
	ownedExportPaths.clear();
	await Promise.allSettled(
		sessions.map(async (session) => {
			try {
				await session.fileHandle.close();
			} catch {
				// ignore
			}
			try {
				await fsp.rm(session.tempPath, { force: true });
			} catch {
				// ignore
			}
			try {
				await fsp.rm(session.sessionDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}),
	);
}
