# Recordly local maintenance

- Work in this checkout; preserve pre-existing local changes before updating upstream. Upstream main has previously been rewritten, so inspect divergence before pulling.
- Automated tests, including browser, smoke and integration scenarios, run exclusively in CI. Local checks are limited to lint, syntax, types, builds and read-only administrative inspection.
- Local use is explicitly selected with `VITE_RECORDLY_LOCAL_ONLY=true`. Keep authentication mandatory for default builds and cloud operations disabled in local mode. Never fabricate a Supabase session.
- Reuse `OnboardingPermissions` and `canStartRecording` for permission and account decisions; cloud IPC handlers must continue to validate endpoints through `normalizeCloudEndpoint`.
- A checked macOS TCC row can refer to a prior ad hoc signed build. Compare code requirements before changing permission logic; preserve OS checks and renew only the affected app's grant after installation. See `docs/macos-local-installation.md`. Sign local macOS builds with the stable local identity (`npm run sign:mac-local`) before installing them, so TCC grants survive rebuilds; never leave an installed local build ad hoc signed.
- Record durable findings and session outcomes in the canonical Obsidian vault. Do not duplicate global agent/model profiles in this repository.
- Never move media-sized buffers (anything proportional to recording duration) through `ipcRenderer.invoke`; stream them with the `export-stream-*` IPC and pass owned temp paths validated with `isOwnedExportPath`. Decoded audio is consumed as `PcmSource`, never as a whole-track `AudioBuffer`. See `docs/large-recording-export.md`.
