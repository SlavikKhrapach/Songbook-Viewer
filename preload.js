const { contextBridge, ipcRenderer } = require('electron');

// Secure bridge: expose only what the renderer needs.
contextBridge.exposeInMainWorld('api', {
  // Ask the main process to show the native open dialog
  openDialog: () => ipcRenderer.invoke('open-dialog'),

  // Ask the main process to open a specific file by path (library)
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),

  // Receive a PDF opened via CLI / dialog / last-file restore
  onPdfOpened: (callback) => {
    ipcRenderer.on('pdf-opened', (_event, payload) => callback(payload));
  },

  // Remember a file opened via drag & drop, for next-launch restore
  rememberFile: (filePath) => ipcRenderer.send('remember-file', filePath),

  // Annotation persistence (sidecar files keyed by PDF path)
  loadAnnotations: (pdfPath) => ipcRenderer.invoke('load-annotations', pdfPath),
  saveAnnotations: (pdfPath, data) => ipcRenderer.invoke('save-annotations', pdfPath, data),

  // Import-from-another-book prompt helpers
  listAnnotatedBooks: (currentPdfPath) => ipcRenderer.invoke('list-annotated-books', currentPdfPath),
  copyAnnotations: (fromId, toPdfPath) => ipcRenderer.invoke('copy-annotations', fromId, toPdfPath),

  // Cached page index (titles/numbers/languages) so re-opening is instant
  loadIndex: (pdfPath) => ipcRenderer.invoke('load-index', pdfPath),
  saveIndex: (pdfPath, data) => ipcRenderer.invoke('save-index', pdfPath, data),

  // Rendered-page image cache (so pages don't re-render every open)
  loadPageImage: (pdfPath, sizeKey, page) => ipcRenderer.invoke('load-page-image', pdfPath, sizeKey, page),
  savePageImage: (pdfPath, sizeKey, page, dataUrl) => ipcRenderer.invoke('save-page-image', pdfPath, sizeKey, page, dataUrl),
  prunePageCache: (pdfPath, keepSizeKey) => ipcRenderer.invoke('prune-page-cache', pdfPath, keepSizeKey),

  // Library / recent-books shelf
  listRecentBooks: () => ipcRenderer.invoke('list-recent-books'),
  removeRecentBook: (filePath) => ipcRenderer.invoke('remove-recent-book', filePath),
  getBookThumbnail: (filePath) => ipcRenderer.invoke('get-book-thumbnail', filePath),

  // Annotation presence check + sharing
  checkHasAnnotations: (filePath) => ipcRenderer.invoke('check-has-annotations', filePath),
  shareBook: (filePath, withAnnotations) => ipcRenderer.invoke('share-book', filePath, withAnnotations),

  // Manage markups: load a file, replace, or clear
  loadAnnotationsFile: () => ipcRenderer.invoke('load-annotations-file'),
  clearAnnotations: (filePath) => ipcRenderer.invoke('clear-annotations', filePath)
});
