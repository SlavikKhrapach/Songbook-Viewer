const { app, BrowserWindow, ipcMain, dialog, Menu, powerSaveBlocker } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let mainWindow;

// ---------- Sleep prevention ----------
// Keep the display awake while Songbook Viewer is open, so the screen never
// dims or sleeps mid-song. 'prevent-display-sleep' also implies keeping the
// system awake. We guard against duplicate blockers and stop it on quit.
let powerBlockerId = null;
function startSleepPrevention() {
  try {
    if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) return;
    powerBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  } catch (err) {
    console.error('Could not start power save blocker:', err);
  }
}
function stopSleepPrevention() {
  try {
    if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) {
      powerSaveBlocker.stop(powerBlockerId);
    }
  } catch (err) {
    console.error('Could not stop power save blocker:', err);
  }
  powerBlockerId = null;
}

// ---------- Annotations (sidecar files, keyed by PDF path) ----------
function annotationsDir() {
  const dir = path.join(app.getPath('userData'), 'annotations');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}
// Derive a STABLE book key from a file path so annotations persist across
// songbook re-exports. We use the filename with the extension and common
// version/date tokens stripped, lowercased. E.g.
//   "Hymnal v0.5 (2024).pdf" -> "hymnal"
function bookKeyFromPath(pdfPath) {
  let name = path.basename(pdfPath || '', path.extname(pdfPath || ''));
  name = name.toLowerCase();
  // Remove version/date-ish trailing tokens: v1, v0.5, 2024, dates, (..), [..]
  name = name
    .replace(/[\(\[].*?[\)\]]/g, ' ')            // (2024), [draft]
    .replace(/\bv?\d+(?:[._]\d+)*\b/g, ' ')       // v0.5, 1.2.3, 2024
    .replace(/\b(rev|revision|ver|version|draft|final|copy|update|updated)\b/g, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return name || 'book';
}
function annotationFileFor(pdfPath) {
  const id = crypto.createHash('sha1').update(bookKeyFromPath(pdfPath)).digest('hex');
  return path.join(annotationsDir(), `${id}.json`);
}

// ---------- Settings (remember last opened PDF) ----------
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}
function writeSettings(patch) {
  try {
    const current = readSettings();
    fs.writeFileSync(settingsPath(), JSON.stringify({ ...current, ...patch }, null, 2));
  } catch (err) {
    console.error('Could not save settings:', err);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 850,
    minWidth: 400,
    minHeight: 400,
    backgroundColor: '#ffffff',
    title: 'Songbook Viewer',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // No application menu (removes the File / View bar).
  Menu.setApplicationMenu(null);

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Decide what to open on launch: a CLI file ("Open with") wins, otherwise
  // reopen the last file the user had open.
  const cliFile = process.argv.find(a => a.toLowerCase().endsWith('.pdf'));
  const last = readSettings().lastFile;
  const startFile = (cliFile && fs.existsSync(cliFile))
    ? cliFile
    : (last && fs.existsSync(last)) ? last : null;

  if (startFile) {
    mainWindow.webContents.once('did-finish-load', () => sendFile(startFile));
  }
}

async function openFileDialog() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open PDF',
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    properties: ['openFile']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    sendFile(result.filePaths[0]);
  }
}

// ---------- Recent-books list (persisted in settings.recentFiles) ----------
// Stores up to 20 entries: [{ filePath, displayName }, ...] newest-first.
const MAX_RECENT = 20;

function addRecentFile(filePath) {
  const displayName = path.basename(filePath, path.extname(filePath));
  const settings = readSettings();
  let recent = Array.isArray(settings.recentFiles) ? settings.recentFiles : [];
  // Remove any existing entry for the same path, then prepend the new one.
  recent = recent.filter(r => r.filePath !== filePath);
  recent.unshift({ filePath, displayName });
  if (recent.length > MAX_RECENT) recent = recent.slice(0, MAX_RECENT);
  writeSettings({ lastFile: filePath, recentFiles: recent });
}

function removeRecentFile(filePath) {
  const settings = readSettings();
  let recent = Array.isArray(settings.recentFiles) ? settings.recentFiles : [];
  recent = recent.filter(r => r.filePath !== filePath);
  // If we removed lastFile, update it to the next entry (or null).
  const patch = { recentFiles: recent };
  if (settings.lastFile === filePath) {
    patch.lastFile = recent.length ? recent[0].filePath : null;
  }
  writeSettings(patch);
}

function sendFile(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    mainWindow.webContents.send('pdf-opened', {
      name: path.basename(filePath),
      filePath,
      data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    });
    // Remember this file for next launch and update the recent list.
    addRecentFile(filePath);

    // Auto-import a .annotations.json sidecar if present next to the PDF.
    // This lets books shared from another device carry their markups along.
    const sidecarPath = filePath.replace(/\.pdf$/i, '.annotations.json');
    if (fs.existsSync(sidecarPath)) {
      try {
        const incoming = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
        const destFile = annotationFileFor(filePath);
        let existing = {};
        try { existing = JSON.parse(fs.readFileSync(destFile, 'utf8')); } catch { /* new book */ }
        // Merge: existing local marks take priority so we never overwrite local work.
        const merged = { ...incoming, ...existing };
        fs.writeFileSync(destFile, JSON.stringify(merged));
      } catch (err) {
        console.error('Could not auto-import annotations sidecar:', err);
      }
    }
  } catch (err) {
    dialog.showErrorBox('Could not open file', String(err));
  }
}

// Renderer can request the open dialog (e.g. the "Open" button / drop zone).
ipcMain.handle('open-dialog', () => openFileDialog());

// Renderer can request a specific file to be opened directly (library cards).
ipcMain.handle('open-file', (_e, filePath) => {
  if (filePath && typeof filePath === 'string') sendFile(filePath);
});

// Renderer reports a file opened via drag & drop so we can remember it too.
ipcMain.on('remember-file', (_e, filePath) => {
  if (filePath && typeof filePath === 'string') addRecentFile(filePath);
});

// ---------- Library / recent-books IPC ----------

// Return the full recent-books list, filtering out files that no longer exist.
ipcMain.handle('list-recent-books', () => {
  const settings = readSettings();
  const recent = Array.isArray(settings.recentFiles) ? settings.recentFiles : [];
  return recent.filter(r => r.filePath && fs.existsSync(r.filePath));
});

// Remove a single entry from the recent list (user clicks "×" on a card).
ipcMain.handle('remove-recent-book', (_e, filePath) => {
  removeRecentFile(filePath);
  return true;
});

// Return the first-page thumbnail for a book as an ArrayBuffer (WebP), or null.
// We look for any cached WebP for page 1 across all size-keys for this book.
ipcMain.handle('get-book-thumbnail', (_e, filePath) => {
  try {
    const id = crypto.createHash('sha1').update(bookKeyFromPath(filePath)).digest('hex');
    const bookDir = path.join(app.getPath('userData'), 'pagecache', id);
    if (!fs.existsSync(bookDir)) return null;
    // Pick the first available size-key folder.
    const sizeKeys = fs.readdirSync(bookDir);
    for (const sk of sizeKeys) {
      const imgPath = path.join(bookDir, sk, '1.webp');
      if (fs.existsSync(imgPath)) {
        const buf = fs.readFileSync(imgPath);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      }
    }
    return null;
  } catch {
    return null;
  }
});

// Load annotations for a given PDF (returns {} if none saved yet).
ipcMain.handle('load-annotations', (_e, pdfPath) => {
  try {
    return JSON.parse(fs.readFileSync(annotationFileFor(pdfPath), 'utf8'));
  } catch {
    return {};
  }
});

// Save annotations for a given PDF. Also writes a .meta.json sidecar with the
// display name so the import-from-another-book prompt can show readable titles.
ipcMain.handle('save-annotations', (_e, pdfPath, data) => {
  try {
    fs.writeFileSync(annotationFileFor(pdfPath), JSON.stringify(data));
    // Persist the human-readable filename alongside the hash so the import
    // dialog can show it. Only write if it doesn't already exist (keep the
    // original name, don't overwrite with a later alias).
    const metaFile = annotationFileFor(pdfPath).replace(/\.json$/, '.meta.json');
    if (!fs.existsSync(metaFile)) {
      const displayName = path.basename(pdfPath || '', path.extname(pdfPath || ''));
      fs.writeFileSync(metaFile, JSON.stringify({ displayName }));
    }
    return true;
  } catch (err) {
    console.error('Could not save annotations:', err);
    return false;
  }
});

// Return every book that has saved annotations (and at least one stroke),
// excluding the currently-open book. Used by the import-from prompt.
// Returns [{id, displayName}] sorted by displayName.
ipcMain.handle('list-annotated-books', (_e, currentPdfPath) => {
  try {
    const dir = annotationsDir();
    const currentId = crypto.createHash('sha1')
      .update(bookKeyFromPath(currentPdfPath || '')).digest('hex');
    const results = [];
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json') || file.endsWith('.meta.json') || file.endsWith('.index.json')) continue;
      const id = file.replace(/\.json$/, '');
      if (id === currentId) continue;           // skip the current book
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        // Only include books that actually have at least one stroke.
        const hasStrokes = Object.values(data).some(arr => Array.isArray(arr) && arr.length > 0);
        if (!hasStrokes) continue;
        // Read the display name from the meta file, fall back to the hash.
        let displayName = id;
        const metaPath = path.join(dir, `${id}.meta.json`);
        if (fs.existsSync(metaPath)) {
          displayName = JSON.parse(fs.readFileSync(metaPath, 'utf8')).displayName || id;
        }
        results.push({ id, displayName });
      } catch { /* skip unreadable files */ }
    }
    results.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return results;
  } catch {
    return [];
  }
});

// Copy annotations from another book (by id) into the current book.
// The annotations are merged by song key so neither book's unique marks are lost.
ipcMain.handle('copy-annotations', (_e, fromId, toPdfPath) => {
  try {
    const dir = annotationsDir();
    const sourceFile = path.join(dir, `${fromId}.json`);
    if (!fs.existsSync(sourceFile)) {
      console.warn('copy-annotations: source file not found:', sourceFile);
      return false;
    }
    const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    // Load the destination (may be empty for a brand-new book).
    const destFile = annotationFileFor(toPdfPath);
    let dest = {};
    try { dest = JSON.parse(fs.readFileSync(destFile, 'utf8')); } catch { /* new book */ }
    // Merge: destination keys take priority (don't overwrite existing marks).
    const merged = { ...source, ...dest };
    fs.writeFileSync(destFile, JSON.stringify(merged));
    return true;
  } catch (err) {
    console.error('Could not copy annotations:', err);
    return false;
  }
});

// Return true if the book has at least one saved stroke, false otherwise.
ipcMain.handle('check-has-annotations', (_e, pdfPath) => {
  try {
    const data = JSON.parse(fs.readFileSync(annotationFileFor(pdfPath), 'utf8'));
    return Object.values(data).some(arr => Array.isArray(arr) && arr.length > 0);
  } catch {
    return false;
  }
});

// Open a file picker and return the parsed contents of a .annotations.json file,
// or null if the user cancels or the file is invalid.
ipcMain.handle('load-annotations-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open annotations file',
    filters: [{ name: 'Annotations', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths.length) return null;
  try {
    const raw = fs.readFileSync(filePaths[0], 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data;
  } catch (err) {
    console.error('load-annotations-file: could not read file', err);
    return null;
  }
});

// Erase all annotations for a book (saves an empty object to disk).
ipcMain.handle('clear-annotations', (_e, pdfPath) => {
  try {
    fs.writeFileSync(annotationFileFor(pdfPath), JSON.stringify({}));
    return true;
  } catch (err) {
    console.error('clear-annotations failed:', err);
    return false;
  }
});

// Export a book for sharing:
//   - Always copies the PDF to a user-chosen location.
//   - If withAnnotations=true, also saves a <name>.annotations.json sidecar
//     next to the PDF so it can be auto-imported on another device.
// Returns { success, destPath } or { success: false, error }.
ipcMain.handle('share-book', async (_e, pdfPath, withAnnotations) => {
  const baseName = path.basename(pdfPath, path.extname(pdfPath));
  const defaultName = withAnnotations ? `${baseName} (with markups).pdf` : `${baseName}.pdf`;

  const { canceled, filePath: destPath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save songbook as…',
    defaultPath: defaultName,
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
  });
  if (canceled || !destPath) return { success: false };

  try {
    // Copy the PDF.
    fs.copyFileSync(pdfPath, destPath);

    // Optionally write the annotations sidecar alongside.
    if (withAnnotations) {
      const annoFile = annotationFileFor(pdfPath);
      if (fs.existsSync(annoFile)) {
        const sidecarPath = destPath.replace(/\.pdf$/i, '.annotations.json');
        fs.copyFileSync(annoFile, sidecarPath);
      }
    }

    return { success: true, destPath };
  } catch (err) {
    console.error('share-book failed:', err);
    return { success: false, error: String(err) };
  }
});

// ---------- Index cache (extracted titles/numbers/languages) ----------
function indexFileFor(pdfPath) {
  const id = crypto.createHash('sha1').update(bookKeyFromPath(pdfPath)).digest('hex');
  return path.join(annotationsDir(), `${id}.index.json`);
}
ipcMain.handle('load-index', (_e, pdfPath) => {
  try {
    return JSON.parse(fs.readFileSync(indexFileFor(pdfPath), 'utf8'));
  } catch {
    return null;
  }
});
ipcMain.handle('save-index', (_e, pdfPath, data) => {
  try {
    fs.writeFileSync(indexFileFor(pdfPath), JSON.stringify(data));
    return true;
  } catch (err) {
    console.error('Could not save index:', err);
    return false;
  }
});

// ---------- Rendered-page image cache ----------
// Cached page images live in a per-book folder, named by page + render size:
//   <userData>/pagecache/<bookId>/<sizeKey>/<page>.webp
// The sizeKey lets us keep separate caches per window size; stale sizes are
// simply never read (and cleaned up opportunistically).
function pageCacheDir(pdfPath, sizeKey) {
  const id = crypto.createHash('sha1').update(bookKeyFromPath(pdfPath)).digest('hex');
  const dir = path.join(app.getPath('userData'), 'pagecache', id, String(sizeKey));
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}
function pageImageFile(pdfPath, sizeKey, pageNum) {
  return path.join(pageCacheDir(pdfPath, sizeKey), `${pageNum}.webp`);
}

// Load a cached page image as binary bytes (ArrayBuffer), or null if missing.
// Binary transfer avoids the big base64 strings that caused memory spikes.
ipcMain.handle('load-page-image', (_e, pdfPath, sizeKey, pageNum) => {
  try {
    const buf = fs.readFileSync(pageImageFile(pdfPath, sizeKey, pageNum));
    // Return the underlying ArrayBuffer slice (structured-clone transfers it).
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch {
    return null;
  }
});

// Save a page image (given as binary bytes) to the cache.
ipcMain.handle('save-page-image', (_e, pdfPath, sizeKey, pageNum, bytes) => {
  try {
    fs.writeFileSync(pageImageFile(pdfPath, sizeKey, pageNum), Buffer.from(bytes));
    return true;
  } catch (err) {
    console.error('Could not save page image:', err);
    return false;
  }
});

// Remove page-cache folders for this book whose sizeKey isn't the current one,
// so old window sizes don't accumulate on disk.
ipcMain.handle('prune-page-cache', (_e, pdfPath, keepSizeKey) => {
  try {
    const id = crypto.createHash('sha1').update(bookKeyFromPath(pdfPath)).digest('hex');
    const bookDir = path.join(app.getPath('userData'), 'pagecache', id);
    if (!fs.existsSync(bookDir)) return true;
    for (const entry of fs.readdirSync(bookDir)) {
      if (entry !== String(keepSizeKey)) {
        fs.rmSync(path.join(bookDir, entry), { recursive: true, force: true });
      }
    }
    return true;
  } catch {
    return false;
  }
});

app.whenReady().then(() => {
  createWindow();
  startSleepPrevention();   // keep the screen awake while the app runs
});

app.on('window-all-closed', () => {
  stopSleepPrevention();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', stopSleepPrevention);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    startSleepPrevention();   // re-arm when reopening (macOS dock reactivate)
  }
});
