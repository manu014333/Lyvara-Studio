import { app, BrowserWindow, ipcMain, shell, clipboard } from 'electron';
import path       from 'path';
import { fileURLToPath } from 'url';
import express    from 'express';
import cors       from 'cors';
// Admin is web-only (Cloudflare Workers) — no admin IPC handlers needed in Electron

// Enable SharedArrayBuffer (needed by RNNoise WASM) without COEP.
// COEP via onHeadersReceived reliably blocked Google Fonts and Supabase in
// Electron regardless of workarounds. The CLI flag is the correct approach:
// it re-enables SharedArrayBuffer in the renderer without requiring any
// cross-origin isolation headers on the page or external resources.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

// VERSION MARKER — check PowerShell/terminal for this line after npm start
// If you don't see it, the old main.js is still running.
console.log('[LYVARA MAIN] v2506.30 loaded');
console.log('[LYVARA MAIN] Admin → ' + 'https://nodeflow-admin.manupeters1147.workers.dev/admin');

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

let mainWindow = null;


// ═══════════════════════════════════════════════════════════════════════════
// MJPEG + VENDOR STATIC SERVER  (port 4444)
//
// /stream   — MJPEG multipart stream
// /audio    — WebM/Opus audio stream for OBS
// /obs      — HTML page combining video + audio for OBS Browser Source
// /status   — JSON status
// /vendor/* — WASM/worklet files served from node_modules
// ═══════════════════════════════════════════════════════════════════════════
const MJPEG_PORT   = 4444;
const mjpegClients = new Set();
let   mjpegLive    = false;

// Module-scope so IPC handlers outside startMjpegServer() can access them
const placeholderJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDB' +
  'kSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAAR' +
  'CAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAA' +
  'AAAAAAAAAAAAAP/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAA' +
  'AAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=', 'base64'
);

function writeMjpegFrame(res, jpegBuf) {
  const hdr = `--LV_FRAME\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpegBuf.length}\r\n\r\n`;
  res.write(hdr);
  res.write(jpegBuf);
  res.write('\r\n');
}

let lastFrameTs = 0;

// Latest JPEG frame — served via /snapshot.jpg for OBS canvas polling
let latestJpegBuf  = null; // set to placeholderJpeg after server starts

// Audio streaming state
const audioClients = new Set();
let audioInitBuf   = Buffer.alloc(0);
let audioInitReady = false;
const AUDIO_INIT_BYTES = 8192;

function startMjpegServer() {
  const srv = express();
  srv.use(cors({ origin: '*' }));

  // Vendor WASM / worklet files
  const rbDir = path.join(__dirname, 'node_modules', 'rubberband-web', 'src');
  srv.use('/vendor/rubberband-web', express.static(rbDir, {
    setHeaders: (res) => {
      res.set('Cross-Origin-Resource-Policy', 'cross-origin');
      res.set('Content-Type', 'application/javascript');
    },
  }));

  const rnnoiseDir = path.join(__dirname, 'node_modules', '@timephy', 'rnnoise-wasm', 'build');
  srv.use('/vendor/rnnoise', (req, res, next) => {
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  }, express.static(rnnoiseDir));

  // MJPEG stream
  srv.get('/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type':  'multipart/x-mixed-replace; boundary=LV_FRAME',
      'Cache-Control': 'no-store, no-cache',
      'Pragma':        'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    if (placeholderJpeg) writeMjpegFrame(res, placeholderJpeg);
    mjpegClients.add(res);
    req.on('close', () => mjpegClients.delete(res));
  });

  // Status
  srv.get('/status', (_req, res) => res.json({
    live: mjpegLive,
    clients: mjpegClients.size,
    audioClients: audioClients.size,
  }));

  // /snapshot.jpg — latest single JPEG frame.
  // Used by the /obs canvas-polling page. Much more reliable in OBS CEF
  // than multipart/x-mixed-replace in <img> tags.
  srv.get('/snapshot.jpg', (_req, res) => {
    const buf = latestJpegBuf || placeholderJpeg;
    res.writeHead(200, {
      'Content-Type':  'image/jpeg',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma':        'no-cache',
      'Access-Control-Allow-Origin': '*',
      'Content-Length': buf.length,
    });
    res.end(buf);
  });

  // Audio stream
  srv.get('/audio', (req, res) => {
    res.writeHead(200, {
      'Content-Type':      'audio/webm;codecs=opus',
      'Transfer-Encoding': 'chunked',
      'Cache-Control':     'no-cache, no-store',
      'Connection':        'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    if (audioInitReady && audioInitBuf.length > 0) res.write(audioInitBuf);
    audioClients.add(res);
    req.on('close', () => audioClients.delete(res));
  });

  // OBS page — canvas + fetch polling instead of <img src="/stream">
  // OBS CEF does not reliably handle multipart/x-mixed-replace in <img> tags,
  // which causes the broken image icon. The canvas approach fetches individual
  // JPEG snapshots and draws them — universally compatible with all CEF versions.
  srv.get('/obs', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
  html,body{width:100%;height:100%;background:#000;overflow:hidden}
  canvas{display:block;width:100%;height:100%;}
</style>
</head>
<body>
<canvas id="c"></canvas>
<audio id="aud" autoplay playsinline></audio>
<script>
(function() {
  const canvas = document.getElementById('c');
  const ctx    = canvas.getContext('2d');
  const TARGET_MS = 40; // 25 fps

  // Initialise canvas to a safe size — will resize to first frame dimensions
  canvas.width  = 1280;
  canvas.height = 720;

  // Draw a "Connecting…" placeholder so OBS doesn't show a black screen
  ctx.fillStyle = '#07080c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(99,102,241,0.6)';
  ctx.font = 'bold 32px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Lyvara Studio', canvas.width / 2, canvas.height / 2 - 20);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.font = '18px sans-serif';
  ctx.fillText('Connecting to stream…', canvas.width / 2, canvas.height / 2 + 20);

  async function fetchAndDraw() {
    const t0 = Date.now();
    try {
      // Fetch a single JPEG snapshot — cache-busted so we always get the latest
      const res  = await fetch('/snapshot.jpg?t=' + Date.now(), { cache: 'no-store' });
      const blob = await res.blob();
      const bmp  = await createImageBitmap(blob);

      // Resize canvas to match frame if needed (happens on first real frame)
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width  = bmp.width;
        canvas.height = bmp.height;
      }

      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close();
    } catch (e) {
      // Network error or server not ready — just wait and retry
    }
    const elapsed = Date.now() - t0;
    setTimeout(fetchAndDraw, Math.max(0, TARGET_MS - elapsed));
  }

  fetchAndDraw();

  // Audio relay — Voice FX processed audio from /audio endpoint
  function connectAudio() {
    const a = document.getElementById('aud');
    a.src = '/audio?' + Date.now();
    a.onerror = () => setTimeout(connectAudio, 1500);
    a.onended = () => setTimeout(connectAudio, 500);
    a.onpause = () => { if (!a.ended) a.play().catch(()=>{}); };
    a.play().catch(() => {});
  }
  connectAudio();
})();
</script>
</body>
</html>`);
  });

  srv.listen(MJPEG_PORT, '127.0.0.1', () => {
    latestJpegBuf = placeholderJpeg; // serve placeholder until first real frame
    console.log(`🎥 MJPEG server → http://localhost:${MJPEG_PORT}/stream`);
    console.log(`📷 Snapshot   → http://localhost:${MJPEG_PORT}/snapshot.jpg`);
    console.log(`📺 OBS Source → http://localhost:${MJPEG_PORT}/obs`);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// IPC — AUDIO RELAY
// ═══════════════════════════════════════════════════════════════════════════
ipcMain.on('push-audio-chunk', (_e, chunk) => {
  const buf = Buffer.from(chunk);
  if (!audioInitReady) {
    audioInitBuf = Buffer.concat([audioInitBuf, buf]);
    if (audioInitBuf.length >= AUDIO_INIT_BYTES) audioInitReady = true;
  }
  for (const res of audioClients) {
    try { res.write(buf); } catch { audioClients.delete(res); }
  }
});

ipcMain.on('reset-audio-stream', () => {
  audioInitBuf   = Buffer.alloc(0);
  audioInitReady = false;
  for (const res of audioClients) { try { res.end(); } catch {} }
  audioClients.clear();
});

// ═══════════════════════════════════════════════════════════════════════════
// IPC — MJPEG
// ═══════════════════════════════════════════════════════════════════════════
ipcMain.on('push-mjpeg-frame', (_e, dataUrl) => {
  const b64 = dataUrl.split(',')[1]; if (!b64) return;
  const buf = Buffer.from(b64, 'base64');
  latestJpegBuf = buf;          // always cache — serves /snapshot.jpg even with no MJPEG clients
  lastFrameTs   = Date.now();
  for (const res of mjpegClients) {
    try { writeMjpegFrame(res, buf); } catch { mjpegClients.delete(res); }
  }
});
ipcMain.on('mjpeg-stream-state', (_e, live) => { mjpegLive = !!live; });
ipcMain.handle('get-mjpeg-url', () => `http://localhost:${MJPEG_PORT}/stream`);
ipcMain.handle('get-obs-url',   () => `http://localhost:${MJPEG_PORT}/obs`);
ipcMain.handle('copy-to-clipboard', (_e, text) => { clipboard.writeText(String(text)); return true; });
// Force-logout: switches DOM AND clears the Supabase localStorage session
// so the user stays logged out on next app reload
ipcMain.handle('force-logout', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      await mainWindow.webContents.executeJavaScript(`
        (function() {
          // 1. Switch UI immediately
          const app  = document.getElementById('appContainer');
          const auth = document.getElementById('authContainer');
          const em   = document.getElementById('authEmail');
          const pw   = document.getElementById('authPassword');
          if (app)  app.style.display  = 'none';
          if (auth) auth.classList.remove('hidden');
          if (em)   em.value  = '';
          if (pw)   pw.value  = '';

          // 2. Clear ALL Supabase session keys from localStorage.
          //    Supabase stores session as 'sb-<ref>-auth-token'.
          //    Without this, onAuthStateChange re-logs in from cache on next reload.
          Object.keys(localStorage)
            .filter(k => k.startsWith('sb-'))
            .forEach(k => { localStorage.removeItem(k); });

          // 3. Tell the Supabase client to sign out (clears in-memory session too).
          //    Fire-and-forget — don't await, the localStorage is already cleared.
          if (typeof supabase !== 'undefined') {
            supabase.auth.signOut().catch(() => {});
            supabase.removeAllChannels();
          }
        })()
      `);
      console.log('[LYVARA MAIN] force-logout: DOM switched + localStorage cleared');
    } catch(e) {
      console.error('[LYVARA MAIN] force-logout error:', e.message);
    }
  }
  return true;
});

// Opens a URL in the user's default system browser
ipcMain.handle('open-external', (_e, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url);
    return true;
  }
  return false;
});

// create-invoice — called from renderer but executed here in the main process
// (Node.js) so it bypasses all renderer sandbox / CORS restrictions entirely.
// The renderer passes its JWT and the public Supabase config; we make the
// actual HTTPS request using Node's native fetch.
// session-info IPC — fetches the user's tier, Decart API key, and credits
// via Node.js so it bypasses renderer CORS/preflight issues entirely.
// index.html fetchSessionState() calls this instead of supabase.functions.invoke
ipcMain.handle('get-session-info', async (_e, { supabaseUrl, supabaseAnonKey, jwt }) => {
  try {
    const url = supabaseUrl || 'https://uieuplmjhqezsvplznyh.supabase.co';
    const key = supabaseAnonKey || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVpZXVwbG1qaHFlenN2cGx6bnloIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0NjA0OTksImV4cCI6MjA5NTAzNjQ5OX0.FvJ9vKY3GJLiAUhm1Jf0cIJTsc22Dht9icpkVHNC24I';
    console.log('[main:session-info] fetching for jwt=' + (jwt ? jwt.substring(0,20)+'...' : 'MISSING'));
    const resp = await fetch(`${url}/functions/v1/session-info`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'apikey':        key,
        'Content-Type':  'application/json',
      },
    });
    const data = await resp.json().catch(() => ({}));
    console.log('[main:session-info] status=' + resp.status + ' ok=' + data.ok);
    return { ok: resp.ok, status: resp.status, data };
  } catch(err) {
    console.error('[main:session-info] error:', err.message);
    return { ok: false, status: 0, data: { error: err.message } };
  }
});

ipcMain.handle('create-invoice', async (_e, params) => {
  try {
    // Accept both new format { supabaseUrl, supabaseAnonKey, jwt, usdAmount, runtimeCredits }
    // and old format { usdAmount, runtimeCredits, userId } — reads URL/key from .env as fallback
    const supabaseUrl     = params.supabaseUrl     || 'https://uieuplmjhqezsvplznyh.supabase.co';
    const supabaseAnonKey = params.supabaseAnonKey || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVpZXVwbG1qaHFlenN2cGx6bnloIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0NjA0OTksImV4cCI6MjA5NTAzNjQ5OX0.FvJ9vKY3GJLiAUhm1Jf0cIJTsc22Dht9icpkVHNC24I';
    const jwt             = params.jwt             || ''; // renderer must pass a valid JWT
    const usdAmount       = Number(params.usdAmount);
    const runtimeCredits  = Number(params.runtimeCredits);

    console.log(`[main:create-invoice] url=${supabaseUrl} jwt=${jwt ? jwt.substring(0,20)+'...' : 'MISSING'} amount=${usdAmount}`);

    if (!supabaseUrl) { return { ok: false, status: 0, data: { error: 'SUPABASE_URL not configured — set it in .env' } }; }
    if (!jwt)         { return { ok: false, status: 0, data: { error: 'No JWT — user must be signed in' } }; }

    const resp = await fetch(`${supabaseUrl}/functions/v1/create-invoice`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'apikey':        supabaseAnonKey,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ usdAmount, runtimeCredits }),
    });
    const data = await resp.json().catch(() => ({}));
    console.log('[main:create-invoice] status:', resp.status, 'data:', JSON.stringify(data));
    return { ok: resp.ok, status: resp.status, data };
  } catch (err) {
    console.error('[main:create-invoice] error:', err.message);
    return { ok: false, status: 0, data: { error: err.message } };
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// WINDOW
// ═══════════════════════════════════════════════════════════════════════════
// Admin is a web app at Cloudflare Workers — open in browser, no local window needed.
// No service role key or sensitive credentials are needed in the Electron app.
function openAdminInBrowser() {
  shell.openExternal('https://nodeflow-admin.manupeters1147.workers.dev/admin');
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1300, height: 900, backgroundColor: '#080810',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration:  false,
      webSecurity: false, // Electron desktop — no CORS enforcement
      allowRunningInsecureContent: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Startup diagnostic — logs key info to PowerShell so you can verify what's loaded
  mainWindow.webContents.once('did-finish-load', async () => {
    try {
      const d = await mainWindow.webContents.executeJavaScript(`({
        rendererVersion: document.documentElement.dataset.lyvaraVersion || 'NONE',
        hasLogoutBtn:    !!document.getElementById('logoutBtn'),
        hasInvoiceFrame: !!document.getElementById('invoiceFrame'),
        createInvoice:   typeof window.electronAPI?.createInvoice,
        forceLogout:     typeof window.electronAPI?.forceLogout,
        supabaseUrl:     typeof window.__sbUrl !== 'undefined' ? window.__sbUrl.substring(0,40) : 'check index.html',
      })`);
      console.log('[LYVARA MAIN] renderer check:', JSON.stringify(d));
    } catch(e) {
      console.error('[LYVARA MAIN] diagnostic error:', e.message);
    }
  });

  // All target="_blank" links and window.open() calls open in the system browser,
  // not a new Electron window. Prevents the "childish" new-window behaviour.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if ((input.control || input.meta) && input.shift && input.key === 'A') openAdminInBrowser();
  });
}

app.whenReady().then(() => {
  createMainWindow();
  startMjpegServer();

  // Keepalive: send placeholder if no real frames for 2s
  setInterval(() => {
    if (!mjpegClients.size) return;
    if (Date.now() - lastFrameTs > 2000) {
      for (const res of mjpegClients) {
        try { writeMjpegFrame(res, placeholderJpeg); } catch { mjpegClients.delete(res); }
      }
    }
  }, 1000);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
