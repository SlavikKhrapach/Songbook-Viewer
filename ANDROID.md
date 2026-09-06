# Songbook Viewer — Android (Capacitor)

The Android app reuses the exact same web UI as the desktop Electron app
(`src/renderer.js` + `src/styles.css`). Only the host bridge differs:

- **Desktop:** `preload.js` exposes `window.api` backed by Electron IPC (Node `fs`).
- **Android:** `src/mobile-api.js` provides the same `window.api`, backed by
  Capacitor plugins. It self-installs only when the Electron preload is absent,
  so the desktop build is unaffected.

## How the mobile build is assembled

`scripts/build-www.js` produces a self-contained web root in `www/`:

- copies `src/renderer.js` and `src/styles.css` verbatim (mobile stays in sync
  with desktop — do not edit copies in `www/`, they are regenerated)
- copies pdf.js lib + worker into `www/pdfjs/`
- bundles `src/mobile-api.js` (Capacitor imports inlined) with esbuild
- writes a mobile `www/index.html` that:
  - sets `window.PDF_WORKER_SRC` so pdf.js finds its worker locally
  - uses an import map to remap renderer's desktop pdf.js path to `./pdfjs`
  - loads `mobile-api.js` (installs `window.api`) before `renderer.js`

`www/` is regenerated on every build; treat it as a build artifact.

## Mobile bridge behavior (`src/mobile-api.js`)

| window.api method | Android implementation |
| --- | --- |
| `openDialog()` | hidden `<input type=file accept=pdf>` picker |
| `onPdfOpened(cb)` | registers cb, then restores the last book |
| annotations / index | JSON files via `@capacitor/filesystem` |
| page image cache | base64 `.webp` files via Filesystem, namespaced per book + size |
| `prunePageCache` | deletes stale render-size folders |

- **Reopen last book:** when a PDF is imported it is copied into app storage and
  its id/name saved with `@capacitor/preferences`. On launch, `onPdfOpened`
  triggers `reopenLastBook`, which reloads those bytes — so the app reopens the
  last book automatically.
- **Book identity:** there are no file paths on Android, so a book is keyed by a
  slug derived from its filename (mirrors the desktop `bookKeyFromPath`), which
  keeps annotations/caches stable across re-exports.
- **Keep awake:** prefers the native `@capacitor-community/keep-awake` plugin,
  with the web `navigator.wakeLock` API as a fallback.

## Build / run

Prerequisites: Android Studio + SDK (Platform 34), a JDK (Android Studio's
bundled `jbr` works). `android/local.properties` must point `sdk.dir` at your
Android SDK (already set for this machine; regenerate per machine).

```powershell
# regenerate www/ and copy into the native project
npm run mobile:sync

# open the native project in Android Studio (then Run ▶)
npm run mobile:open
```

Or build a debug APK from the command line:

```powershell
npm run mobile:assets
cd android
$env:JAVA_HOME = "$env:ProgramFiles\Android\Android Studio\jbr"
.\gradlew.bat assembleDebug
# -> android\app\build\outputs\apk\debug\app-debug.apk
```

Whenever you change `src/renderer.js`, `src/styles.css`, or `src/mobile-api.js`,
re-run `npm run mobile:sync` before building so `www/` and the native project
pick up the changes.

## iOS (future)

The same `www/` + `mobile-api.js` work for iOS via `cap add ios`, but building a
signed iOS app requires a Mac with Xcode.
