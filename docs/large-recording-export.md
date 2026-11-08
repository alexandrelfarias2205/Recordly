# Exporting long recordings without renderer OOM

This document describes how the export, waveform and recording-finalization
paths keep renderer memory bounded, and the rules that keep it that way.

## Symptom this design prevents

Exporting a 68-minute recording (1.4 GB screen + 1.45 GB webcam + `.mic.m4a`
and `.system.m4a` sidecars) froze at the end of the export and left a black
window. macOS crash reports for `Recordly Helper (Renderer)` showed
`EXC_BREAKPOINT (SIGTRAP)` with 8–16 GB of `VM_ALLOCATE` and the renderer main
thread inside `v8::ValueSerializer::WriteValue`: V8 aborting on out-of-memory
while structured-cloning a huge `ArrayBuffer` for `ipcRenderer.invoke`.

The video side was already streamed to disk (`muxer.ts` uses a mediabunny
`StreamTarget` with 16 MiB chunks over the `export-stream-*` IPC). The audio
side was not:

1. every audio source was decoded into a monolithic float32 `AudioBuffer`
   (1.58 GB per source for 68 minutes at 48 kHz stereo);
2. the edited track was rendered to a full 16-bit WAV in memory (790 MB), turned
   into a `Blob`, then an `ArrayBuffer`, then sent as `editedAudioData` over IPC
   (another copy in the renderer serializer and one more in the main process).

## Current architecture

### Edited audio track → temp WAV on disk

`OfflineAudioProcessor.renderToWavStreamChunked` renders the timeline in
30-second `OfflineAudioContext` chunks and writes each chunk's 16-bit PCM as one
positioned IPC write through `ExportStreamWriter` (`exportStreamIpc.ts`, shared
with the video muxer: `export-stream-open`, `export-stream-write`,
`export-stream-close`). The WAV header is written first
from the estimated frame count and rewritten at offset 0 if the real count
differs. Peak memory is one rendered chunk.

`AudioProcessor.renderEditedAudioTrackToTempFile` returns
`{ tempPath, mimeType: "audio/wav", bytesWritten }`, or `null` when the stream
IPC is unavailable (tests, browser), in which case the exporters fall back to
the legacy `Blob` path.

Both exporters (`modernVideoExporter.ts`, `videoExporter.ts`) send
`editedAudioPath` (never `editedAudioData`) to `nativeVideoExportFinish`,
`muxExportedVideoAudioFromPath`, `muxExportedVideoAudio` and the static-layout
`audioOptions`. They track the temp in `PendingEditedAudioTemp` (`editedAudioSink.ts`): a
successful mux releases it (the main process removes it), a failed mux or
`cleanup()` discards it via `discardExportedTemp`.

Main process (`muxNativeVideoExportAudio`): `editedAudioPath` must pass
`isOwnedExportPath`, is used directly as the FFmpeg audio input, and is removed
and released in `finally`. The IPC handlers reject a non-owned path before doing
any work.

### Decoded sources → `PcmSource`

`src/lib/audio/streamAudioDecode.ts` demuxes and decodes audio chunk-by-chunk
(WebDemuxer + `AudioDecoder`, backpressure of 20 queued decodes). The exporter
accumulates chunks in `ChunkedPcmBuffer` (`src/lib/exporter/pcmSource.ts`),
which implements the `PcmSource` interface (`sampleRate`, `numberOfChannels`,
`length`, `duration`, `copyFromChannel`). An `AudioBuffer` satisfies the same
interface, so the bulk `decodeAudioData` fallback still works.

Sources longer than `COMPACT_PCM_STORAGE_MIN_SAMPLES` (10 minutes of 48 kHz
stereo) are stored as int16, halving memory; shorter sources stay float32 and
are bit-identical to the previous pipeline. Unknown duration is treated as long.

`AudioTimelineProcessor.stretchAudioBuffer` and
`OfflineAudioProcessor.scheduleRegionForChunk` only materialize the window they
play (`createAudioBufferWindow`), so Web Audio never sees a full-length buffer.

### Waveform peaks

`WaveformGenerator.generate` streams the same decoder and keeps
`max(|sample|)` per 64-frame block (`PeakBlockAccumulator`, ~12 MB for 68
minutes), then the existing worker max-pools the blocks down to the requested
peak count. The `fetch` + `decodeAudioData` path remains only as a fallback when
streaming fails.

### Recording finalization

`storeRecordedBlob` (`src/lib/recordingBlobStorage.ts`) streams the finished
`MediaRecorder` blob in 16 MiB slices to an owned temp file and asks the main
process to move it into the recordings directory
(`store-recorded-video-from-temp`, `fs.rename` with an `EXDEV` copy fallback).
The in-memory `storeRecordedVideo` path is used only when the stream API is
missing and the blob is under 2 GiB.

## Known residual risk

`fixWebmDuration` (used only for WebM recordings from `MediaRecorder`, i.e. not
the native MP4 recordings on macOS) still reads the whole blob into renderer
memory to patch the duration header before `storeRecordedBlob` runs. There is no
IPC clone, so the peak is far below the original crash, but a multi-GB WebM
recording on a 16 GB machine remains a risk. The fix is to patch the duration in
the main process (FFmpeg `-c copy`) after the streamed save.

## Rules

- Never send an `ArrayBuffer`/`Uint8Array` whose size scales with media
  duration through `ipcRenderer.invoke`. Stream it with the `export-stream-*`
  IPC (16 MiB positioned writes) and pass the owned temp path instead.
- Every main-process handler that receives a path from the renderer must check
  `isOwnedExportPath` before touching disk, and release ownership when done.
- Never hold a whole decoded track as an `AudioBuffer`; consume a `PcmSource`
  and materialize windows.
- Fallbacks to in-memory paths must be explicit, logged, and bounded by
  `isExportTooLargeForInMemorySave`.

## Verifying

Automated tests run in the Code Quality workflow only (`vitest`):
`pcmSource.test.ts`, `offlineAudioProcessor.wavStream.test.ts`,
`modernVideoExporter.cancellation.test.ts`, `native-video.test.ts`,
`WaveformGenerator.test.ts`, `recordingBlobStorage.test.ts`.

When investigating a new freeze, check
`~/Library/Logs/DiagnosticReports/Recordly Helper (Renderer)-*.ips`: a
`SIGTRAP` with `ValueSerializer::WriteValue` on `CrRendererMain` means a large
IPC payload; `ff_get_buffer` on a worker thread means a decode allocation
failed.
