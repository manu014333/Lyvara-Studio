const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── MJPEG stream ─────────────────────────────────────────────────────────
  // The renderer calls these to push frames to the Express MJPEG server
  // so OBS Browser Source can receive the video feed.
  pushMjpegFrame:      (dataUrl)  => ipcRenderer.send('push-mjpeg-frame', dataUrl),
  setMjpegStreamState: (live)     => ipcRenderer.send('mjpeg-stream-state', live),
  getMjpegUrl:         ()         => ipcRenderer.invoke('get-mjpeg-url'),

  // ── OBS combined output ───────────────────────────────────────────────────
  // /obs serves video + audio together in one browser source URL.
  getObsUrl:           ()         => ipcRenderer.invoke('get-obs-url'),

  // ── OBS audio relay ───────────────────────────────────────────────────────
  // When Voice FX is ON, processed audio chunks are sent here → /audio stream.
  pushAudioChunk:      (chunk)    => ipcRenderer.send('push-audio-chunk', chunk),
  resetAudioStream:    ()         => ipcRenderer.send('reset-audio-stream'),

  // ── Clipboard ─────────────────────────────────────────────────────────────
  copyToClipboard:     (text)     => ipcRenderer.invoke('copy-to-clipboard', text),
  // Opens a URL in the system browser — prevents new Electron windows
  openExternal:        (url)      => ipcRenderer.invoke('open-external', url),
  // Directly switches UI to login screen via main process — works even if renderer JS is broken
  forceLogout:         ()         => ipcRenderer.invoke('force-logout'),
  // Calls create-invoice via the main process (bypasses renderer networking sandbox)
  // Fetches session info (tier, apiKey, credits) via main-process Node.js fetch
  // — avoids CORS/preflight failures when called from the renderer
  getSessionInfo:      (params)   => ipcRenderer.invoke('get-session-info', params),
  createInvoice:       (params)   => ipcRenderer.invoke('create-invoice', params),


  // NOTE: getSessionInfo and createInvoice have been moved to Supabase Edge
  // Functions and are now called directly from the renderer via the Supabase
  // client. No IPC needed — secrets live exclusively on the server side.
});
