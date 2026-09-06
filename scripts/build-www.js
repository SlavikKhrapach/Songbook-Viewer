// ---------------------------------------------------------------------------
// Assembles a self-contained web root (www/) for the Capacitor Android build.
// ---------------------------------------------------------------------------
// The Electron app loads renderer.js + pdf.js straight from src/ and
// node_modules/, but Capacitor needs ONE folder that gets copied into the APK.
// This script builds that folder from the existing sources so we never fork
// renderer.js / styles.css:
//   - copies renderer.js, styles.css               (shared, unchanged)
//   - copies pdf.min.mjs + pdf.worker.min.mjs       (into www/pdfjs/)
//   - bundles mobile-api.js (Capacitor deps inlined) via esbuild
//   - writes a mobile index.html with correct relative paths
//
// Run: npm run mobile:assets   (or mobile:sync / mobile:open)
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const WWW = path.join(ROOT, 'www');
const PDFJS_SRC = path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build');

function log(msg) { console.log(`[build-www] ${msg}`); }

// Fresh www/ each run.
fs.rmSync(WWW, { recursive: true, force: true });
fs.mkdirSync(WWW, { recursive: true });
fs.mkdirSync(path.join(WWW, 'pdfjs'), { recursive: true });

// 1) Shared web code (copied verbatim so mobile stays in sync with desktop).
fs.copyFileSync(path.join(SRC, 'renderer.js'), path.join(WWW, 'renderer.js'));
fs.copyFileSync(path.join(SRC, 'styles.css'), path.join(WWW, 'styles.css'));
log('copied renderer.js + styles.css');

// 2) pdf.js library + worker.
fs.copyFileSync(path.join(PDFJS_SRC, 'pdf.min.mjs'), path.join(WWW, 'pdfjs', 'pdf.min.mjs'));
fs.copyFileSync(path.join(PDFJS_SRC, 'pdf.worker.min.mjs'), path.join(WWW, 'pdfjs', 'pdf.worker.min.mjs'));
log('copied pdf.js lib + worker');

// 3) Bundle the mobile bridge (Capacitor imports inlined into one ESM file).
esbuild.buildSync({
  entryPoints: [path.join(SRC, 'mobile-api.js')],
  outfile: path.join(WWW, 'mobile-api.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  minify: true,
});
log('bundled mobile-api.js');

// 4) Mobile index.html. Differences from the desktop one:
//    - relative paths (no ../node_modules)
//    - sets window.PDF_WORKER_SRC so renderer.js finds the worker in ./pdfjs
//    - loads mobile-api.js (installs window.api) BEFORE renderer.js
//    - CSP allows the wake-lock/worker; keeps the app self-contained
const desktopHtml = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');

// Take the desktop <body> markup (everything between the tags) so the UI stays
// identical, and swap in mobile-appropriate <head> + script tags.
const bodyMatch = desktopHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
let bodyInner = bodyMatch ? bodyMatch[1] : '';
// Drop the desktop script tags; we add mobile ones below.
bodyInner = bodyInner.replace(/<script[\s\S]*?<\/script>/gi, '').trimEnd();

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport"
        content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'self' gap: data: blob: 'unsafe-inline'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' https: blob: data:;" />
  <title>Songbook Viewer</title>
  <link rel="stylesheet" href="styles.css" />
  <script>
    // Point renderer.js's pdf.js worker at the bundled copy under ./pdfjs.
    window.PDF_WORKER_SRC = 'pdfjs/pdf.worker.min.mjs';
  </script>
</head>
<body>
${bodyInner}

  <!-- Import map first: remap renderer.js's desktop pdf.js path to the local
       bundled copy. Must precede any module that uses the specifier. -->
  <script type="importmap">
    {
      "imports": {
        "../node_modules/pdfjs-dist/build/pdf.min.mjs": "./pdfjs/pdf.min.mjs"
      }
    }
  </script>
  <!-- Mobile bridge installs window.api BEFORE the renderer runs, then the
       shared renderer (unchanged from desktop) executes. -->
  <script type="module" src="mobile-api.js"></script>
  <script type="module" src="renderer.js"></script>
</body>
</html>
`;

fs.writeFileSync(path.join(WWW, 'index.html'), html, 'utf8');
log('wrote index.html');
log(`done -> ${WWW}`);
