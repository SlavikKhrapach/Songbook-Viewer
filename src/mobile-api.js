// ---------------------------------------------------------------------------
// Mobile (Capacitor / Android) implementation of window.api
// ---------------------------------------------------------------------------
// The renderer talks to the host through a small `window.api` bridge. On the
// desktop that bridge is Electron's preload (IPC -> Node fs). On Android there
// is no Electron, so this module provides the SAME interface backed by:
//   - @capacitor/filesystem   : file storage
//   - @capacitor/preferences  : tiny key/values
//   - @capacitor/share        : Android native share sheet
//   - a hidden <input type=file>: open PDF / JSON pickers
//
// Storage layout
// ──────────────
// PUBLIC  Directory.Documents / "Songbook Viewer" /
//           <DisplayName>.pdf                  ← the book
//           <DisplayName>.annotations.json     ← strokes (human-readable name)
//
// PRIVATE Directory.Data / "songbook" /
//           meta/<slug>.meta.json              ← { displayName, pdfFile, annoFile }
//           meta/<slug>.index.json             ← page-title / lang cache
//           pagecache/<slug>/<sz>/<n>.webp     ← rendered page cache
//
// The slug (e.g. "hymnal") is the stable internal key the renderer uses.
// The meta sidecar maps slug → human-readable filenames in Documents.
// ---------------------------------------------------------------------------

import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { Share } from '@capacitor/share';

if (!window.api) {
  // ── Directory constants ────────────────────────────────────────────────────
  const PRIV        = Directory.Data;           // private app storage
  const PUB         = Directory.Documents;      // public Documents folder
  const PUB_FOLDER  = 'Songbook Viewer';        // subfolder inside Documents
  const CACHE_SHARE = Directory.Cache;          // for FileProvider share temps

  // Private paths
  const META_DIR   = 'songbook/meta';           // .meta.json + .index.json
  const CACHE_DIR  = 'songbook/pagecache';      // rendered page WebP cache
  const SHARE_TMP  = 'share';                   // temp dir for sharing

  // Legacy private paths (pre-migration)
  const LEGACY_BOOKS = 'songbook/books';
  const LEGACY_META  = 'songbook/meta';         // same as META_DIR (only .json differs)

  // Preferences keys
  const LAST_BOOK_KEY    = 'lastBookId';
  const LAST_BOOK_NAME   = 'lastBookName';
  const RECENT_BOOKS_KEY = 'recentBooks';
  const MIGRATED_KEY     = 'storageV2Migrated'; // set after migration completes
  const MAX_RECENT       = 20;

  // ── Slug derivation ───────────────────────────────────────────────────────
  // Matches desktop bookKeyFromPath: strips version tokens, lowercases, hyphens.
  function slugFromName(name) {
    let n = String(name || '').replace(/\.[^.]+$/, '').toLowerCase();
    n = n
      .replace(/[\(\[].*?[\)\]]/g, ' ')
      .replace(/\bv?\d+(?:[._]\d+)*\b/g, ' ')
      .replace(/\b(rev|revision|ver|version|draft|final|copy|update|updated)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, '-');
    return n || 'book';
  }

  // Strip extension to get a display name from a filename.
  function displayFromName(name) {
    return String(name || '').replace(/\.[^.]+$/, '');
  }

  // Sanitise a display name so it's safe as a filename on Android.
  function safeFilename(name) {
    return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'book';
  }

  // ── Low-level filesystem helpers ─────────────────────────────────────────

  async function ensureDir(path, dir = PRIV) {
    try { await Filesystem.mkdir({ path, directory: dir, recursive: true }); } catch { /* exists */ }
  }

  async function readJson(path, dir = PRIV) {
    try {
      const r = await Filesystem.readFile({ path, directory: dir, encoding: Encoding.UTF8 });
      return JSON.parse(r.data);
    } catch { return null; }
  }

  async function writeJson(path, obj, dir = PRIV) {
    try {
      await Filesystem.writeFile({
        path, directory: dir, encoding: Encoding.UTF8,
        data: JSON.stringify(obj), recursive: true,
      });
      return true;
    } catch (err) { console.error('writeJson failed', path, err); return false; }
  }

  async function readBinary(path, dir = PRIV) {
    try {
      const r = await Filesystem.readFile({ path, directory: dir });
      return base64ToAB(r.data);
    } catch { return null; }
  }

  async function writeBinary(path, buf, dir = PRIV) {
    try {
      await Filesystem.writeFile({ path, directory: dir, data: abToBase64(buf), recursive: true });
      return true;
    } catch (err) { console.error('writeBinary failed', path, err); return false; }
  }

  async function fileExists(path, dir = PRIV) {
    try { await Filesystem.stat({ path, directory: dir }); return true; }
    catch { return false; }
  }

  async function deleteFile(path, dir = PRIV) {
    try { await Filesystem.deleteFile({ path, directory: dir }); } catch { /* ignore */ }
  }

  // ── Binary ↔ base64 ───────────────────────────────────────────────────────

  function abToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    return btoa(s);
  }

  function base64ToAB(b64) {
    const s = atob(b64);
    const buf = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i);
    return buf.buffer;
  }

  // ── Meta sidecar (private index: slug → filenames + displayName) ──────────
  // Path: META_DIR/<slug>.meta.json  (in PRIV)
  // Shape: { displayName, pdfFile, annoFile }
  //   pdfFile  = "Hymnal.pdf"
  //   annoFile = "Hymnal.annotations.json"

  function metaPath(slug) { return `${META_DIR}/${slug}.meta.json`; }
  function indexPath(slug) { return `${META_DIR}/${slug}.index.json`; }

  async function getMeta(slug) {
    return readJson(metaPath(slug), PRIV);
  }

  async function setMeta(slug, displayName) {
    const safe = safeFilename(displayName);
    await writeJson(metaPath(slug), {
      displayName,
      pdfFile:  `${safe}.pdf`,
      annoFile: `${safe}.annotations.json`,
    }, PRIV);
  }

  // Derive the Documents paths for a slug (needs meta to get the filename).
  async function pubPdfPath(slug)  { const m = await getMeta(slug); return m ? `${PUB_FOLDER}/${m.pdfFile}`  : null; }
  async function pubAnnoPath(slug) { const m = await getMeta(slug); return m ? `${PUB_FOLDER}/${m.annoFile}` : null; }

  // ── Recent-books list ──────────────────────────────────────────────────────

  async function getRecentBooks() {
    try { const { value } = await Preferences.get({ key: RECENT_BOOKS_KEY }); return value ? JSON.parse(value) : []; }
    catch { return []; }
  }
  async function saveRecentBooks(list) {
    await Preferences.set({ key: RECENT_BOOKS_KEY, value: JSON.stringify(list) });
  }
  async function addRecentBook(slug, displayName) {
    let list = await getRecentBooks();
    list = list.filter(r => r.id !== slug);
    list.unshift({ id: slug, displayName });
    if (list.length > MAX_RECENT) list = list.slice(0, MAX_RECENT);
    await saveRecentBooks(list);
  }

  // ── Migration from old storage (v1 → v2) ─────────────────────────────────
  // Old layout: PRIV/songbook/books/<slug>.pdf + PRIV/songbook/meta/<slug>.json
  // New layout: PUB/Songbook Viewer/<DisplayName>.pdf + .annotations.json
  // Runs once; sets MIGRATED_KEY when done.

  async function migrateIfNeeded() {
    try {
      const { value } = await Preferences.get({ key: MIGRATED_KEY });
      if (value === '1') return; // already done
    } catch { /* first run */ }

    try {
      await ensureDir(PUB_FOLDER, PUB);

      // Scan old meta dir for annotation files.
      let entries = [];
      try {
        const listing = await Filesystem.readdir({ path: LEGACY_META, directory: PRIV });
        entries = listing.files;
      } catch { /* nothing to migrate */ }

      for (const entry of entries) {
        const fname = entry.name || entry;
        // Only migrate annotation data files (not .meta.json or .index.json).
        if (!fname.endsWith('.json') || fname.endsWith('.meta.json') || fname.endsWith('.index.json')) continue;
        const slug = fname.replace(/\.json$/, '');

        // Read old annotation data.
        const annoData = await readJson(`${LEGACY_META}/${fname}`, PRIV);
        if (!annoData) continue;

        // Determine display name from old meta sidecar or preferences.
        let displayName = slug;
        const oldMeta = await readJson(`${LEGACY_META}/${slug}.meta.json`, PRIV);
        if (oldMeta?.displayName) displayName = oldMeta.displayName;

        const safe = safeFilename(displayName);

        // Write annotation to Documents.
        await writeJson(`${PUB_FOLDER}/${safe}.annotations.json`, annoData, PUB);

        // Migrate PDF if it exists in old location.
        const oldPdfPath = `${LEGACY_BOOKS}/${slug}.pdf`;
        const pdfBytes = await readBinary(oldPdfPath, PRIV);
        if (pdfBytes) {
          await writeBinary(`${PUB_FOLDER}/${safe}.pdf`, pdfBytes, PUB);
          await deleteFile(oldPdfPath, PRIV);
        }

        // Write new meta sidecar.
        await setMeta(slug, displayName);

        // Delete old annotation file (meta.json is replaced by new setMeta).
        await deleteFile(`${LEGACY_META}/${fname}`, PRIV);
      }
    } catch (err) {
      console.error('Migration failed (non-fatal):', err);
    }

    await Preferences.set({ key: MIGRATED_KEY, value: '1' });
  }

  // ── File pickers ──────────────────────────────────────────────────────────

  let pdfOpenedCallback = null;

  async function importAndOpen(name, arrayBuffer) {
    const slug        = slugFromName(name);
    const displayName = displayFromName(name);
    const safe        = safeFilename(displayName);

    await ensureDir(PUB_FOLDER, PUB);

    // Save PDF to Documents.
    await writeBinary(`${PUB_FOLDER}/${safe}.pdf`, arrayBuffer, PUB);

    // Write / update meta sidecar (private).
    await setMeta(slug, displayName);

    await Preferences.set({ key: LAST_BOOK_KEY,  value: slug });
    await Preferences.set({ key: LAST_BOOK_NAME, value: name });
    await addRecentBook(slug, displayName);

    if (pdfOpenedCallback) pdfOpenedCallback({ name, data: arrayBuffer, filePath: slug });
  }

  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = 'application/pdf,.pdf';
  fileInput.style.display = 'none'; document.body.appendChild(fileInput);
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    const buf = await file.arrayBuffer();
    await importAndOpen(file.name, buf);
  });

  // Hidden JSON picker — shared between importAnnotationsSidecar and replaceAnnotationsFromFile.
  const jsonInput = document.createElement('input');
  jsonInput.type = 'file'; jsonInput.accept = '.json,application/json';
  jsonInput.style.display = 'none'; document.body.appendChild(jsonInput);
  let jsonResolve = null;
  jsonInput.addEventListener('change', async () => {
    const file = jsonInput.files && jsonInput.files[0];
    jsonInput.value = '';
    if (jsonResolve) { jsonResolve(file || null); jsonResolve = null; }
  });

  // ── Reopen last book on launch ────────────────────────────────────────────

  async function reopenLastBook() {
    try {
      const { value: slug } = await Preferences.get({ key: LAST_BOOK_KEY });
      if (!slug) return;
      const pp = await pubPdfPath(slug);
      if (!pp) return;
      const buf = await readBinary(pp, PUB);
      if (!buf) return;
      const { value: name } = await Preferences.get({ key: LAST_BOOK_NAME });
      if (pdfOpenedCallback) pdfOpenedCallback({ name: name || slug, data: buf, filePath: slug });
    } catch (err) { console.error('reopenLastBook failed', err); }
  }

  // ── Wake lock ─────────────────────────────────────────────────────────────

  let webWakeLock = null;
  async function requestWakeLock() {
    try { await KeepAwake.keepAwake(); return; } catch { /* try web API */ }
    try {
      if ('wakeLock' in navigator) {
        webWakeLock = await navigator.wakeLock.request('screen');
        webWakeLock.addEventListener('release', () => { webWakeLock = null; });
      }
    } catch { /* unsupported */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !webWakeLock) requestWakeLock();
  });

  // ── The bridge ────────────────────────────────────────────────────────────
  window.api = {

    openDialog() { fileInput.click(); },

    onPdfOpened(callback) {
      pdfOpenedCallback = callback;
      // Migrate old storage first, then reopen.
      migrateIfNeeded().then(() => reopenLastBook());
    },

    rememberFile() { /* no-op on mobile */ },

    async openFile(slug) {
      try {
        const pp = await pubPdfPath(slug);
        if (!pp) { console.warn('openFile: no pubPdfPath for', slug); return; }
        const buf = await readBinary(pp, PUB);
        if (!buf) { console.warn('openFile: PDF not found', pp); return; }
        const meta = await getMeta(slug);
        if (pdfOpenedCallback) pdfOpenedCallback({ name: meta?.displayName || slug, data: buf, filePath: slug });
      } catch (err) { console.error('openFile failed', err); }
    },

    // ── Annotations ──────────────────────────────────────────────────────────

    async loadAnnotations(slug) {
      const ap = await pubAnnoPath(slug);
      if (!ap) return null;
      return readJson(ap, PUB);
    },

    async saveAnnotations(slug, data) {
      // Ensure meta exists (creates it if missing, e.g. very first save).
      let meta = await getMeta(slug);
      if (!meta) {
        // Fall back to slug as display name if we have no better info.
        const { value: storedName } = await Preferences.get({ key: LAST_BOOK_NAME }).catch(() => ({ value: null }));
        const displayName = storedName ? displayFromName(storedName) : slug;
        await setMeta(slug, displayName);
        meta = await getMeta(slug);
      }
      await ensureDir(PUB_FOLDER, PUB);
      await writeJson(`${PUB_FOLDER}/${meta.annoFile}`, data, PUB);
      return true;
    },

    async listAnnotatedBooks(currentSlug) {
      try {
        // Scan Documents/Songbook Viewer for *.annotations.json files.
        const listing = await Filesystem.readdir({ path: PUB_FOLDER, directory: PUB });
        const results = [];
        for (const entry of listing.files) {
          const fname = entry.name || entry;
          if (!fname.endsWith('.annotations.json')) continue;
          // Derive slug from the filename.
          const displayName = fname.replace(/\.annotations\.json$/, '');
          const slug = slugFromName(displayName);
          if (slug === currentSlug) continue;
          try {
            const data = await readJson(`${PUB_FOLDER}/${fname}`, PUB);
            if (!data) continue;
            const hasStrokes = Object.values(data).some(arr => Array.isArray(arr) && arr.length > 0);
            if (!hasStrokes) continue;
            results.push({ id: slug, displayName });
          } catch { /* skip */ }
        }
        results.sort((a, b) => a.displayName.localeCompare(b.displayName));
        return results;
      } catch { return []; }
    },

    async copyAnnotations(fromSlug, toSlug) {
      try {
        const fromPath = await pubAnnoPath(fromSlug);
        if (!fromPath) return false;
        const source = await readJson(fromPath, PUB);
        if (!source) return false;
        const toPath = await pubAnnoPath(toSlug);
        const dest = toPath ? ((await readJson(toPath, PUB)) || {}) : {};
        const merged = { ...source, ...dest };
        await this.saveAnnotations(toSlug, merged);
        return true;
      } catch (err) { console.error('copyAnnotations failed', err); return false; }
    },

    // Merge: existing marks take priority.
    importAnnotationsSidecar(slug) {
      return new Promise((resolve) => {
        jsonResolve = async (file) => {
          if (!file) { resolve({ success: false }); return; }
          try {
            const incoming = JSON.parse(await file.text());
            if (!incoming || typeof incoming !== 'object') { resolve({ success: false, error: 'Invalid JSON' }); return; }
            const ap = await pubAnnoPath(slug);
            const existing = ap ? ((await readJson(ap, PUB)) || {}) : {};
            const merged = { ...incoming, ...existing };
            await this.saveAnnotations(slug, merged);
            resolve({ success: true });
          } catch (err) { console.error('importAnnotationsSidecar failed', err); resolve({ success: false, error: String(err) }); }
        };
        jsonInput.click();
      });
    },

    // Replace: discard existing, use file contents wholesale.
    replaceAnnotationsFromFile(slug) {
      return new Promise((resolve) => {
        jsonResolve = async (file) => {
          if (!file) { resolve({ success: false }); return; }
          try {
            const incoming = JSON.parse(await file.text());
            if (!incoming || typeof incoming !== 'object') { resolve({ success: false, error: 'Invalid JSON' }); return; }
            await this.saveAnnotations(slug, incoming);
            resolve({ success: true });
          } catch (err) { console.error('replaceAnnotationsFromFile failed', err); resolve({ success: false, error: String(err) }); }
        };
        jsonInput.click();
      });
    },

    async clearAnnotations(slug) {
      try { await this.saveAnnotations(slug, {}); return true; }
      catch (err) { console.error('clearAnnotations failed', err); return false; }
    },

    // ── Index cache (private — regeneratable) ─────────────────────────────

    loadIndex(slug)       { return readJson(indexPath(slug), PRIV); },
    saveIndex(slug, data) { return writeJson(indexPath(slug), data, PRIV); },

    // ── Page-image cache (private) ────────────────────────────────────────

    loadPageImage(slug, sizeKey, page) {
      return readBinary(`${CACHE_DIR}/${slug}/${sizeKey}/${page}.webp`, PRIV);
    },
    savePageImage(slug, sizeKey, page, bytes) {
      return writeBinary(`${CACHE_DIR}/${slug}/${sizeKey}/${page}.webp`, bytes, PRIV);
    },
    async prunePageCache(slug, keepSizeKey) {
      try {
        const base = `${CACHE_DIR}/${slug}`;
        const listing = await Filesystem.readdir({ path: base, directory: PRIV });
        for (const entry of listing.files) {
          const sk = entry.name || entry;
          if (sk !== String(keepSizeKey))
            await Filesystem.rmdir({ path: `${base}/${sk}`, directory: PRIV, recursive: true });
        }
        return true;
      } catch { return false; }
    },

    // ── Library / recent-books ────────────────────────────────────────────

    async listRecentBooks() {
      const list = await getRecentBooks();
      const valid = [];
      for (const entry of list) {
        const pp = await pubPdfPath(entry.id);
        if (pp && await fileExists(pp, PUB))
          valid.push({ filePath: entry.id, displayName: entry.displayName });
      }
      return valid;
    },

    async removeRecentBook(slug) {
      let list = await getRecentBooks();
      list = list.filter(r => r.id !== slug);
      await saveRecentBooks(list);
      const { value: last } = await Preferences.get({ key: LAST_BOOK_KEY }).catch(() => ({ value: null }));
      if (last === slug) {
        const next = list[0];
        await Preferences.set({ key: LAST_BOOK_KEY,  value: next ? next.id          : '' });
        await Preferences.set({ key: LAST_BOOK_NAME, value: next ? next.displayName : '' });
      }
      return true;
    },

    async getBookThumbnail(slug) {
      try {
        const base = `${CACHE_DIR}/${slug}`;
        const listing = await Filesystem.readdir({ path: base, directory: PRIV });
        for (const entry of listing.files) {
          const sizeKey = entry.name || entry;
          const buf = await readBinary(`${base}/${sizeKey}/1.webp`, PRIV);
          if (buf) return buf;
        }
        return null;
      } catch { return null; }
    },

    async checkHasAnnotations(slug) {
      try {
        const ap = await pubAnnoPath(slug);
        if (!ap) return false;
        const data = await readJson(ap, PUB);
        if (!data) return false;
        return Object.values(data).some(arr => Array.isArray(arr) && arr.length > 0);
      } catch { return false; }
    },

    // ── Share via Android share sheet ─────────────────────────────────────
    // Copies files to Cache (FileProvider-accessible) then invokes Share.

    async shareBook(slug, withAnnotations) {
      try {
        const meta = await getMeta(slug);
        const displayName = meta?.displayName || slug;
        const safe = safeFilename(displayName);
        const suffix = withAnnotations ? ' (with markups)' : '';

        // Read PDF from Documents.
        const pp = await pubPdfPath(slug);
        if (!pp) return { success: false, error: 'PDF path not found' };
        const pdfBytes = await readBinary(pp, PUB);
        if (!pdfBytes) return { success: false, error: 'PDF not found' };

        // Write to Cache for FileProvider.
        await ensureDir(SHARE_TMP, CACHE_SHARE);
        const sharePdfPath = `${SHARE_TMP}/${safe}${suffix}.pdf`;
        await writeBinary(sharePdfPath, pdfBytes, CACHE_SHARE);
        const { uri: pdfUri } = await Filesystem.getUri({ path: sharePdfPath, directory: CACHE_SHARE });
        const files = [pdfUri];

        if (withAnnotations) {
          const ap = await pubAnnoPath(slug);
          const annoData = ap ? await readJson(ap, PUB) : null;
          if (annoData) {
            const shareAnnoPath = `${SHARE_TMP}/${safe}.annotations.json`;
            await writeJson(shareAnnoPath, annoData, CACHE_SHARE);
            const { uri: annoUri } = await Filesystem.getUri({ path: shareAnnoPath, directory: CACHE_SHARE });
            files.push(annoUri);
          }
        }

        await Share.share({ title: displayName, dialogTitle: 'Share songbook', files });
        return { success: true };
      } catch (err) {
        if (String(err).includes('canceled') || String(err).includes('Share canceled'))
          return { success: false };
        console.error('shareBook failed', err);
        return { success: false, error: String(err) };
      }
    },
  };

  requestWakeLock();
}
