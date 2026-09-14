// ---------------------------------------------------------------------------
// Mobile (Capacitor / Android) implementation of window.api
// ---------------------------------------------------------------------------
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { Share } from '@capacitor/share';
import { App } from '@capacitor/app';

if (!window.api) {
  const DIR       = Directory.Data;
  const CACHE_DIR_NATIVE = Directory.Cache;
  const ROOT      = 'songbook';
  const BOOKS_DIR = `${ROOT}/books`;
  const META_DIR  = `${ROOT}/meta`;
  const CACHE_DIR = `${ROOT}/pagecache`;
  const SHARE_DIR = 'share';
  const LAST_BOOK_KEY    = 'lastBookId';
  const LAST_BOOK_NAME   = 'lastBookName';
  const RECENT_BOOKS_KEY = 'recentBooks';
  const MAX_RECENT = 20;

  // ── Slug derivation ───────────────────────────────────────────────────────

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

  function displayFromName(name) {
    return String(name || '').replace(/\.[^.]+$/, '');
  }

  // ── Low-level helpers ─────────────────────────────────────────────────────

  async function ensureDir(path, dir = DIR) {
    try { await Filesystem.mkdir({ path, directory: dir, recursive: true }); } catch { /* exists */ }
  }

  async function readJson(path, dir = DIR) {
    try {
      const r = await Filesystem.readFile({ path, directory: dir, encoding: Encoding.UTF8 });
      return JSON.parse(r.data);
    } catch { return null; }
  }

  async function writeJson(path, obj, dir = DIR) {
    try {
      await Filesystem.writeFile({
        path, directory: dir, encoding: Encoding.UTF8,
        data: JSON.stringify(obj), recursive: true,
      });
      return true;
    } catch (err) { console.error('writeJson failed', path, err); return false; }
  }

  async function readBinary(path, dir = DIR) {
    try {
      const r = await Filesystem.readFile({ path, directory: dir });
      return base64ToAB(r.data);
    } catch { return null; }
  }

  async function writeBinary(path, buf, dir = DIR) {
    try {
      await Filesystem.writeFile({ path, directory: dir, data: abToBase64(buf), recursive: true });
      return true;
    } catch (err) { console.error('writeBinary failed', path, err); return false; }
  }

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

  // ── Recent-books list ─────────────────────────────────────────────────────

  async function getRecentBooks() {
    try {
      const { value } = await Preferences.get({ key: RECENT_BOOKS_KEY });
      return value ? JSON.parse(value) : [];
    } catch { return []; }
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

  // ── File pickers ──────────────────────────────────────────────────────────

  let pdfOpenedCallback = null;
  let backButtonCallback = null;
  let backButtonRegistered = false;

  async function importAndOpen(name, arrayBuffer) {
    const slug        = slugFromName(name);
    const displayName = displayFromName(name);

    await ensureDir(BOOKS_DIR);
    await writeBinary(`${BOOKS_DIR}/${slug}.pdf`, arrayBuffer);

    // Write display-name meta sidecar.
    await writeJson(`${META_DIR}/${slug}.meta.json`, { displayName });

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

  // Hidden JSON picker for annotation import.
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
      const buf = await readBinary(`${BOOKS_DIR}/${slug}.pdf`);
      if (!buf) return;
      const { value: name } = await Preferences.get({ key: LAST_BOOK_NAME });
      const meta = await readJson(`${META_DIR}/${slug}.meta.json`);
      const displayName = meta?.displayName || name || slug;
      if (pdfOpenedCallback) pdfOpenedCallback({ name: displayName, data: buf, filePath: slug });
    } catch (err) { console.error('reopenLastBook failed', err); }
  }

  // ── Wake lock ─────────────────────────────────────────────────────────────

  let webWakeLock = null;
  async function requestWakeLock() {
    try { await KeepAwake.keepAwake(); return; } catch { }
    try {
      if ('wakeLock' in navigator) {
        webWakeLock = await navigator.wakeLock.request('screen');
        webWakeLock.addEventListener('release', () => { webWakeLock = null; });
      }
    } catch { }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !webWakeLock) requestWakeLock();
  });

  // ── The bridge ────────────────────────────────────────────────────────────
  window.api = {

    openDialog() { fileInput.click(); },

    onPdfOpened(callback) {
      pdfOpenedCallback = callback;
      reopenLastBook();
    },

    // Register the shared renderer's back-navigation handler for the Android
    // hardware/gesture back button. The renderer decides what "back" means
    // (close the topmost overlay, close the book, or exit the app); here we
    // just forward the event to it. We register with the native App plugin
    // once and delegate every press to the latest callback.
    onBackButton(callback) {
      backButtonCallback = callback;
      if (!backButtonRegistered) {
        backButtonRegistered = true;
        App.addListener('backButton', () => {
          if (backButtonCallback) backButtonCallback();
        });
      }
    },

    // Close the Android app (used for the double-back-to-exit on home).
    exitApp() {
      App.exitApp().catch(() => {});
    },

    rememberFile() { },

    async openFile(slug) {
      try {
        const buf = await readBinary(`${BOOKS_DIR}/${slug}.pdf`);
        if (!buf) { console.warn('openFile: PDF not found for', slug); return; }
        const meta = await readJson(`${META_DIR}/${slug}.meta.json`);
        const name = meta?.displayName || slug;
        await Preferences.set({ key: LAST_BOOK_KEY,  value: slug });
        await Preferences.set({ key: LAST_BOOK_NAME, value: name });
        if (pdfOpenedCallback) pdfOpenedCallback({ name, data: buf, filePath: slug });
      } catch (err) { console.error('openFile failed', err); }
    },

    // ── Annotations ──────────────────────────────────────────────────────────

    loadAnnotations(slug) {
      return readJson(`${META_DIR}/${slug}.json`);
    },

    async saveAnnotations(slug, data) {
      await writeJson(`${META_DIR}/${slug}.json`, data);
      const metaPath = `${META_DIR}/${slug}.meta.json`;
      const existing = await readJson(metaPath);
      if (!existing) {
        const { value: name } = await Preferences.get({ key: LAST_BOOK_NAME }).catch(() => ({ value: null }));
        const displayName = name ? displayFromName(name) : slug;
        await writeJson(metaPath, { displayName });
      }
      return true;
    },

    async listAnnotatedBooks(currentSlug) {
      try {
        const listing = await Filesystem.readdir({ path: META_DIR, directory: DIR });
        const results = [];
        for (const entry of listing.files) {
          const fname = entry.name || entry;
          if (!fname.endsWith('.json') || fname.endsWith('.meta.json') || fname.endsWith('.index.json')) continue;
          const slug = fname.replace(/\.json$/, '');
          if (slug === currentSlug) continue;
          try {
            const data = await readJson(`${META_DIR}/${fname}`);
            if (!data) continue;
            const hasStrokes = Object.values(data).some(arr => Array.isArray(arr) && arr.length > 0);
            if (!hasStrokes) continue;
            const meta = await readJson(`${META_DIR}/${slug}.meta.json`);
            results.push({ id: slug, displayName: meta?.displayName || slug });
          } catch { }
        }
        results.sort((a, b) => a.displayName.localeCompare(b.displayName));
        return results;
      } catch { return []; }
    },

    async copyAnnotations(fromSlug, toSlug) {
      try {
        const source = await readJson(`${META_DIR}/${fromSlug}.json`);
        if (!source) return false;
        const dest = (await readJson(`${META_DIR}/${toSlug}.json`)) || {};
        const merged = { ...source, ...dest };
        await writeJson(`${META_DIR}/${toSlug}.json`, merged);
        return true;
      } catch (err) { console.error('copyAnnotations failed', err); return false; }
    },

    importAnnotationsSidecar(slug) {
      return new Promise((resolve) => {
        jsonResolve = async (file) => {
          if (!file) { resolve({ success: false }); return; }
          try {
            const incoming = JSON.parse(await file.text());
            if (!incoming || typeof incoming !== 'object') { resolve({ success: false, error: 'Invalid JSON' }); return; }
            const existing = (await readJson(`${META_DIR}/${slug}.json`)) || {};
            const merged = { ...incoming, ...existing };
            await writeJson(`${META_DIR}/${slug}.json`, merged);
            resolve({ success: true });
          } catch (err) { resolve({ success: false, error: String(err) }); }
        };
        jsonInput.click();
      });
    },

    replaceAnnotationsFromFile(slug) {
      return new Promise((resolve) => {
        jsonResolve = async (file) => {
          if (!file) { resolve({ success: false }); return; }
          try {
            const incoming = JSON.parse(await file.text());
            if (!incoming || typeof incoming !== 'object') { resolve({ success: false, error: 'Invalid JSON' }); return; }
            await writeJson(`${META_DIR}/${slug}.json`, incoming);
            resolve({ success: true });
          } catch (err) { resolve({ success: false, error: String(err) }); }
        };
        jsonInput.click();
      });
    },

    // Open a JSON picker and RETURN the parsed annotations (without writing
    // anything). Mirrors the desktop 'loadAnnotationsFile' so the shared merge
    // flow — including the visual conflict resolver — works on mobile too.
    // Resolves to the parsed object, or null if cancelled/invalid.
    loadAnnotationsFile() {
      return new Promise((resolve) => {
        jsonResolve = async (file) => {
          if (!file) { resolve(null); return; }
          try {
            const data = JSON.parse(await file.text());
            if (!data || typeof data !== 'object' || Array.isArray(data)) { resolve(null); return; }
            resolve(data);
          } catch { resolve(null); }
        };
        jsonInput.click();
      });
    },

    async clearAnnotations(slug) {
      try { await writeJson(`${META_DIR}/${slug}.json`, {}); return true; }
      catch (err) { console.error('clearAnnotations failed', err); return false; }
    },

    loadIndex(slug)       { return readJson(`${META_DIR}/${slug}.index.json`); },
    saveIndex(slug, data) { return writeJson(`${META_DIR}/${slug}.index.json`, data); },

    loadPageImage(slug, sizeKey, page) {
      return readBinary(`${CACHE_DIR}/${slug}/${sizeKey}/${page}.webp`);
    },
    savePageImage(slug, sizeKey, page, bytes) {
      return writeBinary(`${CACHE_DIR}/${slug}/${sizeKey}/${page}.webp`, bytes);
    },
    async prunePageCache(slug, keepSizeKey) {
      try {
        const base = `${CACHE_DIR}/${slug}`;
        const listing = await Filesystem.readdir({ path: base, directory: DIR });
        for (const entry of listing.files) {
          const sk = entry.name || entry;
          if (sk !== String(keepSizeKey))
            await Filesystem.rmdir({ path: `${base}/${sk}`, directory: DIR, recursive: true });
        }
        return true;
      } catch { return false; }
    },

    async listRecentBooks() {
      const list = await getRecentBooks();
      const valid = [];
      for (const entry of list) {
        try {
          await Filesystem.stat({ path: `${BOOKS_DIR}/${entry.id}.pdf`, directory: DIR });
          valid.push({ filePath: entry.id, displayName: entry.displayName });
        } catch { /* file gone */ }
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
        const listing = await Filesystem.readdir({ path: base, directory: DIR });
        for (const entry of listing.files) {
          const sizeKey = entry.name || entry;
          const buf = await readBinary(`${base}/${sizeKey}/1.webp`);
          if (buf) return buf;
        }
        return null;
      } catch { return null; }
    },

    async checkHasAnnotations(slug) {
      try {
        const data = await readJson(`${META_DIR}/${slug}.json`);
        if (!data) return false;
        return Object.values(data).some(arr => Array.isArray(arr) && arr.length > 0);
      } catch { return false; }
    },

    async shareBook(slug, withAnnotations) {
      try {
        const meta = await readJson(`${META_DIR}/${slug}.meta.json`);
        const displayName = meta?.displayName || slug;
        const suffix = withAnnotations ? ' (with markups)' : '';

        const pdfBytes = await readBinary(`${BOOKS_DIR}/${slug}.pdf`);
        if (!pdfBytes) return { success: false, error: 'PDF not found' };

        await ensureDir(SHARE_DIR, CACHE_DIR_NATIVE);
        const sharePdfPath = `${SHARE_DIR}/${displayName}${suffix}.pdf`;
        await writeBinary(sharePdfPath, pdfBytes, CACHE_DIR_NATIVE);
        const { uri: pdfUri } = await Filesystem.getUri({ path: sharePdfPath, directory: CACHE_DIR_NATIVE });
        const files = [pdfUri];

        if (withAnnotations) {
          const annoData = await readJson(`${META_DIR}/${slug}.json`);
          if (annoData) {
            const shareAnnoPath = `${SHARE_DIR}/${displayName}.annotations.json`;
            await writeJson(shareAnnoPath, annoData, CACHE_DIR_NATIVE);
            const { uri: annoUri } = await Filesystem.getUri({ path: shareAnnoPath, directory: CACHE_DIR_NATIVE });
            files.push(annoUri);
          }
        }

        await Share.share({ title: displayName, dialogTitle: 'Share songbook', files });
        return { success: true };
      } catch (err) {
        if (String(err).includes('canceled')) return { success: false };
        console.error('shareBook failed', err);
        return { success: false, error: String(err) };
      }
    },
  };

  requestWakeLock();
}
