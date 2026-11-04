# macOS local installation and Screen Recording permission

Build local recording/editing explicitly with `VITE_RECORDLY_LOCAL_ONLY=true`. Do not configure a hosted account for this mode; Auth and cloud sharing remain disabled. The default build continues to require authentication.

## Build and install

Install dependencies, compile the native helpers, typecheck and build with Vite. Package the arm64 app with `electron-builder --mac --arm64 --dir --publish never`. Set `VITE_RECORDLY_LOCAL_ONLY=true` for the Vite build. Build commands may perform static CommonJS parsing; do not run automated recording, smoke or browser scenarios on this machine. Run automated tests through the repository's Code Quality workflow.

Quit Recordly before replacing the installed application. Keep one active copy at `/Applications/Recordly.app`; keep the previous app as a backup outside active application directories. Preserve `~/Library/Application Support/Recordly`, including projects and recordings. Open the installed copy explicitly rather than an older app under `release/`.

## Permission enabled in Settings but denied by Recordly

An ad hoc signed local app can have a different code-signing hash after a rebuild. A previously granted TCC entry can still be visible and enabled while its code requirement identifies the previous executable. Restarting does not repair an entry for a different executable.

The 2026-11-04 incident was verified read-only: the ScreenCapture grant for `dev.recordly.app` required cdhash `dc7426108fab574b2e3e9ea404c9bc5134cac764`, while the running app in `release/mac-arm64/Recordly.app` had designated requirement `84874c13982e33499ce39891d26b1273375945d9`. The screen permission was therefore enabled for another build.

After installing the intended build:

1. Quit Recordly.
2. In **System Settings → Privacy & Security → Screen & System Audio Recording**, remove the stale Recordly entry and add `/Applications/Recordly.app` again. Alternatively, reset only this bundle's ScreenCapture grant with `tccutil reset ScreenCapture dev.recordly.app`, then add the installed app again.
3. Enable the installed copy and reopen it. Review Accessibility as well if its old grant belongs to a different build.
4. Keep camera/microphone permissions tied to their actual use. Do not reset other applications or directly write to the TCC database.

For distribution across rebuilds, use a consistent Developer ID signing identity and notarization. An installation path alone does not stabilize an ad hoc signature.

## Source update history

The local checkout was updated from `49926862` to upstream `109ca3a1` on 2026-11-04. Upstream had rewritten main's history; the old local main was preserved as `backup/pre-update-20261104`. The pre-existing x64 helper modification was preserved in the named Git stash before switching the same normal checkout to the updated base. No worktree is needed.
