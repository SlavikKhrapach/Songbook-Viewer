import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.min.mjs';

// Point PDF.js at its worker (bundled with pdfjs-dist). A host page (e.g. the
// Capacitor/Android build) may set window.PDF_WORKER_SRC to override the path,
// since its files live in a different layout than the Electron app.
pdfjsLib.GlobalWorkerOptions.workerSrc =
  (typeof window !== 'undefined' && window.PDF_WORKER_SRC)
    ? window.PDF_WORKER_SRC
    : '../node_modules/pdfjs-dist/build/pdf.worker.min.mjs';

// ---------- State ----------
let pdfDoc = null;
const scale = 1;            // fixed zoom
let currentPage = 1;           // left-most visible page (1-based)
let renderToken = 0;           // invalidates in-flight renders on reload/zoom
let isScrubbing = false;

let viewCount = 1;             // pages shown at once (1 portrait, 2 landscape)

let slotWidth = 0;             // px width of one page slot (viewW / viewCount)
let viewH = 0;                 // usable viewport height

// Caches:
//  - fullCache: bounded LRU of rendered page canvases (rolling window in RAM)
//  - titleCache: extracted song number + title per page (for search & scrubber)
let fullCache = new Map();     // page number -> full-res canvas (LRU by insert order)
let titleCache = new Map();    // page number -> extracted song title (string)
let langByPage = new Map();    // page number -> 'ru' | 'en' (by script detection)
let sweepJob = 0;              // cancels the background title sweep on reload

const FULL_BUFFER = 3;         // pages of full-res to eagerly render each side

// Rolling in-memory cache size: like Edge, keep only a window of pages decoded
// in RAM and let the rest live on disk. This caps memory regardless of book
// size. ~40 canvases at ~4-9 MB each stays a few hundred MB, not gigabytes.
const MAX_MEM_PAGES = 40;

const DPR = window.devicePixelRatio || 1;
// Pixel density for rendering. On desktop we cap at 1.5 to keep canvas memory
// manageable (barely visible difference at normal viewing distance). On mobile
// (Capacitor WebView) we honour the full device DPR — capping at 1.5 on a 3x
// screen is the main reason pages look blurry on Android. A ceiling of 3.0
// covers all current consumer devices without blowing up RAM.
const MOBILE = typeof window !== 'undefined' && !!window.Capacitor;
const RENDER_DPR = Math.min(DPR, MOBILE ? 3.0 : 1.5);

// ---- Bounded LRU for rendered page canvases ----
// Insertion order in the Map is the recency order; re-inserting bumps a page
// to "most recent". When over capacity we evict the oldest that isn't near the
// current view (its pixels can be reloaded from disk instantly if needed).
function cacheGet(n) {
  const c = fullCache.get(n);
  if (c) { fullCache.delete(n); fullCache.set(n, c); } // bump recency
  return c || null;
}
function cachePut(n, canvas) {
  fullCache.set(n, canvas);
  evictCache();
}
function evictCache() {
  if (fullCache.size <= MAX_MEM_PAGES) return;
  const keepLo = currentPage - FULL_BUFFER - 1;
  const keepHi = currentPage + viewCount + FULL_BUFFER;
  for (const key of fullCache.keys()) {
    if (fullCache.size <= MAX_MEM_PAGES) break;
    if (key >= keepLo && key <= keepHi) continue; // never evict near view
    // Free the backing bitmap explicitly.
    const c = fullCache.get(key);
    if (c) { c.width = 0; c.height = 0; }
    fullCache.delete(key);
  }
}

// ---------- Annotations ----------
// Strokes are stored in PDF-page coordinates (fractions 0..1 of page width/
// height) so they stay correct at any zoom/orientation. Each stroke:
//   { color, width, opacity, erase, points: [{x, y}, ...] }
//
// Annotations are keyed by SONG, not by PDF page, so they survive songbook
// re-exports where page numbers shift. The key is:
//   "s<songNumber>:<pageOffsetWithinSong>"   e.g. "s42:0", "s42:1"
// Pages with no detected song number fall back to "p<pageNumber>".
let currentPdfPath = null;
let annotations = {};          // songKey -> [ stroke, ... ]
let songKeyByPage = new Map(); // page number -> songKey (built from titles)
let songStartPages = new Map(); // page number -> song number, ONLY for pages that truly start a song
let undoStack = [];            // reversible actions: {type, key, ...}
let redoStack = [];            // actions that were undone (for redo)
const UNDO_LIMIT = 200;
let lastFocusedPage = null;    // last page the user drew on / touched
let drawMode = false;
let penColor = '#e02424';
let penWidth = 6;              // logical px at 100% (scaled by pressure)
let penOpacity = 0.9;
let eraserOn = false;
let saveTimer = null;

// ---------- Tool presets ----------
// The active drawing tool. 'pen' = freehand ink, 'highlighter' = wide,
// translucent, multiply-blended marker that never hides the print beneath it,
// 'text' = tap to drop a small typed note (capo, key, "x2", etc.).
// Pen & highlighter can be snapped to a straight line by holding still at the
// end of a stroke (see attachDrawing's hold-to-straighten gesture).
let tool = 'pen';              // 'pen' | 'highlighter' | 'text'
// Default text-note height as a fraction of the page height (so notes scale
// with the page and stay consistent across zoom/render sizes).
const TEXT_DEFAULT_SIZE = 0.022;

// Each tool remembers its own colour / size / opacity so switching back and
// forth doesn't clobber the other's settings. The `pen*` globals mirror
// whichever tool is currently active (so all the existing UI keeps working).
// The text tool only uses `color` (size is fixed via TEXT_DEFAULT_SIZE).
const toolState = {
  pen:         { color: '#e02424', width: 6,  opacity: 0.9 },
  highlighter: { color: '#f8e71c', width: 22, opacity: 0.35 },
  text:        { color: '#e02424', width: 6,  opacity: 1 },
};

// ---------- Elements ----------
const viewer = document.getElementById('viewer');
const track = document.getElementById('pages'); // horizontal filmstrip
const welcome = document.getElementById('welcome');
const libraryBtn = document.getElementById('libraryBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const menuToggle = document.getElementById('menuToggle');
const dropOverlay = document.getElementById('dropOverlay');
const tapZones = document.getElementById('tapZones');

const scrubber = document.getElementById('scrubber');
const scrubTrack = document.getElementById('scrubTrack');
const scrubFill = document.getElementById('scrubFill');
const scrubThumb = document.getElementById('scrubThumb');
const scrubBubble = document.getElementById('scrubBubble');
const indexToast = document.getElementById('indexToast');
const indexToastLabel = document.getElementById('indexToastLabel');
const indexBarFill = document.getElementById('indexBarFill');

const themeBtn = document.getElementById('themeBtn');
const cornerRightGroup = document.querySelector('.corner-right-group');
const penBtn = document.getElementById('penBtn');
const drawTools = document.getElementById('drawTools');
const colorBtn = document.getElementById('colorBtn');
const colorDot = document.getElementById('colorDot');
const colorPopover = document.getElementById('colorPopover');
const penColors = document.getElementById('penColors');
const penSize = document.getElementById('penSize');
const penOpacityEl = document.getElementById('penOpacity');
const penSizeVal = document.getElementById('penSizeVal');
const penOpacityVal = document.getElementById('penOpacityVal');
const eraserBtn = document.getElementById('eraserBtn');
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');
const eraserHint = document.getElementById('eraserHint');
const searchBtn = document.getElementById('searchBtn');
const searchPanel = document.getElementById('searchPanel');
const searchInput = document.getElementById('searchInput');
const searchClose = document.getElementById('searchClose');
const searchResults = document.getElementById('searchResults');
const numpad = document.getElementById('numpad');
const npKeyboard = document.getElementById('npKeyboard');
const npBackspace = document.getElementById('npBackspace');
const zoomOutBtn = document.getElementById('zoomOutBtn');

// Import-markups prompt elements.
const importPrompt = document.getElementById('importPrompt');
const importBookList = document.getElementById('importBookList');
const importConfirmBtn = document.getElementById('importConfirmBtn');
const importSkipBtn = document.getElementById('importSkipBtn');
const importFileBtn = document.getElementById('importFileBtn');

// Touch capability: a device with a touchscreen (e.g. Surface Pro, tablet).
// On these we show the custom numpad instead of the OS virtual keyboard.
const hasTouch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;

// ---------- Orientation ----------
// Landscape -> two pages, portrait -> one page. Always automatic.
function resolveViewCount() {
  return viewer.clientWidth >= viewer.clientHeight ? 2 : 1;
}

// ---------- Loading ----------
async function loadPdf(data, name, filePath) {
  renderToken++;
  const token = renderToken;

  const loadingTask = pdfjsLib.getDocument({ data });
  pdfDoc = await loadingTask.promise;
  if (token !== renderToken) return;

  welcome.classList.add('hidden');
  tapZones.classList.remove('disabled'); // enable tap navigation once a PDF is open
  currentPage = 1;
  titleCache.clear();   // fresh document -> discard old titles
  langByPage.clear();

  // Load saved annotations for this document (keyed by its path).
  currentPdfPath = filePath || name || null;
  await loadAnnotationsForCurrent();
  if (token !== renderToken) return;

  await layout(token);
  scrubber.classList.remove('disabled');

  // Build the page index (song numbers/titles/languages), using the saved
  // cache if available so re-opening is instant.
  indexBook(token);

  // Pre-cache every page to disk in the background so future jumps are fast
  // disk reads. Memory stays bounded (rolling window + LRU).
  prerenderPages(token);
}

// ---------- Toast helpers ----------
function showIndexToast(label) {
  indexToastLabel.textContent = label;
  indexBarFill.style.width = '0%';
  indexToast.classList.remove('hidden');
}
function updateIndexToast(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  indexBarFill.style.width = `${pct}%`;
  indexToastLabel.textContent = `Indexing songbook… ${done} / ${total}`;
}
function hideIndexToast() {
  indexToast.classList.add('hidden');
}

// ---------- Book indexing (cached) ----------
// Populate titleCache + langByPage. First try the on-disk cache; if it matches
// this book (same page count), use it instantly. Otherwise extract text from
// every page (showing progress) and save the result for next time.
async function indexBook(token) {
  sweepJob++;
  const job = sweepJob;
  const total = pdfDoc.numPages;

  // 1) Try the saved index.
  if (window.api.loadIndex && currentPdfPath) {
    try {
      const cached = await window.api.loadIndex(currentPdfPath);
      if (token !== renderToken) return;
      if (cached && cached.pageCount === total && cached.titles && cached.langs) {
        for (let n = 1; n <= total; n++) {
          if (cached.titles[n] !== undefined) titleCache.set(n, cached.titles[n]);
          if (cached.langs[n] !== undefined) langByPage.set(n, cached.langs[n]);
        }
        rebuildSongKeyMap();
        redrawVisibleAnnotations();
        return; // cache hit — no extraction needed
      }
    } catch { /* fall through to fresh index */ }
  }

  // 2) No usable cache: extract from every page with a progress toast.
  showIndexToast('Indexing songbook…');

  // Visible pages first for a quick song-key resolve.
  const firstUp = [currentPage, currentPage + 1].filter(n => n >= 1 && n <= total);
  for (const n of firstUp) {
    if (job !== sweepJob || token !== renderToken) { hideIndexToast(); return; }
    if (!titleCache.has(n)) await extractTitle(n);
  }
  rebuildSongKeyMap();
  redrawVisibleAnnotations();

  let done = 0;
  for (let n = 1; n <= total; n++) {
    if (job !== sweepJob || token !== renderToken) { hideIndexToast(); return; }
    if (!titleCache.has(n)) await extractTitle(n);
    done++;
    if (n % 5 === 0 || n === total) updateIndexToast(done, total);
    if (n % 25 === 0) { rebuildSongKeyMap(); redrawVisibleAnnotations(); }
  }
  rebuildSongKeyMap();
  redrawVisibleAnnotations();
  hideIndexToast();

  // 3) Save the index for next time.
  if (window.api.saveIndex && currentPdfPath) {
    const titles = {};
    const langs = {};
    for (let n = 1; n <= total; n++) {
      if (titleCache.has(n)) titles[n] = titleCache.get(n);
      if (langByPage.has(n)) langs[n] = langByPage.get(n);
    }
    window.api.saveIndex(currentPdfPath, { pageCount: total, titles, langs });
  }
}

// ---------- Background whole-book DISK pre-cache ----------
// Renders every page once to the on-disk WebP cache (nearest first) so future
// jumps are fast disk reads. Memory stays flat: far pages are encoded and
// discarded immediately; only near pages stay in the RAM LRU.
let pageSweepJob = 0;
async function prerenderPages(token) {
  pageSweepJob++;
  const job = pageSweepJob;
  const total = pdfDoc.numPages;

  const order = [currentPage];
  for (let d = 1; d < total; d++) {
    if (currentPage + d <= total) order.push(currentPage + d);
    if (currentPage - d >= 1) order.push(currentPage - d);
  }

  for (const n of order) {
    if (job !== pageSweepJob || token !== renderToken) return;

    const near = Math.abs(n - currentPage) <= FULL_BUFFER + viewCount;
    if (near) {
      // Near the view: render normally (populates LRU + fills the slot).
      if (!cacheGet(n)) {
        const c = await renderFull(n, token);
        if (job !== pageSweepJob || token !== renderToken) return;
        if (c) fillSlotIfEmpty(n);
      }
    } else {
      // Far away: only ensure a disk copy exists, without keeping RAM.
      await ensureDiskCached(n, token);
      if (job !== pageSweepJob || token !== renderToken) return;
    }
    await new Promise(r => setTimeout(r, 0)); // keep UI responsive
  }
}

// Ensure page n has a disk-cached image; render+encode+discard if missing.
// Does NOT populate the in-memory LRU, so the sweep stays memory-flat.
async function ensureDiskCached(n, token) {
  if (!currentPdfPath || !window.api.loadPageImage) return;
  try {
    const existing = await window.api.loadPageImage(currentPdfPath, sizeKey, n);
    if (token !== renderToken) return;
    if (existing && existing.byteLength) return;  // already cached
  } catch { /* render below */ }

  const page = await pdfDoc.getPage(n);
  if (token !== renderToken) return;
  const viewport = page.getViewport({ scale: docFitScale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * RENDER_DPR);
  canvas.height = Math.floor(viewport.height * RENDER_DPR);
  const ctx = canvas.getContext('2d');
  ctx.scale(RENDER_DPR, RENDER_DPR);
  await page.render({ canvasContext: ctx, viewport }).promise;
  if (token !== renderToken) { canvas.width = 0; canvas.height = 0; return; }

  const keyNow = sizeKey;
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/webp', 0.82));
  if (blob && keyNow === sizeKey) {
    const buf = await blob.arrayBuffer();
    await window.api.savePageImage(currentPdfPath, keyNow, n, buf);
  }
  // Free the bitmap immediately.
  canvas.width = 0; canvas.height = 0;
}

// Redraw annotations on the currently visible page(s).
function redrawVisibleAnnotations() {
  redrawAnnotations(currentPage);
  if (viewCount > 1) redrawAnnotations(currentPage + 1);
}

// Extract the song title from a page's text: the FIRST (topmost) line.
async function extractTitle(n) {
  if (titleCache.has(n)) return titleCache.get(n);
  let title = '';
  try {
    const page = await pdfDoc.getPage(n);
    const content = await page.getTextContent();

    // Detect language from the whole page's script (Cyrillic => Russian).
    let allText = '';
    for (const item of content.items) allText += item.str || '';
    langByPage.set(n, detectLang(allText));

    // Group text items into lines by their vertical position.
    const lines = new Map(); // roundedY -> { y, text, xMin }
    for (const item of content.items) {
      const str = (item.str || '');
      if (!str.trim()) continue;
      const tr = item.transform; // [a,b,c,d,e,f]; e=x, f=y (origin bottom-left)
      const x = tr[4];
      const y = tr[5];
      const key = Math.round(y / 2) * 2; // bucket nearby items onto one line
      const existing = lines.get(key);
      if (existing) {
        existing.items.push({ x, str });
      } else {
        lines.set(key, { y, items: [{ x, str }] });
      }
    }

    const lineArr = [...lines.values()];
    if (lineArr.length) {
      // Top-down order (PDF coords are bottom-up, so highest y first).
      lineArr.sort((a, b) => b.y - a.y);
      // First line = song number, second line = title. Combine them.
      const topTwo = lineArr.slice(0, 2).map((line) => {
        line.items.sort((a, b) => a.x - b.x);
        return line.items.map(i => i.str).join('').trim();
      }).filter(Boolean);
      title = topTwo.join(' · ');
    }
  } catch {
    title = '';
  }

  title = cleanTitle(title);
  titleCache.set(n, title);
  return title;
}

function cleanTitle(s) {
  if (!s) return '';
  // Collapse whitespace and trim; cap length so the bubble stays tidy.
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > 60) s = s.slice(0, 57) + '…';
  return s;
}

// Classify a page's language by script: any meaningful Cyrillic => Russian.
function detectLang(text) {
  const cyr = (text.match(/[\u0400-\u04FF]/g) || []).length;
  const lat = (text.match(/[A-Za-z]/g) || []).length;
  // Russian if Cyrillic is present and at least a fifth of the letters, or if
  // there's clearly more Cyrillic than Latin.
  if (cyr > 0 && (cyr >= lat || cyr >= (cyr + lat) * 0.2)) return 'ru';
  return 'en';
}
function langForPage(n) {
  return langByPage.get(n) || 'en';
}

// Measure the viewport, decide slot sizing, clear caches.
// Pages centre in the FULL viewer height; the scrubber floats over the bottom
// edge rather than reserving any space.
function measure() {
  viewCount = resolveViewCount();
  slotWidth = viewer.clientWidth / viewCount;
  viewH = viewer.clientHeight;
}

// Compute a single fit scale used for EVERY page so all pages render the same
// size. Uniform sizing is what lets adjacent pages sit perfectly flush.
let docFitScale = 1;
let sizeKey = '0';   // identifies the current render dimensions for disk cache
async function computeDocFitScale(token) {
  const page = await pdfDoc.getPage(1);
  if (token !== renderToken) return;
  const vp1 = page.getViewport({ scale: 1 });
  // Fit to the slot width, drop to a height fit if that would be too tall, then
  // apply the display zoom (scale). The scrubber floats over the bottom edge,
  // so a page that's a touch taller than the reading area is fine — the bar
  // just overlaps it slightly.
  let fit = slotWidth / vp1.width;
  if (vp1.height * fit > viewH) fit = viewH / vp1.height;
  docFitScale = fit * scale;
  // Cache key: the actual rendered pixel dimensions of a page at this fit.
  const vp = page.getViewport({ scale: docFitScale });
  const pw = Math.floor(vp.width * RENDER_DPR);
  const ph = Math.floor(vp.height * RENDER_DPR);
  sizeKey = `${pw}x${ph}`;
  // Drop cached images for other window sizes to save disk.
  if (currentPdfPath && window.api.prunePageCache) {
    window.api.prunePageCache(currentPdfPath, sizeKey);
  }
}

// Build a page canvas from a cached image data URL (matches renderFull output).
// Build a page canvas from cached WebP bytes (ArrayBuffer). Uses createImage-
// Bitmap when available (fast, off-thread decode) with an <img> fallback.
async function canvasFromBytes(n, bytes) {
  if (!bytes || !bytes.byteLength) return null;
  const blob = new Blob([bytes], { type: 'image/webp' });
  let source;
  try {
    source = await createImageBitmap(blob);
  } catch {
    source = await new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }
  if (!source) return null;
  const w = source.width || source.naturalWidth;
  const h = source.height || source.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.className = 'page-canvas';
  canvas.dataset.page = String(n);
  canvas.dataset.tier = 'full';
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = `${Math.round(w / RENDER_DPR)}px`;
  canvas.style.height = `${Math.round(h / RENDER_DPR)}px`;
  canvas.getContext('2d').drawImage(source, 0, 0);
  if (source.close) source.close();  // free the ImageBitmap
  return canvas;
}

// Full (re)layout: clears the track and cache, then positions the window.
async function layout(token) {
  measure();
  await computeDocFitScale(token);
  if (token !== renderToken) return;
  track.innerHTML = '';
  fullCache.clear();
  clampCurrentPage();
  zoom = 1; panX = 0; panY = 0;   // fresh layout starts at fit
  positionTrack(false);
  updateZoomUi();
  await ensureWindowRendered(token);
  updateScrubber();
}

// Keep currentPage within a range that leaves a full window when possible.
function clampCurrentPage() {
  const total = pdfDoc.numPages;
  const maxStart = Math.max(1, total - viewCount + 1);
  if (currentPage > maxStart) currentPage = maxStart;
  if (currentPage < 1) currentPage = 1;
}

// Render a single page at full resolution (cached in fullCache). Uses the
// on-disk image cache when available, and saves freshly rendered pages to it.
// Pass an explicit `dpr` to render at a higher quality than RENDER_DPR (e.g.
// the full device DPR for currently-visible pages); background/cached pages
// use the default RENDER_DPR to keep disk cache and memory bounded.
async function renderFull(n, token, dpr = RENDER_DPR) {
  const inMem = cacheGet(n);
  // Re-render if cached canvas was rendered at a lower DPR than requested.
  if (inMem) {
    const cachedDpr = Number(inMem.dataset.renderDpr) || RENDER_DPR;
    if (cachedDpr >= dpr - 0.01) return inMem;   // cached quality is good enough
    // Fall through and re-render at the higher DPR.
  }

  // 1) Try the disk image cache — but only if the requested DPR matches the
  //    standard cache DPR (disk images are encoded at RENDER_DPR).
  if (dpr <= RENDER_DPR + 0.01 && currentPdfPath && window.api.loadPageImage) {
    try {
      const bytes = await window.api.loadPageImage(currentPdfPath, sizeKey, n);
      if (token !== renderToken) return null;
      if (bytes) {
        const cached = await canvasFromBytes(n, bytes);
        if (token !== renderToken) return null;
        if (cached) { cachePut(n, cached); return cached; }
      }
    } catch { /* fall through to render */ }
  }

  // 2) Render with PDF.js at the requested DPR.
  const page = await pdfDoc.getPage(n);
  if (token !== renderToken) return null;

  const viewport = page.getViewport({ scale: docFitScale });

  const canvas = document.createElement('canvas');
  canvas.className = 'page-canvas';
  canvas.dataset.page = String(n);
  canvas.dataset.tier = 'full';
  canvas.dataset.renderDpr = String(dpr);
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  await page.render({ canvasContext: ctx, viewport }).promise;
  if (token !== renderToken) return null;

  cachePut(n, canvas);

  // 3) Only write to the disk cache at the standard DPR to keep the cache
  //    consistent. HQ-only renders are for the screen; they'll be re-rendered
  //    next launch too (which is fast since they're the first pages loaded).
  if (dpr <= RENDER_DPR + 0.01) queueDiskWrite(n, canvas);

  return canvas;
}

// Serialized disk writer: encodes one page at a time to keep memory flat.
const diskWriteQueue = [];
let diskWriting = false;
function queueDiskWrite(n, canvas) {
  if (!currentPdfPath || !window.api.savePageImage) return;
  const keyAtQueue = sizeKey;
  diskWriteQueue.push({ n, canvas, sizeKey: keyAtQueue });
  processDiskWrites();
}
async function processDiskWrites() {
  if (diskWriting) return;
  diskWriting = true;
  try {
    while (diskWriteQueue.length) {
      const { n, canvas, sizeKey: sk } = diskWriteQueue.shift();
      if (sk !== sizeKey) continue;   // stale size (resized); skip
      const blob = await new Promise((res) =>
        canvas.toBlob(res, 'image/webp', 0.82));
      if (!blob) continue;
      const buf = await blob.arrayBuffer();
      await window.api.savePageImage(currentPdfPath, sk, n, buf);
      await new Promise((r) => setTimeout(r, 0)); // yield between writes
    }
  } catch { /* ignore cache write failures */ }
  diskWriting = false;
}

// Return the in-memory canvas for a page if present (bumps LRU), else null.
function bestCanvasFor(n) {
  return cacheGet(n);
}

// Wrap the page canvas together with a transparent annotation overlay and
// mount them in the slot. Redraws any saved strokes for the page.
function mountPage(slot, n, pageCanvas) {
  slot.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'page-wrap';
  wrap.dataset.page = String(n);

  const w = parseFloat(pageCanvas.style.width);
  const h = parseFloat(pageCanvas.style.height);
  wrap.style.width = `${w}px`;
  wrap.style.height = `${h}px`;

  const anno = document.createElement('canvas');
  anno.className = 'anno-canvas';
  anno.dataset.page = String(n);
  anno.width = Math.floor(w * DPR);
  anno.height = Math.floor(h * DPR);
  anno.style.width = `${w}px`;
  anno.style.height = `${h}px`;

  wrap.appendChild(pageCanvas);
  wrap.appendChild(anno);
  slot.appendChild(wrap);

  attachDrawing(anno, n);
  redrawAnnotations(n);
}

// Put the full-res canvas (wrapped with its overlay) into a slot once ready.
function fillSlotIfEmpty(n) {
  const slot = track.querySelector(`.slot[data-slot="${n}"]`);
  if (!slot) return;
  const wrap = slot.querySelector('.page-wrap');
  if (wrap && wrap.firstChild && wrap.firstChild.dataset.tier === 'full') return;
  const best = bestCanvasFor(n);
  if (!best) return;
  mountPage(slot, n, best);
}

// ---------- Song-based annotation keying ----------
// Build page -> songKey from the extracted titles. Each page that carries a
// song number starts a new song section; following pages without a number
// belong to the same section with an incrementing offset.
//
// Some songs appear twice under the same number: an English version and a
// Russian version. We tell them apart by the page's SCRIPT (Cyrillic =>
// Russian) and include the language in the key, so each version keeps its own
// marks regardless of order:
//   English song 42 -> "s42:en:0"
//   Russian song 42 -> "s42:ru:0"
// Pages before the first detected song (front matter) fall back to "p<page>".
function rebuildSongKeyMap() {
  songKeyByPage = new Map();
  songStartPages = new Map();   // page -> clean song number, ONLY for real starts
  if (!pdfDoc) return;
  const total = pdfDoc.numPages;
  let currentKeyBase = null;    // e.g. "s42:ru"
  let offset = 0;

  for (let n = 1; n <= total; n++) {
    const entry = titleCache.get(n);
    const num = entry !== undefined ? parseEntry(entry).num : '';
    if (num) {
      currentKeyBase = `s${num}:${langForPage(n)}`;
      offset = 0;
    } else if (currentKeyBase !== null) {
      offset += 1;
    }
    songKeyByPage.set(n, currentKeyBase !== null ? `${currentKeyBase}:${offset}` : `p${n}`);
  }

  // Decide which pages are TRUE song starts for the scrubber bubble. The
  // indexer parses a number off the top of every page, so table-of-contents,
  // front matter, and the odd mis-read page all produce stray numbers. Real
  // song numbers form the long, mostly-ascending run through the book; the
  // strays sit off that trend. We keep the longest non-decreasing subsequence
  // of the candidates (by page order) so a single bad value — e.g. a stray
  // "29" early on — is DROPPED instead of poisoning the threshold and hiding
  // songs 8..28 behind it.
  computeSongStartPages(total);
}

// Collect (page, number) candidates and keep the longest non-decreasing
// subsequence by page order — that run is the real song sequence. Fills
// songStartPages with page -> "number" for those pages only.
function computeSongStartPages(total) {
  const cand = [];   // { page, num }
  for (let n = 1; n <= total; n++) {
    const entry = titleCache.get(n);
    if (entry === undefined) continue;
    const num = parseEntry(entry).num;
    if (!num) continue;
    const clean = parseInt(String(num).match(/^\s*(\d+)/)?.[1] ?? '', 10);
    if (Number.isFinite(clean)) cand.push({ page: n, num: clean });
  }
  if (!cand.length) return;

  // Longest non-decreasing subsequence over cand[].num (patience/DP, O(k^2) is
  // fine for a few thousand songs). Non-decreasing allows repeats (EN/RU pairs).
  const dp = new Array(cand.length).fill(1);
  const prev = new Array(cand.length).fill(-1);
  let bestEnd = 0;
  for (let i = 0; i < cand.length; i++) {
    for (let j = 0; j < i; j++) {
      if (cand[j].num <= cand[i].num && dp[j] + 1 > dp[i]) {
        dp[i] = dp[j] + 1;
        prev[i] = j;
      }
    }
    if (dp[i] > dp[bestEnd]) bestEnd = i;
  }
  for (let i = bestEnd; i !== -1; i = prev[i]) {
    songStartPages.set(cand[i].page, String(cand[i].num));
  }
}

// The annotation key for a page. Falls back to page-number key if the song
// map hasn't been built for this page yet.
function songKeyForPage(n) {
  return songKeyByPage.get(n) || `p${n}`;
}

// Best song number to display for a page. Uses the page's own parsed number if
// it is a genuine song START (its number is in ascending song order — see
// rebuildSongKeyMap). Returns '' for every other page: front matter, table of
// contents, back matter, and the continuation pages of a multi-page song. So
// the scrubber bubble shows only real song numbers.
function songNumberForPage(n) {
  return songStartPages.get(n) || '';
}

// ---------- Drawing engine ----------
function annoCanvasFor(n) {
  return track.querySelector(`.anno-canvas[data-page="${n}"]`);
}

// A reusable offscreen buffer for compositing a single stroke at full opacity.
let strokeBuffer = null;
function getStrokeBuffer(W, H) {
  if (!strokeBuffer) strokeBuffer = document.createElement('canvas');
  if (strokeBuffer.width !== W || strokeBuffer.height !== H) {
    strokeBuffer.width = W;
    strokeBuffer.height = H;
  }
  return strokeBuffer;
}

// Redraw all saved strokes (plus an optional in-progress one) onto a page.
function redrawAnnotations(n, live) {
  const canvas = annoCanvasFor(n);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const W = canvas.width, H = canvas.height;

  const strokes = annotations[songKeyForPage(n)] || [];
  for (const s of strokes) drawItem(ctx, s, W, H);
  if (live) drawItem(ctx, live, W, H);
}

// Draw one annotation item — a text note or a stroke — onto the context.
function drawItem(ctx, item, W, H) {
  if (item && item.type === 'text') drawTextNote(ctx, item, W, H);
  else compositeStroke(ctx, item, W, H);
}

// Measure a text note's box in canvas pixels: its font size, line metrics, and
// overall width/height. (x, y) is the note's TOP-LEFT anchor in page fractions.
function textNoteMetrics(ctx, t, W, H) {
  const fontPx = (t.size || TEXT_DEFAULT_SIZE) * H;
  ctx.font = `${fontPx}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const lines = String(t.text || '').split('\n');
  const lineH = fontPx * 1.25;
  let maxW = 0;
  for (const ln of lines) maxW = Math.max(maxW, ctx.measureText(ln).width);
  return { fontPx, lineH, lines, width: maxW, height: lineH * lines.length };
}

// Render a text note. Draws each line left-aligned from the (x, y) top-left.
function drawTextNote(ctx, t, W, H) {
  if (!t.text) return;
  ctx.save();
  const m = textNoteMetrics(ctx, t, W, H);
  ctx.fillStyle = t.color || '#e02424';
  ctx.textBaseline = 'top';
  ctx.globalAlpha = 1;
  const x = t.x * W, y = t.y * H;
  for (let i = 0; i < m.lines.length; i++) {
    ctx.fillText(m.lines[i], x, y + i * m.lineH);
  }
  ctx.restore();
}

// Trace a stroke's path onto a context (no alpha handling here).
function traceStroke(ctx, s, W, H, colorOverride) {
  ctx.lineJoin = 'round';
  ctx.strokeStyle = colorOverride || s.color || '#e02424';
  ctx.fillStyle = ctx.strokeStyle;
  const baseW = (s.width || 0.01) * W;
  const pts = s.points;

  // All tools use round caps for smooth, rounded stroke ends.
  ctx.lineCap = 'round';

  // A straightened stroke (via hold-to-straighten, or the legacy line tool) is
  // a clean segment between its two endpoints.
  if ((s.straight || s.tool === 'line') && pts.length >= 2) {
    const a = pts[0], b = pts[pts.length - 1];
    ctx.lineWidth = baseW;
    ctx.beginPath();
    ctx.moveTo(a.x * W, a.y * H);
    ctx.lineTo(b.x * W, b.y * H);
    ctx.stroke();
    return;
  }

  if (pts.length === 1) {
    // A single dab: a round dot for every tool.
    ctx.beginPath();
    ctx.arc(pts[0].x * W, pts[0].y * H, baseW / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].x * W, pts[0].y * H);
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    // The highlighter keeps a constant width (pressure would look uneven on a
    // marker); ink still tapers with stylus pressure.
    ctx.lineWidth = (s.tool === 'highlighter') ? baseW : baseW * (p.pr ? (0.5 + p.pr) : 1);
    ctx.lineTo(p.x * W, p.y * H);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x * W, p.y * H);
  }
}

// Composite a whole stroke onto the target so its opacity is UNIFORM even
// where the stroke overlaps itself. Erasing is drawn directly.
function compositeStroke(ctx, s, W, H) {
  if (!s.points || s.points.length === 0) return;

  if (s.erase) {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    traceStroke(ctx, s, W, H, 'rgba(0,0,0,1)');
    ctx.restore();
    return;
  }

  // Highlighter blends with 'multiply' so the ink tints the print rather than
  // painting over it — the notes/lyrics stay readable underneath the mark.
  const blend = s.tool === 'highlighter' ? 'multiply' : 'source-over';
  const opacity = s.opacity ?? 1;

  if (opacity >= 1 && blend === 'source-over') {
    // Fully opaque ink: no self-overlap issue, draw directly.
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    traceStroke(ctx, s, W, H);
    ctx.restore();
    return;
  }

  // Translucent (or highlighter): render the stroke opaque on an offscreen
  // buffer, then blit the flattened shape onto the page once at the stroke's
  // opacity and blend mode. Flattening keeps the opacity UNIFORM even where the
  // stroke overlaps itself.
  const buf = getStrokeBuffer(W, H);
  const bctx = buf.getContext('2d');
  bctx.clearRect(0, 0, W, H);
  bctx.globalCompositeOperation = 'source-over';
  bctx.globalAlpha = 1;
  traceStroke(bctx, s, W, H);

  ctx.save();
  ctx.globalCompositeOperation = blend;
  ctx.globalAlpha = opacity;
  ctx.drawImage(buf, 0, 0);
  ctx.restore();
}

// ---------- Text notes ----------
// Only one text editor is open at a time. It's a floating <textarea> positioned
// over the page-wrap; committing bakes the text into an annotation item.
let textEditor = null;

// Open the text editor at fractional point (fx, fy) on page n. If `existing`
// is an annotation item, we're editing it in place (it's temporarily removed
// from the array and re-added on commit).
function openTextEditor(n, fx, fy, existing) {
  closeTextEditor(true);   // commit/close any open editor first

  const canvas = annoCanvasFor(n);
  const wrap = canvas && canvas.closest('.page-wrap');
  if (!wrap) return;

  const key = songKeyForPage(n);
  // If editing an existing note, pull it out of the array while editing (so the
  // live canvas text doesn't double up with the textarea). Keep the original so
  // a cancel can restore it untouched.
  let editIndex = -1;
  if (existing) {
    const arr = annotations[key] || [];
    editIndex = arr.indexOf(existing);
    if (editIndex >= 0) { arr.splice(editIndex, 1); redrawAnnotations(n); }
    fx = existing.x; fy = existing.y;
  }

  const pageW = parseFloat(canvas.style.width) || wrap.clientWidth;
  const pageH = parseFloat(canvas.style.height) || wrap.clientHeight;
  const color = existing ? existing.color : penColor;
  const size = existing ? (existing.size || TEXT_DEFAULT_SIZE) : TEXT_DEFAULT_SIZE;
  const fontPx = size * pageH;

  const ta = document.createElement('textarea');
  ta.className = 'text-note-input';
  ta.value = existing ? existing.text : '';
  ta.rows = 1;
  ta.style.left = `${fx * pageW}px`;
  ta.style.top = `${fy * pageH}px`;
  ta.style.color = color;
  ta.style.font = `${fontPx}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ta.style.lineHeight = '1.25';
  wrap.appendChild(ta);

  textEditor = { ta, n, key, fx, fy, color, size, editIndex, original: existing || null };

  // Auto-grow to fit content.
  const autosize = () => {
    ta.style.width = 'auto';
    ta.style.height = 'auto';
    ta.style.width = `${Math.max(ta.scrollWidth + 4, fontPx)}px`;
    ta.style.height = `${ta.scrollHeight}px`;
  };
  ta.addEventListener('input', autosize);
  autosize();

  // Commit on Enter (Shift+Enter = newline), cancel on Escape.
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeTextEditor(true); }
    else if (e.key === 'Escape') { e.preventDefault(); closeTextEditor(false); }
    e.stopPropagation();   // don't let page shortcuts fire while typing
  });

  // Commit when focus really leaves the editor — but IGNORE the transient blur
  // that fires while the soft keyboard is animating in on mobile (the WebView
  // briefly shuffles focus). We only honour a blur once the editor has settled
  // AND focus didn't bounce straight back to the textarea.
  let settled = false;
  const settleTimer = setTimeout(() => { settled = true; }, 400);
  ta.addEventListener('blur', () => {
    setTimeout(() => {
      // Focus returned to the same textarea (keyboard bounce) => not a real blur.
      if (document.activeElement === ta) return;
      if (!settled) { ta.focus(); return; }   // keyboard still opening; keep it
      closeTextEditor(true);
    }, 0);
  });
  textEditor.settleCleanup = () => clearTimeout(settleTimer);

  // Focus after layout so mobile keyboards open reliably.
  setTimeout(() => { ta.focus(); ta.select(); }, 0);
}

// Close the editor. commit=true bakes non-empty text into an annotation item.
function closeTextEditor(commit) {
  if (!textEditor) return;
  const ed = textEditor;
  textEditor = null;                 // clear first so blur handler is a no-op
  if (ed.settleCleanup) ed.settleCleanup();
  const text = ed.ta.value.replace(/\s+$/,'').trimStart();
  ed.ta.remove();

  const canvas = annoCanvasFor(ed.n);
  if (!annotations[ed.key]) annotations[ed.key] = [];
  const arr = annotations[ed.key];

  if (commit && text) {
    // Measure the note so hit-testing/erase have a bounding box (in fractions).
    let w = 0, h = 0;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      const m = textNoteMetrics(ctx, { text, size: ed.size }, canvas.width, canvas.height);
      w = m.width / canvas.width;
      h = m.height / canvas.height;
    }
    const item = { type: 'text', x: ed.fx, y: ed.fy, text, color: ed.color, size: ed.size, w, h };
    if (ed.editIndex >= 0) {
      // Editing an existing note: put the new version back in its place. Undo
      // restores the ORIGINAL note (stored on the action) at that index.
      arr.splice(ed.editIndex, 0, item);
      pushUndo({ type: 'edit', key: ed.key, index: ed.editIndex, before: ed.original, after: item });
    } else {
      arr.push(item);
      pushUndo({ type: 'add', key: ed.key, page: ed.n, stroke: item });
    }
    scheduleSave();
  } else if (ed.editIndex >= 0) {
    if (!commit && ed.original) {
      // Cancelled an edit: restore the original note untouched, no undo entry.
      arr.splice(ed.editIndex, 0, ed.original);
    } else {
      // Committed but empty => the note was deleted. Record it as undoable.
      pushUndo({ type: 'remove', key: ed.key, index: ed.editIndex, stroke: ed.original });
      scheduleSave();
    }
  }
  if (arr.length === 0) delete annotations[ed.key];
  if (canvas) redrawAnnotations(ed.n);
}

// A registry of "abort" callbacks for any in-progress stroke, so a pinch
// gesture (second finger) can cancel drawing and take over as zoom/pan.
const activeStrokeAborts = new Set();
function abortActiveStrokes() {
  for (const abort of [...activeStrokeAborts]) abort();
}

// How long the pointer must dwell (nearly motionless) at the end of a stroke
// before it snaps to a straight line, and how far it may drift during that
// dwell while still counting as "held still" (in canvas fractions).
const STRAIGHTEN_HOLD_MS = 900;
const STRAIGHTEN_JITTER = 0.006;   // ~ a few px; movement under this = "still"
// With the eraser: a stroke that travels less than this (in fractions of the
// page) counts as a TAP and removes the whole stroke under it, rather than
// pixel-erasing. A longer drag pixel-erases as before.
const ERASER_TAP_MAX_MOVE = 0.02;
// Extra pick radius (fraction of page) so thin strokes are still easy to tap.
const STROKE_PICK_SLACK = 0.012;
// If the drawn stroke's overall angle is within this many degrees of an axis,
// snap it to a perfectly horizontal or vertical line.
const AXIS_SNAP_DEGREES = 12;

// Detect the "eraser end" of a stylus. Pointer Events expose it in a few ways
// depending on the platform/WebView:
//   - some report pointerType === 'eraser' outright;
//   - most report pointerType === 'pen' with the eraser BUTTON bit set:
//       e.buttons has bit 5 (value 32) held, or the down/up event's e.button
//       equals 5 (the "eraser" button code).
// Any of these means the user flipped the pen over to erase.
function isStylusEraser(e) {
  if (e.pointerType === 'eraser') return true;
  if (e.pointerType !== 'pen') return false;
  if ((e.buttons & 32) === 32) return true;   // eraser held during move
  if (e.button === 5) return true;            // eraser reported on down/up
  return false;
}

// True if a stroke's points stayed within the tap threshold of the start — i.e.
// the user tapped rather than dragged. Used to distinguish an eraser tap
// (remove whole stroke) from an eraser drag (pixel erase).
function isTap(points) {
  if (!points || points.length === 0) return true;
  const a = points[0];
  for (const p of points) {
    if (Math.hypot(p.x - a.x, p.y - a.y) > ERASER_TAP_MAX_MOVE) return false;
  }
  return true;
}

// Produce the straightened version of a freehand stroke: a two-point segment
// from its first to its last point, snapped to horizontal/vertical when the
// overall angle is close to an axis.
function straightenPoints(points) {
  if (!points || points.length < 2) return points;
  const a = points[0];
  const b = points[points.length - 1];
  let x0 = a.x, y0 = a.y, x1 = b.x, y1 = b.y;

  const dx = x1 - x0;
  const dy = y1 - y0;
  const angle = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI); // 0..180
  const nearHorizontal = angle <= AXIS_SNAP_DEGREES || angle >= 180 - AXIS_SNAP_DEGREES;
  const nearVertical = Math.abs(angle - 90) <= AXIS_SNAP_DEGREES;

  if (nearHorizontal) {
    const y = (y0 + y1) / 2;   // level it out
    y0 = y1 = y;
  } else if (nearVertical) {
    const x = (x0 + x1) / 2;
    x0 = x1 = x;
  }
  // Preserve pressure of the endpoints so ink width stays sensible.
  return [{ x: x0, y: y0, pr: a.pr || 0 }, { x: x1, y: y1, pr: b.pr || 0 }];
}

// Attach pointer drawing handlers to an overlay canvas.
function attachDrawing(canvas, n) {
  let active = false;
  let stroke = null;
  let activePointerId = null;
  // "Hold at the end to straighten" state.
  let holdTimer = null;
  let holdAnchor = null;       // pointer position when the dwell started
  let straightened = false;    // has the current stroke been snapped?
  let freehandPoints = null;   // original points, so a later move can revert
  // Text tool: a pending placement that only commits on pointerup IF it stayed
  // a single, still tap (not a drag, and no pinch/second finger).
  let textPending = null;      // { id, startClientX, startClientY, moved }

  function clearHold() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    holdAnchor = null;
  }

  // Called when the pointer has dwelt in place long enough: snap the stroke.
  function applyStraighten() {
    holdTimer = null;
    if (!active || !stroke || stroke.erase) return;
    if (!stroke.points || stroke.points.length < 2) return;
    freehandPoints = stroke.points;        // remember for possible revert
    stroke.points = straightenPoints(stroke.points);
    stroke.straight = true;                // render as a clean 2-point segment
    straightened = true;
    redrawAnnotations(n, stroke);
    // A light haptic nudge on devices that support it.
    try { if (navigator.vibrate) navigator.vibrate(15); } catch { /* ignore */ }
  }

  function toFrac(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top) / r.height,
      pr: (e.pointerType === 'pen' && e.pressure > 0) ? e.pressure : 0
    };
  }

  // Cancel the in-progress stroke without committing it (used when a pinch
  // gesture starts mid-stroke).
  function abort() {
    if (!active) return;
    active = false;
    stroke = null;
    clearHold();
    straightened = false;
    freehandPoints = null;
    activeStrokeAborts.delete(abort);
    try { if (activePointerId != null) canvas.releasePointerCapture(activePointerId); } catch { /* ignore */ }
    activePointerId = null;
    drawTools.classList.remove('drawing-active');
    redrawAnnotations(n);   // wipe the discarded live stroke
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!drawMode) return;
    // A pinch (2+ touch points) owns the gesture — never start a stroke.
    if (pinchActive || activeTouches.size >= 2) return;

    // Text tool: a press places (or edits) a text note rather than drawing.
    // Flipping the stylus to its eraser end erases regardless of the current
    // tool (pen / highlighter / text).
    const stylusErase = isStylusEraser(e);
    const erasing = eraserOn || stylusErase;

    if (tool === 'text' && !erasing) {
      e.preventDefault();
      lastFocusedPage = n;
      if (e.pointerType === 'touch') activeTouches.set(e.pointerId, e);
      const p = toFrac(e);
      const key = songKeyForPage(n);
      // Is there an existing note under the press? If so, a still tap will
      // EDIT it and a drag will MOVE it. On empty space, a still tap places a
      // new note. Nothing commits until pointerup (so pinch/pan never place).
      const hit = hitTestStroke(key, p.x, p.y, STROKE_PICK_SLACK);
      const existing = (hit >= 0 && annotations[key][hit] && annotations[key][hit].type === 'text')
        ? annotations[key][hit] : null;
      textPending = {
        id: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        moved: false,
        key,
        existing,
        existingIndex: existing ? hit : -1,
        // The grab offset: where inside the note we grabbed, so dragging keeps
        // that point under the finger instead of snapping the corner to it.
        grabDX: existing ? p.x - existing.x : 0,
        grabDY: existing ? p.y - existing.y : 0,
        dragging: false,
      };
      return;
    }

    if (e.pointerType === 'touch') activeTouches.set(e.pointerId, e);
    e.preventDefault();
    lastFocusedPage = n;   // remember which page was last interacted with
    active = true;
    activePointerId = e.pointerId;
    activeStrokeAborts.add(abort);
    canvas.setPointerCapture(e.pointerId);
    hideColorPopover();               // close the color panel when drawing starts
    drawTools.classList.add('drawing-active');  // fade tools out of the way
    straightened = false;
    freehandPoints = null;
    clearHold();
    stroke = {
      tool: 'pen',                     // erase & pen both use the round trace
      color: penColor,
      // The stylus eraser uses a comfortable fixed nib; the on-screen eraser
      // and pens use the current pen width.
      width: (stylusErase ? 24 : penWidth) / ((parseFloat(canvas.style.width) || 1) * zoom),
      opacity: penOpacity,
      erase: erasing,
      points: [toFrac(e)]
    };
    if (!erasing) stroke.tool = tool;  // keep highlighter/pen rendering when drawing
  });

  canvas.addEventListener('pointermove', (e) => {
    // Text tool: track whether the pending tap turned into a drag, and keep the
    // shared touch map current so pinch detection works.
    if (textPending) {
      if (e.pointerType === 'touch' && activeTouches.has(e.pointerId)) {
        activeTouches.set(e.pointerId, e);
      }
      if (e.pointerId === textPending.id) {
        const dx = e.clientX - textPending.startClientX;
        const dy = e.clientY - textPending.startClientY;
        // ~10px of travel = a drag, not a tap.
        if (Math.hypot(dx, dy) > 10) textPending.moved = true;

        // Dragging an existing note MOVES it. A second finger (pinch) is never
        // a drag, so bail out of moving if one arrived.
        if (textPending.moved && textPending.existing && activeTouches.size <= 1 && !pinchActive) {
          if (!textPending.dragging) {
            // Lift the note out of the array so it renders as the live layer.
            textPending.dragging = true;
            const arr = annotations[textPending.key];
            const idx = arr ? arr.indexOf(textPending.existing) : -1;
            if (idx >= 0) arr.splice(idx, 1);
          }
          const p = toFrac(e);
          // Keep the grabbed point under the finger; clamp inside the page.
          const nx = Math.min(1, Math.max(0, p.x - textPending.grabDX));
          const ny = Math.min(1, Math.max(0, p.y - textPending.grabDY));
          const live = { ...textPending.existing, x: nx, y: ny };
          textPending.liveItem = live;
          redrawAnnotations(n, live);   // draw the page + the note at its new spot
        }
      }
      return;
    }

    if (!active || !stroke) return;
    e.preventDefault();
    const p = toFrac(e);

    if (straightened) {
      // Already snapped to a straight line. A tiny wobble is ignored so the
      // line stays put; a deliberate move reverts to the original freehand
      // stroke (so an accidental pause doesn't trap the user).
      const moved = Math.hypot(p.x - holdAnchor.x, p.y - holdAnchor.y);
      if (moved > STRAIGHTEN_JITTER * 4) {
        stroke.points = freehandPoints;
        stroke.straight = false;
        straightened = false;
        freehandPoints = null;
      } else {
        return;   // hold the straight line steady
      }
    }

    stroke.points.push(p);

    // Restart the dwell timer whenever the pointer moves more than a hair; if
    // it stays put, the timer survives and eventually straightens the stroke.
    if (!stroke.erase && stroke.points.length >= 2) {
      if (!holdAnchor || Math.hypot(p.x - holdAnchor.x, p.y - holdAnchor.y) > STRAIGHTEN_JITTER) {
        holdAnchor = p;
        if (holdTimer) clearTimeout(holdTimer);
        holdTimer = setTimeout(applyStraighten, STRAIGHTEN_HOLD_MS);
      }
    }

    // Redraw the page with the in-progress stroke composited uniformly, so a
    // translucent stroke shows even opacity while being drawn.
    redrawAnnotations(n, stroke);
  });

  function finish(e) {
    // Text tool: resolve the pending gesture — a MOVE (dragged a note), an EDIT
    // (tapped a note), a PLACE (tapped empty space), or nothing (pan/zoom).
    if (textPending && e && e.pointerId === textPending.id) {
      const pend = textPending;
      textPending = null;
      if (e.pointerType === 'touch') activeTouches.delete(e.pointerId);

      // A note was dragged: drop it at the new position (undoable move).
      if (pend.dragging && pend.existing) {
        const arr = annotations[pend.key] || (annotations[pend.key] = []);
        const idx = Math.min(pend.existingIndex, arr.length);
        if (e.type === 'pointerup' && pend.liveItem) {
          const moved = { ...pend.existing, x: pend.liveItem.x, y: pend.liveItem.y };
          arr.splice(idx, 0, moved);
          pushUndo({ type: 'edit', key: pend.key, index: idx, before: pend.existing, after: moved });
          scheduleSave();
        } else {
          // Cancelled mid-drag: put the note back untouched.
          arr.splice(idx, 0, pend.existing);
        }
        redrawAnnotations(n);
        return;
      }

      // A still tap (no drag, no pinch): edit an existing note or place a new
      // one. A drag over empty space was a pan — place nothing.
      const wasTap = !pend.moved && !pinchActive && activeTouches.size <= 1;
      if (e.type === 'pointerup' && wasTap) {
        const p = toFrac(e);
        openTextEditor(n, p.x, p.y, pend.existing);
      }
      return;
    }

    if (e && e.pointerType === 'touch') activeTouches.delete(e.pointerId);
    drawTools.classList.remove('drawing-active');  // tools reappear
    clearHold();
    straightened = false;
    freehandPoints = null;
    if (!active || !stroke) return;
    active = false;
    activeStrokeAborts.delete(abort);
    activePointerId = null;
    const key = songKeyForPage(n);

    // Eraser TAP (barely moved): remove the whole stroke under the point
    // instead of committing a pixel-erase stroke. A drag falls through to the
    // normal pixel eraser below.
    if (stroke.erase && isTap(stroke.points)) {
      const p = stroke.points[0];
      const hit = hitTestStroke(key, p.x, p.y, STROKE_PICK_SLACK);
      stroke = null;
      if (hit >= 0) removeStrokeAt(key, hit, n);
      else redrawAnnotations(n);   // nothing hit: just clear the tap dab
      return;
    }

    if (!annotations[key]) annotations[key] = [];
    annotations[key].push(stroke);
    pushUndo({ type: 'add', key, page: n, stroke });
    stroke = null;
    redrawAnnotations(n);   // clean composite (esp. for eraser)
    scheduleSave();
  }
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
}

// Build the filmstrip: a slot per page, each slotWidth wide, no gaps.
// We render the visible window plus one buffer page each side for smooth slides.
async function ensureWindowRendered(token) {
  const total = pdfDoc.numPages;
  const first = Math.max(1, currentPage - FULL_BUFFER);
  const last = Math.min(total, currentPage + viewCount - 1 + FULL_BUFFER);

  track.style.width = `${slotWidth * total}px`;

  // 1) Create slots and immediately show the best tier available (thumb or
  //    full). This guarantees no blank pages, even while scrubbing fast.
  for (let n = first; n <= last; n++) {
    let slot = track.querySelector(`.slot[data-slot="${n}"]`);
    if (!slot) {
      slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.slot = String(n);
      slot.style.width = `${slotWidth}px`;
      slot.style.left = `${slotWidth * (n - 1)}px`;
      track.appendChild(slot);
    }
    if (!slot.firstChild) {
      const best = bestCanvasFor(n);
      if (best) mountPage(slot, n, best);
    }
  }

  alignPair();

  // Drop DOM slots far outside the visible window to keep the DOM light. The
  // in-memory canvas LRU manages its own eviction, so we don't touch it here.
  track.querySelectorAll('.slot').forEach((slot) => {
    const n = Number(slot.dataset.slot);
    if (n < first || n > last) slot.remove();
  });

  // 2) Render the buffered range (nearest first): from RAM if present, else a
  //    fast disk read, else PDF.js. Swap each into its slot when ready.
  const nearestFirst = [];
  for (let d = 0; d <= FULL_BUFFER + viewCount; d++) {
    if (currentPage + d <= last) nearestFirst.push(currentPage + d);
    if (d > 0 && currentPage - d >= first) nearestFirst.push(currentPage - d);
  }
  (async () => {
    for (const n of nearestFirst) {
      if (token !== renderToken) return;
      // Visible pages (currently on screen) get the full device DPR for maximum
      // sharpness. Buffer pages use the standard RENDER_DPR to keep memory and
      // disk cache bounded.
      const isVisible = n >= currentPage && n < currentPage + viewCount;
      const pageDpr = isVisible ? DPR : RENDER_DPR;
      const inMem = cacheGet(n);
      if (inMem) {
        const cachedDpr = Number(inMem.dataset.renderDpr) || RENDER_DPR;
        if (cachedDpr >= pageDpr - 0.01) { fillSlotIfEmpty(n); continue; }
        // Cached at lower DPR — fall through to re-render at higher quality.
      }
      const canvas = await renderFull(n, token, pageDpr);
      if (token !== renderToken) return;
      if (canvas) {
        const slot = track.querySelector(`.slot[data-slot="${n}"]`);
        if (slot) { mountPage(slot, n, canvas); alignPair(); }
      }
    }
  })();
}

// Make the two currently-visible pages meet flush at the center seam.
// Left page of the pair hugs the right edge of its slot; right page hugs the
// left edge of its slot. Every other slot centers its page.
function alignPair() {
  track.querySelectorAll('.slot').forEach((slot) => {
    const n = Number(slot.dataset.slot);
    if (viewCount > 1 && n === currentPage) {
      slot.style.justifyContent = 'flex-end';   // left page -> right edge
    } else if (viewCount > 1 && n === currentPage + 1) {
      slot.style.justifyContent = 'flex-start';  // right page -> left edge
    } else {
      slot.style.justifyContent = 'center';
    }
  });
}

// ---------- Zoom / pan ----------
// The filmstrip is paginated by translating #pages horizontally. Zoom adds a
// scale plus a pan offset (in viewport pixels) on TOP of that pagination
// offset. Everything is composed into one transform so the pager and the zoom
// never fight over the same property.
//
//   transform = translate(panX + baseX*zoom, panY) scale(zoom)
//
// where baseX = -slotWidth*(currentPage-1) is the pagination offset. Scaling
// about the origin (top-left) keeps the math simple; panX/panY carry the
// visual position and are clamped so the pages can't be dragged off-screen.
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
let zoom = 1;
let panX = 0;                  // extra x translation in viewport px (post-scale origin)
let panY = 0;                  // extra y translation in viewport px
let zoomAnimating = false;

function isZoomed() { return zoom > 1.001; }

// Clamp the pan so the scaled content can't be dragged past the viewport edges.
//
// The visible page region (the current page, or page pair in landscape) spans
// local x [slotWidth*(cp-1), slotWidth*(cp-1+viewCount)] — a total width of
// slotWidth*viewCount = viewW. After scaling by `zoom` about the origin and
// applying the composed translate, that region occupies screen x
// [panX, panX + zoom*viewW]. To keep it covering the viewport [0, viewW]:
//     panX ∈ [-(zoom-1)*viewW, 0]
// The vertical case is analogous. This lets the zoomed page pan freely to
// reveal any edge (so zoom-at-cursor lands where you point) without exposing
// blank margins.
function clampPan() {
  const viewW = viewer.clientWidth;
  const vH = Math.max(1, viewer.clientHeight);   // reading region = full height

  // Horizontal: bound panX to the ACTUAL page edges too (the page may be
  // centred within its slot if it's narrower than the slot, and that gap scales
  // with zoom just like the vertical one).
  const pageW = viewCount === 1 ? currentPageWidth() : 0;
  if (pageW) {
    // Screen x of the page's left edge when panX = 0: the slot offset (baseX)
    // cancels in positionTrack, leaving only the centring gap, scaled by zoom.
    const leftAtZero = ((slotWidth - pageW) / 2) * zoom;
    const scaledW = pageW * zoom;
    if (scaledW <= viewW) {
      panX = (viewW - scaledW) / 2 - leftAtZero;
    } else {
      const maxPanX = -leftAtZero;
      const minPanX = viewW - (leftAtZero + scaledW);
      if (panX > maxPanX) panX = maxPanX;
      if (panX < minPanX) panX = minPanX;
    }
  } else {
    const rangeX = Math.max(0, (zoom - 1) * viewW);
    if (panX > 0) panX = 0;
    if (panX < -rangeX) panX = -rangeX;
  }

  // Vertical is trickier: pages are centred by flexbox INSIDE #pages, and that
  // centring gap is scaled by the zoom transform too. So we can't assume the
  // page top is at the origin. Compute the page's unscaled top within #pages
  // (slot is full viewer height, page centred in it), then bound panY so the
  // ACTUAL page edges stay against the viewport — this stops you from zooming
  // into the (growing) blank margin above/below the page.
  const pageH = currentPageHeight();
  if (!pageH) return;                     // page not mounted yet; leave pan as-is
  const pageTopLocal = (vH - pageH) / 2;   // unscaled offset
  const topAtZero = pageTopLocal * zoom;                  // screen y of page top when panY=0
  const scaledH = pageH * zoom;

  if (scaledH <= vH) {
    // Page fits within the region: pin it centred, no vertical pan/margin.
    panY = (vH - scaledH) / 2 - topAtZero;
  } else {
    // Page overflows: allow panning between top edge at 0 and bottom edge at vH.
    const maxPanY = -topAtZero;                    // page top flush with region top
    const minPanY = vH - (topAtZero + scaledH);    // page bottom flush with region bottom
    if (panY > maxPanY) panY = maxPanY;
    if (panY < minPanY) panY = minPanY;
  }
}

// Rendered CSS height (px) of the current page's canvas, if mounted.
function currentPageHeight() {
  const c = track.querySelector(`.slot[data-slot="${currentPage}"] .page-canvas`);
  if (c && c.style.height) return parseFloat(c.style.height);
  return 0;
}
// Rendered CSS width (px) of the current page's canvas, if mounted.
function currentPageWidth() {
  const c = track.querySelector(`.slot[data-slot="${currentPage}"] .page-canvas`);
  if (c && c.style.width) return parseFloat(c.style.width);
  return 0;
}

// Position the filmstrip: pagination offset composed with zoom scale + pan.
function positionTrack(animate) {
  track.style.transition = (animate && !zoomAnimating) ? 'transform 0.28s ease' : 'none';
  const baseX = -slotWidth * (currentPage - 1);
  clampPan();
  track.style.transformOrigin = '0 0';
  track.style.transform =
    `translate(${panX + baseX * zoom}px, ${panY}px) scale(${zoom})`;
}

// Apply a new zoom level, keeping the given viewport point visually fixed
// (anchorX/anchorY are client coords relative to the viewer's top-left).
//
// The anchor math reads the LIVE on-screen rect of #pages rather than assuming
// how pages are centred, so it stays correct regardless of the flexbox
// centring offset.
function setZoom(newZoom, anchorX, anchorY, animate = false) {
  newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));

  // Measure where the anchored content sits right now (before any change).
  const viewRect = viewer.getBoundingClientRect();
  if (anchorX == null) anchorX = viewer.clientWidth / 2;
  if (anchorY == null) anchorY = viewer.clientHeight / 2;
  const clientAX = viewRect.left + anchorX;   // anchor in page/client coords
  const clientAY = viewRect.top + anchorY;
  const before = track.getBoundingClientRect();
  // Fraction of the current #pages box that lies under the anchor.
  const fracX = before.width ? (clientAX - before.left) / before.width : 0;
  const fracY = before.height ? (clientAY - before.top) / before.height : 0;

  const wasZoomed = isZoomed();
  zoom = newZoom;
  const nowZoomed = isZoomed();

  // If the zoomed state flips, reflect it in the UI (zoom-out button + scrubber
  // visibility). The viewer height is fixed, so this doesn't move the page.
  if (wasZoomed !== nowZoomed) {
    updateZoomUi();
  }

  if (!nowZoomed) {
    // Back to fit: let the layout centre the page, no pan.
    panX = 0; panY = 0;
    zoomAnimating = animate;
    positionTrack(animate);
    zoomAnimating = false;
    return;
  }

  // Position so the same content fraction stays under the anchor. First set a
  // provisional transform (no extra pan) to learn the box at the new zoom,
  // then nudge pan by the anchor error.
  zoomAnimating = animate;
  positionTrack(false);
  const after = track.getBoundingClientRect();
  const desiredX = clientAX;
  const desiredY = clientAY;
  const actualX = after.left + fracX * after.width;
  const actualY = after.top + fracY * after.height;
  panX += desiredX - actualX;
  panY += desiredY - actualY;
  positionTrack(animate);
  zoomAnimating = false;
  updateZoomUi();
}

// Reset to fit (used on page change, reload, resize).
function resetZoom(animate = false) {
  zoom = 1; panX = 0; panY = 0;
  updateZoomUi();
  positionTrack(animate);
}

// Reflect the zoom state on the body (for CSS) and the zoom-out button, which
// only appears while zoomed in. The scrubber hides while zoomed so it never
// overlaps zoomed content, and returns at fit unless the user manually hid the
// chrome. The viewer height is fixed, so these toggles never move the page.
function updateZoomUi() {
  const zoomed = isZoomed();
  document.body.classList.toggle('zoomed', zoomed);
  if (zoomOutBtn) zoomOutBtn.classList.toggle('hidden', !zoomed);
  scrubber.classList.toggle('hidden-bar', zoomed || chromeHidden);
}

// ---------- Navigation (shift by ONE page) ----------
async function goToPage(n, animate = true) {
  if (!pdfDoc) return;
  const total = pdfDoc.numPages;
  const maxStart = Math.max(1, total - viewCount + 1);
  n = Math.min(maxStart, Math.max(1, n));
  if (n === currentPage) return;
  currentPage = n;
  // Flipping to a different page resets any zoom so each page starts at fit.
  if (isZoomed()) resetZoom(false);
  await ensureWindowRendered(renderToken);
  positionTrack(animate);
  if (!isScrubbing) updateScrubber();
}

function next() { goToPage(currentPage + 1); }      // one page leaves, one enters
function prev() { goToPage(currentPage - 1); }

// ---------- Scrubber ----------
function updateScrubber() {
  if (!pdfDoc) return;
  const total = pdfDoc.numPages;
  const pct = total <= 1 ? 0 : (currentPage - 1) / (total - 1);
  const trackW = scrubTrack.clientWidth;
  scrubFill.style.width = `${pct * 100}%`;
  scrubThumb.style.left = `${pct * trackW}px`;
}

function pageFromClientX(clientX) {
  const rect = scrubTrack.getBoundingClientRect();
  let pct = (clientX - rect.left) / rect.width;
  pct = Math.min(1, Math.max(0, pct));
  const total = pdfDoc.numPages;
  return Math.round(pct * (total - 1)) + 1;
}

function positionThumbAt(pct) {
  const trackW = scrubTrack.clientWidth;
  scrubFill.style.width = `${pct * 100}%`;
  scrubThumb.style.left = `${pct * trackW}px`;
}

// Position and fill the song-number bubble above the thumb while scrubbing.
// It's clamped to stay within the track so it never runs off either edge.
function updateScrubBubble(page, pct) {
  if (!scrubBubble) return;
  const num = songNumberForPage(page);
  // Only show the bubble when we have a real song number. Front matter / table
  // of contents pages (no number) show nothing.
  if (!num) { scrubBubble.classList.add('hidden'); return; }
  scrubBubble.textContent = num;
  scrubBubble.classList.remove('hidden');
  const trackW = scrubTrack.clientWidth;
  const x = Math.min(trackW, Math.max(0, pct * trackW));
  scrubBubble.style.left = `${x}px`;
}

function hideScrubBubble() { if (scrubBubble) scrubBubble.classList.add('hidden'); }

// ---------- Scrubber fast-preview + quality-settle ----------
// While dragging, render a tiny thumbnail of each scrub position (fast,
// no disk I/O, no cache writes) so page content is visible immediately even
// when flicking across hundreds of pages. When the thumb stops moving, a
// settle timer fires the normal full-quality render.

let scrubThumbToken = 0;    // cancels any in-flight thumbnail render
let scrubSettleTimer = null;

// Render the top 11% strip of a page at full width/scale for instant scrub
// preview. This is enough to show the song number and title, and is very fast
// because pdf.js only processes text/vectors in that tiny region.
// Returns { canvas, fullCssW, fullCssH } or null if cancelled.
async function renderThumb(n, token) {
  const STRIP = 0.11;           // fraction of page height to render
  try {
    const page = await pdfDoc.getPage(n);
    if (token !== scrubThumbToken) return null;

    const vp = page.getViewport({ scale: docFitScale });
    const fullCssW = Math.floor(vp.width);
    const fullCssH = Math.floor(vp.height);

    // Canvas is full width but only STRIP fraction of the full height.
    // Rendering into a short canvas automatically clips to that region —
    // pdf.js only rasterises what fits, so this is much faster than a full
    // page render even at the same scale.
    const stripH = Math.max(1, Math.floor(vp.height * STRIP * RENDER_DPR));
    const stripCssH = Math.max(1, Math.floor(vp.height * STRIP));

    const canvas = document.createElement('canvas');
    canvas.className = 'page-canvas';
    canvas.dataset.page = String(n);
    canvas.dataset.tier = 'thumb';
    canvas.width = Math.floor(vp.width * RENDER_DPR);
    canvas.height = stripH;
    canvas.style.width = `${fullCssW}px`;
    canvas.style.height = `${stripCssH}px`;

    const ctx = canvas.getContext('2d');
    ctx.scale(RENDER_DPR, RENDER_DPR);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    if (token !== scrubThumbToken) return null;
    return { canvas, fullCssW, fullCssH };
  } catch {
    return null;
  }
}

// Show the top-strip thumb in the slot for page n.
// The strip sits at the top; a plain background div fills the rest of the slot
// so it doesn't look jagged — the page appears to be loading.
function showThumb(n, result) {
  const slot = track.querySelector(`.slot[data-slot="${n}"]`);
  if (!slot) return;
  // Don't replace a full-res canvas that's already showing.
  const existing = slot.querySelector('.page-canvas');
  if (existing && existing.dataset.tier === 'full') return;

  const { canvas, fullCssW, fullCssH } = result;

  slot.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'page-wrap';
  wrap.dataset.page = String(n);
  wrap.style.width = `${fullCssW}px`;
  wrap.style.height = `${fullCssH}px`;
  wrap.classList.add('page-wrap-loading');  // neutral placeholder bg (dark-aware)

  // Top strip (rendered content with title).
  canvas.style.display = 'block';
  wrap.appendChild(canvas);

  // Annotation overlay covering the full page area.
  const anno = document.createElement('canvas');
  anno.className = 'anno-canvas';
  anno.dataset.page = String(n);
  anno.width = Math.floor(fullCssW * DPR);
  anno.height = Math.floor(fullCssH * DPR);
  anno.style.width = `${fullCssW}px`;
  anno.style.height = `${fullCssH}px`;
  wrap.appendChild(anno);
  slot.appendChild(wrap);
}

function handleScrub(clientX) {
  if (!pdfDoc) return;
  const page = pageFromClientX(clientX);
  const total = pdfDoc.numPages;
  const pct = total <= 1 ? 0 : (page - 1) / (total - 1);
  positionThumbAt(pct);
  updateScrubBubble(page, pct);

  if (page === currentPage) return;
  currentPage = page;
  clampCurrentPage();
  positionTrack(false);

  // Cancel any previous in-flight thumbnail and start a new one.
  scrubThumbToken++;
  const token = scrubThumbToken;
  (async () => {
    // Ensure the slot exists for this page (and viewCount partner if landscape).
    for (let i = 0; i < viewCount; i++) {
      const n = currentPage + i;
      if (n < 1 || n > total) continue;
      let slot = track.querySelector(`.slot[data-slot="${n}"]`);
      if (!slot) {
        slot = document.createElement('div');
        slot.className = 'slot';
        slot.dataset.slot = String(n);
        slot.style.width = `${slotWidth}px`;
        slot.style.left = `${slotWidth * (n - 1)}px`;
        track.appendChild(slot);
      }
      // If a full-res canvas is already cached for this page, use it directly.
      const inMem = cacheGet(n);
      if (inMem) { mountPage(slot, n, inMem); continue; }
      // Otherwise render a quick thumbnail.
      const thumb = await renderThumb(n, token);
      if (token !== scrubThumbToken) return;
      if (thumb) showThumb(n, thumb);
    }
    alignPair();
    // Keep the DOM light: remove slots more than FULL_BUFFER pages from view.
    const keepLo = currentPage - FULL_BUFFER;
    const keepHi = currentPage + viewCount - 1 + FULL_BUFFER;
    track.querySelectorAll('.slot').forEach(slot => {
      const n = Number(slot.dataset.slot);
      if (n < keepLo || n > keepHi) slot.remove();
    });
  })();

  // Settle timer: after the scrubber hasn't moved for 200 ms, load full quality.
  clearTimeout(scrubSettleTimer);
  scrubSettleTimer = setTimeout(() => {
    if (isScrubbing) return;   // still dragging — endScrub will trigger it
    triggerQualitySettle();
  }, 200);
}

// Full-quality render for the page we landed on. Called both from the settle
// timer (if thumb appears mid-drag) and from endScrub.
function triggerQualitySettle() {
  clearTimeout(scrubSettleTimer);
  scrubSettleTimer = null;
  renderToken++;
  const token = renderToken;
  ensureWindowRendered(token).then(() => {
    if (token !== renderToken) return;
    positionTrack(false);
    updateScrubber();
  });
}

scrubTrack.addEventListener('pointerdown', (e) => {
  if (!pdfDoc) return;
  e.preventDefault();
  isScrubbing = true;
  scrubTrack.setPointerCapture(e.pointerId);
  scrubTrack.classList.add('grabbing');
  handleScrub(e.clientX);   // this shows/positions the bubble as needed
});
scrubTrack.addEventListener('pointermove', (e) => {
  if (isScrubbing) handleScrub(e.clientX);
});
function endScrub() {
  if (!isScrubbing) return;
  isScrubbing = false;
  scrubTrack.classList.remove('grabbing');
  hideScrubBubble();
  // Scrubber released — load full-quality pages for the landed position.
  triggerQualitySettle();
}
scrubTrack.addEventListener('pointerup', endScrub);
scrubTrack.addEventListener('pointercancel', endScrub);

// ---------- Search ----------
// Parse a cached "number · title" string into { num, title }.
function parseEntry(raw) {
  const s = (raw || '').trim();
  if (!s) return { num: '', title: '' };
  const parts = s.split('·');
  if (parts.length >= 2) {
    return { num: parts[0].trim(), title: parts.slice(1).join('·').trim() };
  }
  // No separator: if it starts with a number, split there.
  const m = s.match(/^(\d+)\s*(.*)$/);
  if (m) return { num: m[1], title: m[2].trim() };
  return { num: '', title: s };
}

// Whether the custom numpad is currently the active input method. On touch
// devices it starts on; the user can switch to the OS keyboard from the numpad.
let numpadActive = false;

function openSearch() {
  if (!pdfDoc) return;
  searchPanel.classList.remove('hidden');
  searchInput.value = '';
  searchResults.innerHTML = '';

  if (hasTouch) {
    // Touch device: show the numpad and DON'T focus the input, so the OS
    // virtual keyboard stays hidden. inputmode="none" is a belt-and-braces
    // guard in case something else focuses it.
    numpadActive = true;
    numpad.classList.remove('hidden');
    searchInput.setAttribute('inputmode', 'none');
    searchInput.blur();
  } else {
    // Desktop: behave as before — focus the field for typing.
    numpadActive = false;
    numpad.classList.add('hidden');
    searchInput.setAttribute('inputmode', 'search');
    searchInput.focus();
  }
  adjustSearchForKeyboard();
}
function closeSearch() {
  searchPanel.classList.add('hidden');
  searchResults.innerHTML = '';
  searchPanel.style.bottom = '';   // restore default position
  numpad.classList.add('hidden');
  numpadActive = false;
}

// Keep the search panel above the on-screen keyboard. When the touch keyboard
// appears, the visual viewport shrinks; we lift the panel by that amount so
// the input stays visible. Restores the default position when it hides.
function adjustSearchForKeyboard() {
  if (searchPanel.classList.contains('hidden')) return;
  const vv = window.visualViewport;
  if (!vv) return;
  // How much of the layout viewport is hidden at the bottom (keyboard height).
  const covered = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
  if (covered > 80) {
    // Sit just above the keyboard with a small gap.
    searchPanel.style.bottom = `${covered + 12}px`;
  } else {
    searchPanel.style.bottom = '';   // keyboard hidden -> default
  }
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', adjustSearchForKeyboard);
  window.visualViewport.addEventListener('scroll', adjustSearchForKeyboard);
}

function runSearch(query) {
  const q = query.trim().toLowerCase();
  searchResults.innerHTML = '';
  if (!q) return;

  const total = pdfDoc.numPages;
  const numericQuery = /^\d+$/.test(q);
  const matches = [];

  for (let n = 1; n <= total; n++) {
    const { num, title } = parseEntry(titleCache.get(n));
    const numLc = num.toLowerCase();
    const titleLc = title.toLowerCase();
    let score = -1;

    if (numericQuery) {
      // Match the song number only (never the PDF page number).
      if (numLc === q) score = 0;
      else if (numLc.startsWith(q)) score = 1;
    } else {
      if (titleLc.startsWith(q)) score = 0;
      else if (titleLc.includes(q)) score = 1;
      else if (numLc.includes(q)) score = 3;
    }

    if (score >= 0) matches.push({ n, num, title, score });
  }

  matches.sort((a, b) => (a.score - b.score) || (a.n - b.n));
  const top = matches.slice(0, 50);

  if (!top.length) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = titleCache.size < total
      ? 'Still indexing the book — try again in a moment.'
      : 'No matches.';
    searchResults.appendChild(empty);
    return;
  }

  top.forEach((m, i) => {
    const item = document.createElement('div');
    // Best match (i === 0) sits at the bottom — mark it active.
    item.className = 'search-item' + (i === 0 ? ' active' : '');
    item.dataset.page = String(m.n);
    const numEl = document.createElement('span');
    numEl.className = 'si-num';
    numEl.textContent = m.num || `p${m.n}`;
    const titleEl = document.createElement('span');
    titleEl.className = 'si-title';
    titleEl.textContent = m.title || '(untitled)';
    item.appendChild(numEl);
    item.appendChild(titleEl);
    item.addEventListener('click', () => {
      goToPage(m.n);
      closeSearch();
    });
    // Prepend so the first (best) match ends up at the visual bottom.
    searchResults.prepend(item);
  });

  // Scroll to the bottom so the best match is immediately visible.
  searchResults.scrollTop = searchResults.scrollHeight;
}

// ---------- Search button: tap to open, swipe to move sides ----------
let searchSide = 'left';
try {
  const saved = localStorage.getItem('searchSide');
  if (saved === 'left' || saved === 'right') searchSide = saved;
} catch { /* ignore */ }

function applySearchSide() {
  scrubber.classList.toggle('search-right', searchSide === 'right');
  searchPanel.classList.toggle('dock-right', searchSide === 'right');
}
function setSearchSide(side) {
  searchSide = side;
  try { localStorage.setItem('searchSide', side); } catch { /* ignore */ }
  applySearchSide();
}
applySearchSide();

let dragStartX = 0;
let dragActive = false;
let dragMoved = false;

searchBtn.addEventListener('pointerdown', (e) => {
  dragActive = true;
  dragMoved = false;
  dragStartX = e.clientX;
  searchBtn.setPointerCapture(e.pointerId);
});
searchBtn.addEventListener('pointermove', (e) => {
  if (!dragActive) return;
  const dx = e.clientX - dragStartX;
  if (Math.abs(dx) > 6) dragMoved = true;
  if (dragMoved) {
    searchBtn.classList.add('dragging');
    searchBtn.style.transform = `translateX(${dx}px)`;
  }
});
function finishDrag(e) {
  if (!dragActive) return;
  dragActive = false;

  if (!dragMoved) {
    searchBtn.classList.remove('dragging');
    searchBtn.style.transform = '';
    // Treated as a tap: toggle the search panel.
    if (searchPanel.classList.contains('hidden')) openSearch();
    else closeSearch();
    return;
  }
  // Decide the side from the finger's release point relative to screen center.
  const releaseX = (e && typeof e.clientX === 'number') ? e.clientX : dragStartX;
  searchBtn.classList.remove('dragging');
  searchBtn.style.transform = '';
  setSearchSide(releaseX > window.innerWidth / 2 ? 'right' : 'left');
}
searchBtn.addEventListener('pointerup', finishDrag);
searchBtn.addEventListener('pointercancel', finishDrag);
searchClose.addEventListener('click', closeSearch);

// Close the search panel when tapping/clicking anywhere outside it (and not on
// the search button that opens it).
document.addEventListener('pointerdown', (e) => {
  if (searchPanel.classList.contains('hidden')) return;
  if (searchPanel.contains(e.target)) return;   // inside the panel
  if (searchBtn.contains(e.target)) return;      // the toggle button
  // Dismiss the panel and swallow this tap so it doesn't also flip a page.
  e.preventDefault();
  e.stopPropagation();
  closeSearch();
}, true);
searchInput.addEventListener('input', () => runSearch(searchInput.value));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeSearch(); return; }
  if (e.key === 'Enter') {
    // Jump to the currently highlighted result.
    const active = searchResults.querySelector('.search-item.active')
      || searchResults.querySelector('.search-item');
    if (active) { goToPage(Number(active.dataset.page)); closeSearch(); }
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const items = [...searchResults.querySelectorAll('.search-item')];
    if (!items.length) return;
    let idx = items.findIndex(el => el.classList.contains('active'));
    items.forEach(el => el.classList.remove('active'));
    // Results are ordered worst (top/index 0) → best (bottom/last index).
    // ArrowUp moves toward better matches (higher index, visually downward).
    // ArrowDown moves toward worse matches (lower index, visually upward).
    idx = e.key === 'ArrowUp'
      ? Math.min(items.length - 1, idx + 1)
      : Math.max(0, idx - 1);
    items[idx].classList.add('active');
    items[idx].scrollIntoView({ block: 'nearest' });
  }
});

// ---------- Custom numpad ----------
// Edit the search field without the OS keyboard. Keys use pointerdown +
// preventDefault so the tap never focuses the input (which would summon the OS
// keyboard) and doesn't count as a "tap outside" that closes the panel.
function numpadInput(ch) {
  searchInput.value += ch;
  runSearch(searchInput.value);
}
function numpadBackspace() {
  searchInput.value = searchInput.value.slice(0, -1);
  runSearch(searchInput.value);
}

// Digit keys (delegated across the numpad grid).
numpad.addEventListener('pointerdown', (e) => {
  const key = e.target.closest('.np-key[data-num]');
  if (!key) return;
  e.preventDefault();
  numpadInput(key.dataset.num);
});

// Backspace: tap deletes one character. (Simple, predictable — no key-repeat.)
npBackspace.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  numpadBackspace();
});

// Keyboard toggle: switch from the numpad to the OS virtual keyboard so the
// user can type letters/titles. Hides the numpad and focuses the input.
function switchToKeyboardInput() {
  numpadActive = false;
  numpad.classList.add('hidden');
  searchInput.setAttribute('inputmode', 'search');
  searchInput.focus();
  adjustSearchForKeyboard();
}
npKeyboard.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  switchToKeyboardInput();
});

// If a PHYSICAL keyboard is used while the numpad is showing (e.g. a Surface
// Pro with the keyboard still attached), seamlessly switch to typed input so
// the numpad never gets in the way. Character keys are forwarded into the field.
window.addEventListener('keydown', (e) => {
  if (!numpadActive || searchPanel.classList.contains('hidden')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;   // let shortcuts through
  if (e.key === 'Escape') { closeSearch(); return; }
  if (e.key === 'Backspace') { e.preventDefault(); numpadBackspace(); return; }
  if (e.key === 'Enter') {
    const active = searchResults.querySelector('.search-item.active')
      || searchResults.querySelector('.search-item');
    if (active) { goToPage(Number(active.dataset.page)); closeSearch(); }
    return;
  }
  // A single printable character -> switch to normal typing. Append this first
  // character ourselves (focus happens mid-event, so the field won't receive
  // it natively), then let subsequent keys type into the focused field.
  if (e.key.length === 1) {
    e.preventDefault();
    switchToKeyboardInput();
    searchInput.value += e.key;
    runSearch(searchInput.value);
  }
}, true);

// ---------- Tap / swipe navigation (touch AND mouse) ----------
// The tap-zones overlay is the top layer over the pages, so it handles both
// quick taps (prev / next / toggle chrome) and horizontal swipes (flip pages).
const TAP_MOVE_TOLERANCE = 12;   // px of movement still counts as a tap
const SWIPE_THRESHOLD = 45;      // px of horizontal travel to count as a swipe

let navPointerActive = false;
let navStartX = 0, navStartY = 0;
let navZone = null;

function zoneOf(target) {
  if (target.closest && target.closest('#tapLeft')) return 'left';
  if (target.closest && target.closest('#tapRight')) return 'right';
  return 'center';
}

tapZones.addEventListener('pointerdown', (e) => {
  if (!pdfDoc || drawMode) return;
  // While zoomed in, the tap zones don't navigate — touches pan the page and
  // are handled by the pinch/pan tracker instead.
  if (isZoomed()) { navPointerActive = false; return; }
  navPointerActive = true;
  navStartX = e.clientX;
  navStartY = e.clientY;
  navZone = zoneOf(e.target);
});

tapZones.addEventListener('pointerup', (e) => {
  // A pinch/pan gesture cancels any pending tap-zone navigation.
  if (pinchActive || panPointerActive || isZoomed()) { navPointerActive = false; return; }
  if (!navPointerActive) return;
  navPointerActive = false;
  const dx = e.clientX - navStartX;
  const dy = e.clientY - navStartY;

  // Horizontal swipe -> flip pages (swipe left = next, swipe right = prev).
  if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
    if (dx < 0) next(); else prev();
    return;
  }
  // Otherwise it's a tap: act by zone.
  if (Math.abs(dx) <= TAP_MOVE_TOLERANCE && Math.abs(dy) <= TAP_MOVE_TOLERANCE) {
    if (navZone === 'left') prev();
    else if (navZone === 'right') next();
    else toggleChrome();
  }
});
tapZones.addEventListener('pointercancel', () => { navPointerActive = false; });

// ---------- Chrome (toolbar + scrubber) show/hide ----------
let chromeHidden = false;

function setChromeHidden(hidden) {
  chromeHidden = hidden;
  cornerRightGroup.classList.toggle('hidden-bar', hidden);
  scrubber.classList.toggle('hidden-bar', hidden);
  // The viewer is always full height and the scrubber floats on top of it, so
  // showing/hiding the scrubber does NOT move the page — it simply uncovers the
  // strip it was overlapping. Nothing else to do here.
}
function toggleChrome() {
  setChromeHidden(!chromeHidden);
}
// Chrome only hides/shows when the user taps the center of the screen — it no
// longer auto-hides on its own, so the scrubber stays put on touch.

// ---------- Buttons ----------
function openPdfDialog() {
  if (window.api && typeof window.api.openDialog === 'function') {
    window.api.openDialog();
  } else {
    console.error('window.api.openDialog is unavailable (preload bridge not loaded).');
  }
}
libraryBtn.addEventListener('click', openLibrary);
document.getElementById('welcomeOpenBtn').addEventListener('click', openPdfDialog);
fullscreenBtn.addEventListener('click', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
});

// Reflect the actual fullscreen state on the icon (expand vs contract).
document.addEventListener('fullscreenchange', () => {
  document.body.classList.toggle('is-fullscreen', !!document.fullscreenElement);
});

// ---------- 3-dots menu: reveal / hide the action buttons ----------
function setMenuOpen(open) {
  cornerRightGroup.classList.toggle('menu-open', open);
}
menuToggle.addEventListener('click', () => {
  setMenuOpen(!cornerRightGroup.classList.contains('menu-open'));
});
// Tapping a menu action collapses the menu again for a tidy UI.
[libraryBtn, penBtn, themeBtn, fullscreenBtn].forEach((b) => {
  b.addEventListener('click', () => setMenuOpen(false));
});

// The soft/hardware "full screen" concept doesn't apply to the Android app
// (it's already immersive), so hide that button on mobile.
if (MOBILE && fullscreenBtn) fullscreenBtn.style.display = 'none';

// ---------- Dark theme (persisted) ----------
let darkMode = false;
try { darkMode = localStorage.getItem('darkMode') === '1'; } catch { /* ignore */ }

function applyTheme() {
  document.body.classList.toggle('dark', darkMode);
  // Icon swap (moon/sun) is handled by CSS via body.dark; keep the tooltip in
  // sync with what tapping will do.
  themeBtn.title = darkMode ? 'Switch to light mode' : 'Switch to dark mode';
}
function toggleTheme() {
  darkMode = !darkMode;
  try { localStorage.setItem('darkMode', darkMode ? '1' : '0'); } catch { /* ignore */ }
  applyTheme();
}
applyTheme();
themeBtn.addEventListener('click', toggleTheme);

// ---------- Annotation persistence + pen toolbar ----------
async function loadAnnotationsForCurrent() {
  annotations = {};
  undoStack = [];   // history is per-document
  redoStack = [];
  if (!currentPdfPath || !window.api.loadAnnotations) return;
  try {
    const data = await window.api.loadAnnotations(currentPdfPath);
    annotations = (data && typeof data === 'object') ? data : {};
  } catch {
    annotations = {};
  }
  migrateLegacyAnnotations();

  // If this book has no annotations and other books do, offer to import.
  const hasAny = Object.values(annotations).some(
    arr => Array.isArray(arr) && arr.length > 0
  );
  if (!hasAny && window.api.listAnnotatedBooks) {
    try {
      const candidates = await window.api.listAnnotatedBooks(currentPdfPath);
      // On mobile: always show the prompt so the user can import from a file,
      // even if there are no other annotated books on-device.
      // On desktop: only show when there are candidate books to copy from.
      const showForFile = MOBILE && window.api.importAnnotationsSidecar;
      if ((candidates && candidates.length > 0) || showForFile) {
        showImportPrompt(candidates || []);
      }
    } catch { /* non-fatal */ }
  }
}

// Reload annotations from disk without triggering the import-prompt check.
// Used after a successful import (copy-from-book or from-file) so the prompt
// doesn't re-appear if the result happens to be empty.
async function reloadAnnotationsQuiet() {
  if (!currentPdfPath || !window.api.loadAnnotations) return;
  try {
    const data = await window.api.loadAnnotations(currentPdfPath);
    annotations = (data && typeof data === 'object') ? data : {};
  } catch {
    annotations = {};
  }
  migrateLegacyAnnotations();
  rebuildSongKeyMap();
}

// Migrate older annotation key formats forward to the current
// "s<num>:<lang>:<offset>" scheme:
//   "5"          (bare page number)         -> "p5"
//   "s42:0"      (song, no lang)            -> "s42:en:0"
//   "s42#1:0"    (occurrence 1 = English)   -> "s42:en:0"
//   "s42#2:0"    (occurrence 2 = Russian)   -> "s42:ru:0"
// Keeps already-current keys untouched.
function migrateLegacyAnnotations() {
  const migrated = {};
  let changed = false;
  for (const [key, val] of Object.entries(annotations)) {
    let newKey = key;
    let m;
    if (/^\d+$/.test(key)) {
      newKey = `p${key}`;
    } else if ((m = key.match(/^s([^#:]+)#(\d+):(\d+)$/))) {
      newKey = `s${m[1]}:${m[2] === '2' ? 'ru' : 'en'}:${m[3]}`;
    } else if ((m = key.match(/^s([^#:]+):(\d+)$/))) {
      newKey = `s${m[1]}:en:${m[2]}`;
    }
    if (newKey !== key) changed = true;
    migrated[newKey] = val;
  }
  if (changed) annotations = migrated;
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (currentPdfPath && window.api.saveAnnotations) {
      window.api.saveAnnotations(currentPdfPath, annotations);
    }
  }, 600);
}

// ---------- Import-markups prompt ----------
// Shown when opening a book that has no annotations but other books with
// annotations exist. Lets the user pick one book to copy marks from.

let importSelectedId = null;   // id of the book the user clicked in the list

function showImportPrompt(candidates) {
  importSelectedId = null;
  importConfirmBtn.disabled = true;
  importBookList.innerHTML = '';

  // On mobile, show the "From file…" button so the user can pick a sidecar
  // JSON directly. On desktop the button stays hidden (auto-import handles it).
  const canImportFile = MOBILE && window.api.importAnnotationsSidecar;
  importFileBtn.classList.toggle('hidden', !canImportFile);

  // Update the body text depending on what options are available.
  const bodyEl = importPrompt.querySelector('.import-prompt-body');
  if (bodyEl) {
    if (candidates.length === 0 && canImportFile) {
      bodyEl.textContent = 'This book has no markups yet. If you have a markups file (.annotations.json), you can import it now.';
    } else {
      bodyEl.textContent = 'This book has no markups yet. Import from a previous book?';
    }
  }

  for (const { id, displayName } of candidates) {
    const item = document.createElement('div');
    item.className = 'import-book-item';
    item.dataset.id = id;

    const radio = document.createElement('div');
    radio.className = 'import-book-radio';

    const label = document.createElement('span');
    label.className = 'import-book-name';
    label.textContent = displayName;

    item.appendChild(radio);
    item.appendChild(label);
    item.addEventListener('click', () => {
      importBookList.querySelectorAll('.import-book-item')
        .forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
      importSelectedId = id;
      importConfirmBtn.disabled = false;
    });
    importBookList.appendChild(item);
  }

  importPrompt.classList.remove('hidden');
}

function hideImportPrompt() {
  importPrompt.classList.add('hidden');
  importSelectedId = null;
}

importSkipBtn.addEventListener('click', hideImportPrompt);

// "From file…" — open a JSON file picker and merge the sidecar (mobile only).
importFileBtn.addEventListener('click', async () => {
  if (!currentPdfPath || !window.api.importAnnotationsSidecar) {
    hideImportPrompt(); return;
  }
  hideImportPrompt();
  try {
    const result = await window.api.importAnnotationsSidecar(currentPdfPath);
    if (result && result.success) {
      // Reload annotations without triggering the import-prompt logic again.
      await reloadAnnotationsQuiet();
      redrawVisibleAnnotations();
    }
  } catch (err) {
    console.error('Import from file failed', err);
  }
});

importConfirmBtn.addEventListener('click', async () => {
  if (!importSelectedId || !currentPdfPath) { hideImportPrompt(); return; }
  const selectedId = importSelectedId;   // capture before hideImportPrompt resets it
  hideImportPrompt();
  try {
    await window.api.copyAnnotations(selectedId, currentPdfPath);
    // Reload annotations without triggering the import-prompt logic again.
    await reloadAnnotationsQuiet();
    redrawVisibleAnnotations();
  } catch (err) {
    console.error('Import failed', err);
  }
});

// Close on backdrop click.
importPrompt.addEventListener('click', (e) => {
  if (e.target === importPrompt) hideImportPrompt();
});

// Update the color circle to reflect current color, size and opacity.
function updateColorDot() {
  // Map pen width (1..30) to a visible dot diameter (10..34px).
  const dia = Math.round(10 + (Math.min(30, Math.max(1, penWidth)) / 30) * 24);
  colorDot.style.setProperty('--pen-color', penColor);
  colorDot.style.setProperty('--pen-opacity', String(penOpacity));
  colorDot.style.setProperty('--pen-dot', `${dia}px`);
  // Live readouts next to the sliders.
  if (penSizeVal) penSizeVal.textContent = `${penWidth}\u00A0px`;
  if (penOpacityVal) penOpacityVal.textContent = `${Math.round(penOpacity * 100)}%`;
}

function setDrawMode(on) {
  drawMode = on;
  document.body.classList.toggle('draw-mode', on);
  drawTools.classList.toggle('hidden', !on);
  penBtn.classList.toggle('active', on);
  // Entering draw mode collapses the main menu buttons behind the 3-dots.
  if (on) setMenuOpen(false);
  if (!on) { hideColorPopover(); hideEraserHint(); closeTextEditor(true); }
  updateColorDot();
}
penBtn.addEventListener('click', () => setDrawMode(!drawMode));

// ----- Tool selection (pen / highlighter / line) -----
const toolBtns = {
  pen:         document.getElementById('toolPenBtn'),
  highlighter: document.getElementById('toolHighlighterBtn'),
  text:        document.getElementById('toolTextBtn'),
};

// Switch the active drawing tool, restoring that tool's remembered color/size/
// opacity and reflecting it in the toolbar + color popover.
function setTool(next) {
  // Commit any open text note before switching tools.
  closeTextEditor(true);
  // Save the current tool's settings before switching away.
  toolState[tool] = { color: penColor, width: penWidth, opacity: penOpacity };
  tool = next;
  const ts = toolState[tool];
  penColor = ts.color;
  penWidth = ts.width;
  penOpacity = ts.opacity;

  // Picking a drawing tool always leaves eraser mode.
  eraserOn = false;
  eraserBtn.classList.remove('active');

  // Highlight the active tool button.
  for (const [name, btn] of Object.entries(toolBtns)) {
    if (btn) btn.classList.toggle('active', name === tool);
  }
  // Push the restored values into the popover controls.
  if (penSize) penSize.value = String(penWidth);
  if (penOpacityEl) penOpacityEl.value = String(Math.round(penOpacity * 100));
  syncSwatchSelection();
  updateColorDot();
}

// Mark the swatch matching the current color as selected (used after a tool
// switch changes the active color).
function syncSwatchSelection() {
  penColors.querySelectorAll('.swatch').forEach(s =>
    s.classList.toggle('active', s.dataset.color === penColor));
}

for (const [name, btn] of Object.entries(toolBtns)) {
  if (btn) btn.addEventListener('click', () => setTool(name));
}

updateColorDot();   // reflect defaults on the color circle
setTool('pen');     // establish the initial active-tool highlight

// ----- Color popover -----
function showColorPopover() { colorPopover.classList.remove('hidden'); }
function hideColorPopover() { colorPopover.classList.add('hidden'); }
colorBtn.addEventListener('click', () => {
  colorPopover.classList.toggle('hidden');
});
penColors.addEventListener('click', (e) => {
  const sw = e.target.closest('.swatch');
  if (!sw) return;
  penColor = sw.dataset.color;
  toolState[tool].color = penColor;   // remember for the active tool
  // Choosing a colour implies drawing, not erasing.
  if (eraserOn) {
    eraserOn = false;
    eraserBtn.classList.remove('active');
    if (toolBtns[tool]) toolBtns[tool].classList.add('active');
  }
  penColors.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
  sw.classList.add('active');
  updateColorDot();
});
penSize.addEventListener('input', () => {
  penWidth = Number(penSize.value);
  toolState[tool].width = penWidth;
  updateColorDot();
});
penOpacityEl.addEventListener('input', () => {
  penOpacity = Number(penOpacityEl.value) / 100;
  toolState[tool].opacity = penOpacity;
  updateColorDot();
});

// ----- Eraser: tap to toggle, press-and-hold to clear the page -----
let eraserHoldTimer = null;
let eraserHeld = false;
function showEraserHint() {
  eraserHint.classList.remove('hidden');
  clearTimeout(showEraserHint._t);
  showEraserHint._t = setTimeout(hideEraserHint, 2600);
}
function hideEraserHint() { eraserHint.classList.add('hidden'); }

eraserBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  eraserHeld = false;
  eraserHoldTimer = setTimeout(() => {
    eraserHeld = true;
    clearCurrentPage();          // hold => clear the page
    hideEraserHint();
  }, 600);
});
function eraserRelease() {
  clearTimeout(eraserHoldTimer);
  if (!eraserHeld) {
    // A tap: toggle eraser mode and explain what it does.
    eraserOn = !eraserOn;
    eraserBtn.classList.toggle('active', eraserOn);
    // While erasing, no drawing tool is active; restore the tool highlight when
    // erasing is turned back off.
    for (const [name, btn] of Object.entries(toolBtns)) {
      if (btn) btn.classList.toggle('active', !eraserOn && name === tool);
    }
    showEraserHint();
  }
  eraserHeld = false;
}
eraserBtn.addEventListener('pointerup', eraserRelease);
eraserBtn.addEventListener('pointercancel', () => { clearTimeout(eraserHoldTimer); eraserHeld = false; });

undoBtn.addEventListener('click', () => undoStroke());
redoBtn.addEventListener('click', () => redoStroke());
document.getElementById('penExitBtn').addEventListener('click', () => setDrawMode(false));

// Close the color popover when tapping elsewhere (but not the color button).
document.addEventListener('pointerdown', (e) => {
  if (colorPopover.classList.contains('hidden')) return;
  if (colorPopover.contains(e.target) || colorBtn.contains(e.target)) return;
  hideColorPopover();
}, true);

// Record a reversible action. A brand-new action invalidates the redo stack.
function pushUndo(action) {
  undoStack.push(action);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack = [];
}

// Shortest distance (in fractional units, x & y normalised to page size) from
// a point to a line segment. Used for stroke hit-testing.
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Find the topmost stroke on song key `key` that lies under fractional point
// (fx, fy). Returns its index, or -1 if nothing is close enough. Later strokes
// (drawn on top) win. `slack` is an extra pick radius in fractions so thin
// strokes are still easy to tap.
function hitTestStroke(key, fx, fy, slack) {
  const strokes = annotations[key];
  if (!strokes || !strokes.length) return -1;
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i];
    // Text notes: hit-test against the stored bounding box (in fractions),
    // padded by the slack so they're easy to tap.
    if (s.type === 'text') {
      const w = s.w || 0, h = s.h || 0;
      if (fx >= s.x - slack && fx <= s.x + w + slack &&
          fy >= s.y - slack && fy <= s.y + h + slack) return i;
      continue;
    }
    const pts = s.points;
    if (!pts || !pts.length) continue;
    // Half the stroke width plus the slack defines how near a tap must land.
    const tol = (s.width || 0.01) / 2 + slack;
    if (pts.length === 1) {
      if (Math.hypot(fx - pts[0].x, fy - pts[0].y) <= tol) return i;
      continue;
    }
    // A straightened stroke is only its two endpoints; freehand walks segments.
    if (s.straight || s.tool === 'line') {
      const a = pts[0], b = pts[pts.length - 1];
      if (distToSegment(fx, fy, a.x, a.y, b.x, b.y) <= tol) return i;
      continue;
    }
    for (let j = 1; j < pts.length; j++) {
      if (distToSegment(fx, fy, pts[j - 1].x, pts[j - 1].y, pts[j].x, pts[j].y) <= tol) return i;
    }
  }
  return -1;
}

// Remove the whole stroke at `index` on song key `key` (from a tap with the
// eraser). Recorded as an undoable action that restores the stroke in place.
function removeStrokeAt(key, index, page) {
  const strokes = annotations[key];
  if (!strokes || index < 0 || index >= strokes.length) return;
  const [removed] = strokes.splice(index, 1);
  if (strokes.length === 0) delete annotations[key];
  pushUndo({ type: 'remove', key, index, stroke: removed });
  redrawAnnotations(page);
  scheduleSave();
}

// Redraw whichever visible page currently maps to a given song key.
function redrawKeyIfVisible(key) {
  const pages = [currentPage];
  if (viewCount > 1) pages.push(currentPage + 1);
  for (const n of pages) {
    if (songKeyForPage(n) === key) redrawAnnotations(n);
  }
}

// Undo the most recent action: reverses a stroke add OR a page clear, and
// pushes the reversed action onto the redo stack.
function undoStroke() {
  const action = undoStack.pop();
  if (!action) return;

  if (action.type === 'add') {
    const arr = annotations[action.key];
    const removed = (arr && arr.length) ? arr.pop() : action.stroke;
    if (arr && arr.length === 0) delete annotations[action.key];
    redoStack.push({ type: 'add', key: action.key, stroke: removed });
    redrawKeyIfVisible(action.key);
  } else if (action.type === 'remove') {
    // Undo a single-stroke removal: put the stroke back at its old index.
    if (!annotations[action.key]) annotations[action.key] = [];
    const arr = annotations[action.key];
    const idx = Math.min(action.index, arr.length);
    arr.splice(idx, 0, action.stroke);
    redoStack.push(action);
    redrawKeyIfVisible(action.key);
  } else if (action.type === 'edit') {
    // Undo a text-note edit: swap the edited note back to its previous version.
    const arr = annotations[action.key];
    if (arr && action.index < arr.length) arr[action.index] = action.before;
    redoStack.push(action);
    redrawKeyIfVisible(action.key);
  } else if (action.type === 'clear') {
    for (const [key, strokes] of Object.entries(action.snapshot)) {
      annotations[key] = strokes;
      redrawKeyIfVisible(key);
    }
    redoStack.push(action);
  }
  scheduleSave();
}

// Redo the most recently undone action.
function redoStroke() {
  const action = redoStack.pop();
  if (!action) return;

  if (action.type === 'add') {
    if (!annotations[action.key]) annotations[action.key] = [];
    annotations[action.key].push(action.stroke);
    undoStack.push({ type: 'add', key: action.key, stroke: action.stroke });
    redrawKeyIfVisible(action.key);
  } else if (action.type === 'remove') {
    // Re-apply the removal.
    const arr = annotations[action.key];
    if (arr && action.index < arr.length) {
      arr.splice(action.index, 1);
      if (arr.length === 0) delete annotations[action.key];
    }
    undoStack.push(action);
    redrawKeyIfVisible(action.key);
  } else if (action.type === 'edit') {
    // Redo a text-note edit: swap the edited version back in.
    const arr = annotations[action.key];
    if (arr && action.index < arr.length) arr[action.index] = action.after;
    undoStack.push(action);
    redrawKeyIfVisible(action.key);
  } else if (action.type === 'clear') {
    // Re-apply the clear: remove the keys it originally cleared.
    for (const key of Object.keys(action.snapshot)) {
      delete annotations[key];
      redrawKeyIfVisible(key);
    }
    undoStack.push(action);
  }
  scheduleSave();
}

function clearCurrentPage() {
  // Clear only the last page the user interacted with. If none yet (or it's
  // no longer visible), fall back to the left/only visible page.
  const visiblePages = [currentPage];
  if (viewCount > 1) visiblePages.push(currentPage + 1);
  const target = visiblePages.includes(lastFocusedPage) ? lastFocusedPage : currentPage;

  const key = songKeyForPage(target);
  if (!annotations[key]) return;
  const snapshot = { [key]: annotations[key] };  // keep for undo
  delete annotations[key];
  redrawAnnotations(target);
  pushUndo({ type: 'clear', snapshot });
  scheduleSave();
}

// ---------- Mouse wheel ----------
// - Ctrl/Cmd + wheel  -> zoom in/out about the cursor (works in draw mode too).
//   Trackpad "pinch" arrives here as a ctrlKey wheel event, so this is the
//   zoom gesture on laptops without a touchscreen.
// - Plain wheel while zoomed -> scroll/pan the zoomed page.
// - Plain wheel at fit -> flip one page per notch (original behaviour).
//
// Bound on WINDOW (capture) rather than #viewer, because in read mode the
// tap-zones overlay sits on top of the viewer and would otherwise swallow the
// wheel event (which is exactly why zoom only worked in draw mode before).
let wheelCooldown = false;
window.addEventListener('wheel', (e) => {
  if (!pdfDoc) return;
  // Let chrome (scrubber, search results, popovers) handle their own scroll.
  if (inChrome(e.target)) return;

  // Zoom takes priority whenever Ctrl/Cmd is held (trackpad pinch => ctrlKey).
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const rect = viewer.getBoundingClientRect();
    const ax = e.clientX - rect.left;
    const ay = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0015);   // smooth multiplicative zoom
    setZoom(zoom * factor, ax, ay, false);
    return;
  }

  // When zoomed in, use the wheel to pan the page instead of flipping.
  if (isZoomed()) {
    e.preventDefault();
    panX -= e.deltaX;
    panY -= e.deltaY;
    positionTrack(false);
    return;
  }

  // Not zoomed: don't flip pages while drawing.
  if (drawMode) return;
  e.preventDefault();
  if (wheelCooldown) return;
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (delta > 0) next(); else if (delta < 0) prev();
  wheelCooldown = true;
  setTimeout(() => { wheelCooldown = false; }, 220);
}, { capture: true, passive: false });

// ---------- Touch pinch-zoom + pan ----------
// A capture-phase tracker on the viewer watches raw touch points. Two fingers
// = pinch to zoom + pan (works in read AND draw mode — it pre-empts drawing).
// One finger while already zoomed = drag to pan (read mode only; in draw mode
// one finger keeps drawing).
//
// activeTouches maps pointerId -> latest event for every touch currently down,
// shared with the drawing handler so a stroke aborts when a 2nd finger lands.
const activeTouches = new Map();
let pinchActive = false;
let panPointerActive = false;   // one-finger pan (read mode, zoomed)
let pinchStartDist = 0;
let pinchStartZoom = 1;
let pinchLastCenter = { x: 0, y: 0 };
let panLast = { x: 0, y: 0 };

function touchList() { return [...activeTouches.values()]; }
function dist(a, b) { return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
function center(a, b) { return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }; }

function beginPinch() {
  const [a, b] = touchList();
  pinchActive = true;
  panPointerActive = false;
  navPointerActive = false;             // cancel any pending page-flip tap
  abortActiveStrokes();                 // a 2nd finger cancels any live stroke
  pinchStartDist = dist(a, b) || 1;
  pinchStartZoom = zoom;
  pinchLastCenter = center(a, b);
}

function updatePinch() {
  const [a, b] = touchList();
  if (!a || !b) return;
  const rect = viewer.getBoundingClientRect();
  const c = center(a, b);
  const target = pinchStartZoom * (dist(a, b) / pinchStartDist);
  // Zoom about the pinch center...
  setZoom(target, c.x - rect.left, c.y - rect.top, false);
  // ...and pan by however much the center moved between frames (two-finger drag).
  panX += c.x - pinchLastCenter.x;
  panY += c.y - pinchLastCenter.y;
  pinchLastCenter = c;
  positionTrack(false);
}

// Touches inside the chrome (scrubber, search, toolbars, menus) must NOT be
// hijacked for zoom/pan — those own their own gestures.
function inChrome(target) {
  return !!(target.closest && target.closest(
    '#scrubber, #searchPanel, .draw-tools, .corner-right-group, ' +
    '.color-popover, #zoomOutBtn, .eraser-hint, .text-note-input'
  ));
}

// Tracked on the window in the capture phase so it sees every touch, whichever
// overlay (tap-zones, annotation canvas, ...) sits on top of the pages.
window.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch' || !pdfDoc) return;
  if (inChrome(e.target)) return;
  activeTouches.set(e.pointerId, e);

  if (activeTouches.size === 2) {
    beginPinch();
  } else if (activeTouches.size === 1 && isZoomed() && !drawMode) {
    // One finger while zoomed (and not drawing) = pan the page.
    panPointerActive = true;
    panLast = { x: e.clientX, y: e.clientY };
  }
}, { capture: true, passive: false });

window.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'touch') return;
  if (!activeTouches.has(e.pointerId)) return;
  activeTouches.set(e.pointerId, e);

  if (pinchActive && activeTouches.size >= 2) {
    e.preventDefault();
    e.stopPropagation();
    updatePinch();
  } else if (panPointerActive) {
    e.preventDefault();
    e.stopPropagation();
    panX += e.clientX - panLast.x;
    panY += e.clientY - panLast.y;
    panLast = { x: e.clientX, y: e.clientY };
    positionTrack(false);
  }
}, { capture: true, passive: false });

function endTouch(e) {
  if (e.pointerType !== 'touch') return;
  if (!activeTouches.has(e.pointerId)) return;
  activeTouches.delete(e.pointerId);
  if (activeTouches.size < 2 && pinchActive) {
    pinchActive = false;
    // If one finger remains, hand off to a pan (keeps the gesture fluid).
    if (activeTouches.size === 1 && isZoomed() && !drawMode) {
      panPointerActive = true;
      const remaining = touchList()[0];
      panLast = { x: remaining.clientX, y: remaining.clientY };
    }
  }
  if (activeTouches.size === 0) panPointerActive = false;
}
window.addEventListener('pointerup', endTouch, true);
window.addEventListener('pointercancel', endTouch, true);

// ---------- Zoom-out button ----------
zoomOutBtn.addEventListener('click', () => resetZoom(true));
// Zoom gestures: Ctrl/trackpad-pinch wheel, touch pinch, and Ctrl +/-/0.
// (Double-click and double-tap to zoom were intentionally removed.)

// ---------- Keyboard ----------
window.addEventListener('keydown', (e) => {
  // Shortcuts that work with or without a PDF open (menu bar was removed).
  if (e.ctrlKey && (e.key === 'o' || e.key === 'O')) {
    e.preventDefault(); openLibrary(); return;
  }
  if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault(); if (pdfDoc) openSearch(); return;
  }
  if (e.key === 'F11') {
    e.preventDefault();
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
    return;
  }
  if (!pdfDoc) return;
  // Zoom shortcuts (work in draw mode too). '=' shares the key with '+'.
  if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
    e.preventDefault(); setZoom(zoom * 1.25, null, null, true); return;
  }
  if (e.ctrlKey && (e.key === '-' || e.key === '_')) {
    e.preventDefault(); setZoom(zoom / 1.25, null, null, true); return;
  }
  if (e.ctrlKey && e.key === '0') {
    e.preventDefault(); resetZoom(true); return;
  }
  // Undo / redo work in draw mode.
  if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault(); undoStroke(); return;
  }
  if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) {
    e.preventDefault(); redoStroke(); return;
  }
  // Don't hijack keys while typing in the search box.
  if (document.activeElement === searchInput) return;
  // Tool shortcuts while in draw mode: P=pen, H=highlighter, L=line, E=eraser.
  if (drawMode && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.key === 'p' || e.key === 'P') { e.preventDefault(); setTool('pen'); return; }
    if (e.key === 'h' || e.key === 'H') { e.preventDefault(); setTool('highlighter'); return; }
    if (e.key === 't' || e.key === 'T') { e.preventDefault(); setTool('text'); return; }
    if (e.key === 'e' || e.key === 'E') { e.preventDefault(); eraserRelease(); return; }
  }
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
    e.preventDefault(); next();
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    prev();
  } else if (e.key === 'Home') {
    goToPage(1);
  } else if (e.key === 'End') {
    goToPage(pdfDoc.numPages);
  }
});



// (Touch tap & swipe are handled on the tap-zones overlay above, since it
// sits on top of the viewer and would otherwise intercept these touches.)

// ---------- Re-layout on resize / rotation ----------
let resizeTimer = null;
let lastLayoutWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (!pdfDoc) return;

  // While a text note is being edited, a 'resize' is almost always the soft
  // keyboard opening/closing (height-only). Re-laying out would rebuild the
  // page DOM and destroy the open editor (dismissing the keyboard). A genuine
  // rotation/resize changes the WIDTH — only then do we relayout mid-edit.
  if (textEditor && window.innerWidth === lastLayoutWidth) return;

  lastLayoutWidth = window.innerWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(async () => {
    renderToken++;
    await layout(renderToken);
    // Re-cache pages to disk at the new size so navigation stays fast.
    prerenderPages(renderToken);
  }, 200);
});

// ---------- Drag & drop ----------
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropOverlay.classList.remove('hidden');
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) dropOverlay.classList.add('hidden');
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropOverlay.classList.add('hidden');
  const file = e.dataTransfer.files[0];
  if (file && file.name.toLowerCase().endsWith('.pdf')) {
    const buf = await file.arrayBuffer();
    loadPdf(buf, file.name, file.path || file.name);
    // Electron exposes the real path on dropped files; remember it.
    if (file.path && window.api.rememberFile) window.api.rememberFile(file.path);
  }
});

// ---------- IPC from main process ----------
window.api.onPdfOpened(({ name, data, filePath }) => {
  // Close the library panel if it was open when a book was opened.
  closeLibrary();
  loadPdf(data, name, filePath);
});

// ---------- Library overlay ----------
const libraryOverlay  = document.getElementById('libraryOverlay');
const libraryGrid     = document.getElementById('libraryGrid');
const libraryEmpty    = document.getElementById('libraryEmpty');
const libraryCloseBtn = document.getElementById('libraryCloseBtn');
const libraryAddBtn   = document.getElementById('libraryAddBtn');

function openLibrary() {
  libraryOverlay.classList.remove('hidden');
  renderLibrary();
}

function closeLibrary() {
  libraryOverlay.classList.add('hidden');
}

libraryCloseBtn.addEventListener('click', closeLibrary);

// Close on backdrop click (click on the dim area outside the panel).
libraryOverlay.addEventListener('click', (e) => {
  if (e.target === libraryOverlay) closeLibrary();
});

// "Add book" opens the native file dialog; close the panel first so the
// dialog isn't behind the overlay.
libraryAddBtn.addEventListener('click', () => {
  closeLibrary();
  openPdfDialog();
});

// Escape closes the library.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !libraryOverlay.classList.contains('hidden')) {
    closeLibrary();
  }
});

// Render the cover grid from the recent-books list.
async function renderLibrary() {
  libraryGrid.innerHTML = '';

  const books = window.api.listRecentBooks ? await window.api.listRecentBooks() : [];

  if (!books || books.length === 0) {
    libraryEmpty.classList.remove('hidden');
    libraryGrid.style.display = 'none';
    return;
  }
  libraryEmpty.classList.add('hidden');
  libraryGrid.style.display = '';

  for (const book of books) {
    // Check for annotations in parallel with card rendering.
    const hasAnno = window.api.checkHasAnnotations
      ? await window.api.checkHasAnnotations(book.filePath).catch(() => false)
      : false;
    const card = buildBookCard(book, hasAnno);
    libraryGrid.appendChild(card);
    // Load thumbnail asynchronously so the grid appears instantly.
    loadCardThumbnail(card, book.filePath);
  }
}

// Build a single book card element (thumbnail + title + remove + share buttons).
function buildBookCard({ filePath, displayName }, hasAnnotations = false) {
  const card = document.createElement('div');
  card.className = 'library-card';
  if (currentPdfPath && filePath === currentPdfPath) card.classList.add('active-book');
  card.dataset.filePath = filePath;

  // Cover area
  const coverWrap = document.createElement('div');
  coverWrap.className = 'library-cover-wrap';

  // Placeholder icon shown until the thumbnail loads
  const placeholder = document.createElement('div');
  placeholder.className = 'library-cover-placeholder';
  // Icons: Lucide (lucide.dev), MIT licensed
  placeholder.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/>
  </svg>`;
  coverWrap.appendChild(placeholder);

  // Annotation badge — pencil icon on the cover's bottom-left corner
  if (hasAnnotations) {
    const badge = document.createElement('div');
    badge.className = 'library-anno-badge';
    badge.title = 'Has markups';
    badge.setAttribute('aria-label', 'Has markups');
    badge.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
      <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>
    </svg>`;
    coverWrap.appendChild(badge);
  }

  // Title label
  const nameEl = document.createElement('div');
  nameEl.className = 'library-book-name';
  nameEl.textContent = displayName;

  // Share button — on the card (bottom-right of cover), visible on hover
  const shareBtn = document.createElement('button');
  shareBtn.className = 'library-share-btn';
  shareBtn.title = 'Share / export this songbook';
  shareBtn.setAttribute('aria-label', `Share ${displayName}`);
  shareBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="18" cy="5" r="3"/>
    <circle cx="6" cy="12" r="3"/>
    <circle cx="18" cy="19" r="3"/>
    <line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/>
    <line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/>
  </svg>`;
  shareBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openShareDialog(filePath, displayName, hasAnnotations);
  });

  // Markups button — above the share button, visible on hover
  const markupsBtn = document.createElement('button');
  markupsBtn.className = 'library-markups-btn';
  markupsBtn.title = 'Manage markups';
  markupsBtn.setAttribute('aria-label', `Manage markups for ${displayName}`);
  markupsBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>
  </svg>`;
  markupsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openManageMarkupsDialog(filePath, displayName);
  });

  // Remove button (×): top-right of card, visible on hover
  const removeBtn = document.createElement('button');
  removeBtn.className = 'library-remove-btn';
  removeBtn.title = 'Remove from library';
  removeBtn.setAttribute('aria-label', `Remove ${displayName}`);
  removeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
  </svg>`;
  removeBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (window.api.removeRecentBook) await window.api.removeRecentBook(filePath);
    card.remove();
    // Show empty state if that was the last card.
    if (libraryGrid.children.length === 0) {
      libraryEmpty.classList.remove('hidden');
      libraryGrid.style.display = 'none';
    }
  });

  // Clicking the card opens the book.
  card.addEventListener('click', () => {
    closeLibrary();
    if (window.api && window.api.openFile) {
      window.api.openFile(filePath);
    }
  });

  card.appendChild(coverWrap);
  card.appendChild(nameEl);
  card.appendChild(markupsBtn);
  card.appendChild(shareBtn);
  card.appendChild(removeBtn);
  return card;
}

// Fetch and display the thumbnail for a card (async, non-blocking).
async function loadCardThumbnail(card, filePath) {
  if (!window.api.getBookThumbnail) return;
  try {
    const bytes = await window.api.getBookThumbnail(filePath);
    if (!bytes || !bytes.byteLength) return;
    // Replace the placeholder with an <img>.
    const blob = new Blob([bytes], { type: 'image/webp' });
    const url  = URL.createObjectURL(blob);
    const img  = document.createElement('img');
    img.className = 'library-cover-img';
    img.alt = '';
    img.src = url;
    img.onload = () => {
      const coverWrap = card.querySelector('.library-cover-wrap');
      if (coverWrap) {
        coverWrap.innerHTML = '';
        coverWrap.appendChild(img);
      }
    };
    img.onerror = () => URL.revokeObjectURL(url);
  } catch { /* leave placeholder in place */ }
}

// ---------- Share dialog ----------
const shareDialog      = document.getElementById('shareDialog');
const shareDialogBody  = document.getElementById('shareDialogBody');
const shareAnnoRow     = document.getElementById('shareAnnoRow');
const shareAnnoCheck   = document.getElementById('shareAnnoCheck');
const shareConfirmBtn  = document.getElementById('shareConfirmBtn');
const shareCancelBtn   = document.getElementById('shareCancelBtn');

let shareTargetPath = null;   // filePath being shared

function openShareDialog(filePath, displayName, hasAnnotations) {
  shareTargetPath = filePath;
  shareDialogBody.textContent =
    `Save a copy of "${displayName}" to share with another device.`;

  // Show or hide the annotations toggle depending on whether markups exist.
  if (hasAnnotations) {
    shareAnnoRow.classList.remove('hidden');
    shareAnnoCheck.checked = true;   // default: include markups
  } else {
    shareAnnoRow.classList.add('hidden');
    shareAnnoCheck.checked = false;
  }

  shareDialog.classList.remove('hidden');
}

function closeShareDialog() {
  shareDialog.classList.add('hidden');
  shareTargetPath = null;
}

shareCancelBtn.addEventListener('click', closeShareDialog);

// Close on backdrop click.
shareDialog.addEventListener('click', (e) => {
  if (e.target === shareDialog) closeShareDialog();
});

shareConfirmBtn.addEventListener('click', async () => {
  if (!shareTargetPath) { closeShareDialog(); return; }
  const filePath = shareTargetPath;
  const withAnnotations = shareAnnoCheck.checked;
  closeShareDialog();

  if (!window.api.shareBook) return;
  try {
    const result = await window.api.shareBook(filePath, withAnnotations);
    if (result && result.success) {
      // Brief confirmation — reuse the index toast which is already styled.
      // destPath is set on desktop; on mobile the share sheet handles feedback.
      if (result.destPath) showShareToast(`Saved to ${result.destPath}`);
    }
  } catch (err) {
    console.error('Share failed:', err);
  }
});

// Reuse the index-toast element for a brief share confirmation message.
function showShareToast(message) {
  indexToastLabel.textContent = message;
  indexBarFill.style.width = '100%';
  indexToast.classList.remove('hidden');
  clearTimeout(showShareToast._t);
  showShareToast._t = setTimeout(() => {
    indexToast.classList.add('hidden');
    indexBarFill.style.width = '0%';
  }, 3000);
}

// ---------- Manage markups dialog ----------
const manageMarkupsDialog   = document.getElementById('manageMarkupsDialog');
const manageMarkupsStats    = document.getElementById('manageMarkupsStats');
const mmReplaceBtn          = document.getElementById('mmReplaceBtn');
const mmMergeBtn            = document.getElementById('mmMergeBtn');
const mmClearBtn            = document.getElementById('mmClearBtn');
const mmClearConfirm        = document.getElementById('mmClearConfirm');
const mmClearConfirmYes     = document.getElementById('mmClearConfirmYes');
const mmClearConfirmNo      = document.getElementById('mmClearConfirmNo');
const manageMarkupsCloseBtn = document.getElementById('manageMarkupsCloseBtn');

// filePath of the book currently shown in the dialog (may differ from currentPdfPath).
let mmTargetPath = null;

// Default merge priority. The visual resolver lets you choose per song, so this
// is just the initial per-conflict selection (and the fallback used when a
// non-open book can't show previews). 'mine' = keep existing on conflict.
const mmMergePriority = 'mine';

function openManageMarkupsDialog(filePath, displayName) {
  mmTargetPath = filePath;
  mmClearConfirm.classList.add('hidden');
  mmClearBtn.disabled = false;
  // Update stats asynchronously so the dialog opens instantly.
  manageMarkupsStats.textContent = 'Loading…';
  manageMarkupsDialog.classList.remove('hidden');
  refreshMarkupsStats(filePath);
}

function closeManageMarkupsDialog() {
  manageMarkupsDialog.classList.add('hidden');
  mmClearConfirm.classList.add('hidden');
  mmTargetPath = null;
}

async function refreshMarkupsStats(filePath) {
  let count = 0;
  try {
    if (window.api.loadAnnotations) {
      const data = await window.api.loadAnnotations(filePath);
      if (data && typeof data === 'object') {
        count = Object.values(data).filter(arr => Array.isArray(arr) && arr.length > 0).length;
      }
    }
  } catch { /* leave count 0 */ }
  // Only update if the dialog is still showing the same book.
  if (mmTargetPath === filePath) {
    manageMarkupsStats.textContent = count === 0
      ? 'No markups on this book yet.'
      : `${count} song${count === 1 ? '' : 's'} marked in this book.`;
  }
}

// ---------- Merge conflict resolver (visual, open book only) ----------
// A "conflict" is a song key that has strokes in BOTH the existing marks and
// the incoming file. Keys present on only one side always merge in cleanly.

const mergeConflictDialog = document.getElementById('mergeConflictDialog');
const mcList     = document.getElementById('mcList');
const mcSubtitle = document.getElementById('mcSubtitle');
const mcAllMine  = document.getElementById('mcAllMine');
const mcAllFile  = document.getElementById('mcAllFile');
const mcApplyBtn = document.getElementById('mcApplyBtn');
const mcCancelBtn = document.getElementById('mcCancelBtn');

// Find the first page belonging to a song key (inverse of songKeyByPage).
function pageForSongKey(key) {
  for (const [page, k] of songKeyByPage.entries()) {
    if (k === key) return page;
  }
  return null;
}

// True if a key's stroke array actually has content.
function hasMarks(arr) { return Array.isArray(arr) && arr.length > 0; }

// True if two markup sets for a song are effectively identical, so there's
// nothing to choose between them. Compared by normalized JSON (order matters,
// which is correct: strokes are stored in draw order).
function sameMarks(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  try { return JSON.stringify(a) === JSON.stringify(b); }
  catch { return false; }
}

// Render page `n` into a preview canvas (fit to `maxW` css px) with the given
// stroke array drawn on top. Returns a canvas element, or null on failure.
async function renderPagePreview(n, strokes, maxW) {
  try {
    const page = await pdfDoc.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = maxW / vp1.width;
    const vp = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = `${Math.floor(vp.width)}px`;
    canvas.style.height = `${Math.floor(vp.height)}px`;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    // Draw the strokes/notes for this version on top (same pipeline as pages).
    const W = canvas.width, H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);   // draw items in device pixels
    for (const item of (strokes || [])) drawItem(ctx, item, W, H);
    return canvas;
  } catch {
    return null;
  }
}

// A human label for a conflicting song key, e.g. "Song 42" (+ title if known).
function labelForSongKey(key, page) {
  const m = /^s(\d+):/.exec(key);
  let label = m ? `Song ${m[1]}` : (page ? `Page ${page}` : key);
  if (page != null) {
    const entry = titleCache.get(page);
    if (entry) {
      const t = parseEntry(entry).title;
      if (t) label += ` · ${t}`;
    }
  }
  return label;
}

// State for the currently-open conflict resolution.
let mcState = null;   // { filePath, existing, incoming, conflicts:[{key,page,choice}], autoMerged }

// Open the visual resolver. `existing` and `incoming` are songKey->strokes maps.
// Returns nothing; applying/cancelling is handled by the buttons.
async function openMergeConflictResolver(filePath, existing, incoming) {
  // Find conflicting keys: marks on both sides AND the two versions differ.
  // Identical markups need no decision, so they're skipped (they merge as-is).
  const conflicts = [];
  for (const key of Object.keys(incoming)) {
    if (hasMarks(incoming[key]) && hasMarks(existing[key]) &&
        !sameMarks(incoming[key], existing[key])) {
      conflicts.push({ key, page: pageForSongKey(key), choice: mmMergePriority });
    }
  }

  // No conflicts: merge everything cleanly, no UI needed.
  if (conflicts.length === 0) {
    const merged = { ...incoming, ...existing };   // union; identical on non-conflicts
    await applyMergedAnnotations(filePath, merged);
    showShareToast('Markups merged.');
    return;
  }

  mcState = { filePath, existing, incoming, conflicts };

  mcSubtitle.textContent = conflicts.length === 1
    ? '1 song has markups in both. Pick which to keep.'
    : `${conflicts.length} songs have markups in both. Pick which to keep for each.`;

  // Build a block per conflict.
  mcList.innerHTML = '';
  for (const c of conflicts) {
    const block = document.createElement('div');
    block.className = 'mc-item';
    block.dataset.key = c.key;

    const heading = document.createElement('div');
    heading.className = 'mc-item-title';
    heading.textContent = labelForSongKey(c.key, c.page);
    block.appendChild(heading);

    const pair = document.createElement('div');
    pair.className = 'mc-pair';

    // Two selectable options: Mine and From file.
    for (const side of ['mine', 'file']) {
      const opt = document.createElement('button');
      opt.className = 'mc-option';
      opt.dataset.side = side;
      if (c.choice === side) opt.classList.add('mc-option--chosen');

      const preview = document.createElement('div');
      preview.className = 'mc-preview';
      preview.textContent = '…';   // placeholder until rendered
      opt.appendChild(preview);

      const cap = document.createElement('div');
      cap.className = 'mc-option-cap';
      const marks = (side === 'mine' ? c.existing || existing[c.key] : incoming[c.key]) || [];
      cap.textContent = `${side === 'mine' ? 'Mine' : 'From file'} · ${marks.length} mark${marks.length === 1 ? '' : 's'}`;
      opt.appendChild(cap);

      opt.addEventListener('click', () => {
        c.choice = side;
        pair.querySelectorAll('.mc-option').forEach(o =>
          o.classList.toggle('mc-option--chosen', o.dataset.side === side));
      });
      pair.appendChild(opt);
    }

    block.appendChild(pair);
    mcList.appendChild(block);

    // Render both previews (page can be null if we couldn't map the key).
    if (c.page != null) {
      const [mineCanvas, fileCanvas] = await Promise.all([
        renderPagePreview(c.page, existing[c.key], 300),
        renderPagePreview(c.page, incoming[c.key], 300),
      ]);
      const previews = pair.querySelectorAll('.mc-preview');
      if (mineCanvas) { previews[0].textContent = ''; previews[0].appendChild(mineCanvas); }
      else previews[0].textContent = 'preview unavailable';
      if (fileCanvas) { previews[1].textContent = ''; previews[1].appendChild(fileCanvas); }
      else previews[1].textContent = 'preview unavailable';
    } else {
      pair.querySelectorAll('.mc-preview').forEach(p => { p.textContent = 'preview unavailable'; });
    }
  }

  mergeConflictDialog.classList.remove('hidden');
}

function closeMergeConflictResolver() {
  mergeConflictDialog.classList.add('hidden');
  mcList.innerHTML = '';
  mcState = null;
}

// Bulk-choose helpers.
function mcSetAll(side) {
  if (!mcState) return;
  for (const c of mcState.conflicts) c.choice = side;
  mcList.querySelectorAll('.mc-item').forEach(item => {
    item.querySelectorAll('.mc-option').forEach(o =>
      o.classList.toggle('mc-option--chosen', o.dataset.side === side));
  });
}
mcAllMine.addEventListener('click', () => mcSetAll('mine'));
mcAllFile.addEventListener('click', () => mcSetAll('file'));
mcCancelBtn.addEventListener('click', closeMergeConflictResolver);

mcApplyBtn.addEventListener('click', async () => {
  if (!mcState) { closeMergeConflictResolver(); return; }
  const { filePath, existing, incoming, conflicts } = mcState;

  // Start from the union (non-conflicting keys from both sides come in),
  // then apply each per-conflict choice.
  const merged = { ...incoming, ...existing };
  for (const c of conflicts) {
    merged[c.key] = (c.choice === 'file') ? incoming[c.key] : existing[c.key];
  }
  closeMergeConflictResolver();
  await applyMergedAnnotations(filePath, merged);
  showShareToast('Markups merged.');
});

// Persist a merged annotation map and refresh the view if it's the open book.
async function applyMergedAnnotations(filePath, merged) {
  if (window.api.saveAnnotations) {
    await window.api.saveAnnotations(filePath, merged).catch(() => {});
  }
  if (filePath === currentPdfPath) {
    await reloadAnnotationsQuiet();
    redrawVisibleAnnotations();
  }
}

manageMarkupsCloseBtn.addEventListener('click', closeManageMarkupsDialog);

manageMarkupsDialog.addEventListener('click', (e) => {
  if (e.target === manageMarkupsDialog) closeManageMarkupsDialog();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !manageMarkupsDialog.classList.contains('hidden')) {
    closeManageMarkupsDialog();
  }
  if (e.key === 'Escape' && !mergeConflictDialog.classList.contains('hidden')) {
    closeMergeConflictResolver();
  }
});
mergeConflictDialog.addEventListener('click', (e) => {
  if (e.target === mergeConflictDialog) closeMergeConflictResolver();
});

// ---- Replace ----
mmReplaceBtn.addEventListener('click', async () => {
  const filePath = mmTargetPath;
  if (!filePath) return;
  closeManageMarkupsDialog();

  if (MOBILE && window.api.replaceAnnotationsFromFile) {
    const result = await window.api.replaceAnnotationsFromFile(filePath).catch(() => null);
    if (!result || !result.success) return;
  } else if (window.api.loadAnnotationsFile && window.api.saveAnnotations) {
    const incoming = await window.api.loadAnnotationsFile().catch(() => null);
    if (!incoming) return;
    await window.api.saveAnnotations(filePath, incoming);
  } else return;

  // If it's the open book, reload into memory immediately.
  if (filePath === currentPdfPath) {
    await reloadAnnotationsQuiet();
    redrawVisibleAnnotations();
  }
  showShareToast('Markups replaced.');
});

// ---- Merge ----
mmMergeBtn.addEventListener('click', async () => {
  const filePath = mmTargetPath;
  if (!filePath) return;
  const priority = mmMergePriority;   // capture before dialog closes
  closeManageMarkupsDialog();

  let incoming = null;

  if (MOBILE && window.api.importAnnotationsSidecar) {
    // Mobile importAnnotationsSidecar always gives priority to existing — for
    // "file wins" we use replaceAnnotationsFromFile on top of a manual merge.
    if (priority === 'mine') {
      const result = await window.api.importAnnotationsSidecar(filePath).catch(() => null);
      if (!result || !result.success) return;
    } else {
      // "File wins": load existing, load incoming via file picker, file takes priority.
      const result = await window.api.replaceAnnotationsFromFile(filePath).catch(() => null);
      if (!result || !result.success) return;
      // Re-read what was just written (the incoming data) and overlay existing.
      const saved  = (await window.api.loadAnnotations(filePath).catch(() => null)) || {};
      const before = (filePath === currentPdfPath) ? { ...annotations } : {};
      const merged = priority === 'file'
        ? { ...before, ...saved }    // saved (incoming) wins over old
        : { ...saved, ...before };   // before (mine) wins — shouldn't reach here
      if (filePath === currentPdfPath) {
        annotations = merged;
        migrateLegacyAnnotations();
        rebuildSongKeyMap();
        scheduleSave();
      } else {
        await window.api.saveAnnotations(filePath, merged);
      }
    }
  } else if (window.api.loadAnnotationsFile) {
    incoming = await window.api.loadAnnotationsFile().catch(() => null);
    if (!incoming) return;

    // Load what's already on disk for this book.
    const existing = (await window.api.loadAnnotations(filePath).catch(() => null)) || {};

    // If we're merging into the CURRENTLY OPEN book, we can render page
    // previews — so show the visual conflict resolver (it applies + saves and
    // handles the no-conflict fast path internally).
    if (filePath === currentPdfPath && pdfDoc) {
      await openMergeConflictResolver(filePath, existing, incoming);
      return;   // resolver handles saving, reload, and the toast
    }

    // Otherwise (a different, unopened book — no PDF to preview) fall back to
    // the priority-based merge.
    const merged = priority === 'mine'
      ? { ...incoming, ...existing }   // existing (mine) overwrites incoming
      : { ...existing, ...incoming };  // incoming (file) overwrites existing
    await window.api.saveAnnotations(filePath, merged);
  }

  // If it's the open book, reload into memory immediately.
  if (filePath === currentPdfPath) {
    await reloadAnnotationsQuiet();
    redrawVisibleAnnotations();
  }
  showShareToast('Markups merged.');
});

// ---- Clear (with confirmation) ----
mmClearBtn.addEventListener('click', () => {
  mmClearConfirm.classList.remove('hidden');
  mmClearBtn.disabled = true;
});

mmClearConfirmNo.addEventListener('click', () => {
  mmClearConfirm.classList.add('hidden');
  mmClearBtn.disabled = false;
});

mmClearConfirmYes.addEventListener('click', async () => {
  const filePath = mmTargetPath;
  if (!filePath) { closeManageMarkupsDialog(); return; }
  closeManageMarkupsDialog();

  if (MOBILE && window.api.clearAnnotations) {
    await window.api.clearAnnotations(filePath).catch(() => {});
  } else if (window.api.saveAnnotations) {
    await window.api.saveAnnotations(filePath, {});
  }

  // If it's the open book, clear in memory immediately too.
  if (filePath === currentPdfPath) {
    annotations = {};
    undoStack = [];
    redoStack = [];
    rebuildSongKeyMap();
    redrawVisibleAnnotations();
  }
  showShareToast('All markups cleared.');
});
