// Aventra Service Desk — desktop app. Opens your Aventra ITSM server (cloud or on-prem) in its own
// window with a tray icon, Windows notifications for new ticket activity, and start-at-login.
const { app, BrowserWindow, Tray, Menu, Notification, shell, ipcMain, nativeImage, net, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const APP_ID = 'org.aventratech.itsm.desktop';
const POLL_MS = 45_000;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

let win = null; let setupWin = null; let tray = null; let pollTimer = null;
let settings = { serverUrl: '', bounds: null, lastNotificationId: 0, trayHintShown: false };
let quitting = false; let unread = 0;

function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { /* first run */ }
}
function saveSettings() {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch (e) { console.error(e); }
}

function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter your service desk address.');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https addresses are supported.');
  return u.origin;
}

// Only the configured server may load inside the app; everything else opens in the default browser.
const sameOrigin = (url) => { try { return new URL(url).origin === settings.serverUrl; } catch { return false; } };
function openExternal(url) {
  try { const u = new URL(url); if (['http:', 'https:', 'mailto:'].includes(u.protocol)) shell.openExternal(u.href); } catch { /* ignore */ }
}

function createMainWindow() {
  const b = settings.bounds || { width: 1360, height: 880 };
  win = new BrowserWindow({
    ...b, minWidth: 900, minHeight: 600, show: false, title: 'Aventra Service Desk',
    icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true, backgroundColor: '#f9f9f7',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: true },
  });
  win.once('ready-to-show', () => win.show());
  // Links that try to open a new window: our own pages stay in this window, anything else goes to the browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) win.loadURL(url); else openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!sameOrigin(url)) { e.preventDefault(); openExternal(url); } });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = aborted (normal during navigation)
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(offlinePage(desc))}`);
  });
  win.on('close', (e) => {
    settings.bounds = win.getBounds(); saveSettings();
    if (!quitting) {
      e.preventDefault(); win.hide();
      if (!settings.trayHintShown && Notification.isSupported()) {
        new Notification({ title: 'Aventra Service Desk is still running', body: 'You\'ll get notifications for ticket updates. Right-click the tray icon to quit.' }).show();
        settings.trayHintShown = true; saveSettings();
      }
    }
  });
  win.on('focus', () => win.flashFrame(false));
  win.loadURL(settings.serverUrl);
}

function offlinePage(reason) {
  const safe = String(reason).replace(/[<>&"]/g, '');
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <body style="font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f9f9f7;color:#0b0b0b">
  <div style="text-align:center;max-width:420px"><h2>Can't reach the service desk</h2>
  <p style="color:#52514e">${safe}</p><p style="color:#52514e">Check your connection, then choose <b>Reload</b> from the tray menu (or press Ctrl+R).
  To use a different server, choose <b>Change server…</b> from the tray menu.</p></div></body>`;
}

function createSetupWindow() {
  if (setupWin) { setupWin.focus(); return; }
  setupWin = new BrowserWindow({
    width: 540, height: 540, resizable: false, maximizable: false, title: 'Connect to your service desk',
    icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, 'preload-setup.js') },
  });
  setupWin.loadFile(path.join(__dirname, 'setup.html'), { query: { current: settings.serverUrl || '' } });
  setupWin.webContents.on('will-navigate', (e) => e.preventDefault());
  setupWin.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  setupWin.on('closed', () => { setupWin = null; if (!settings.serverUrl) app.quit(); });
}

// Setup page: validate the address by calling the server's health endpoint, then save it.
ipcMain.handle('setup:connect', async (_e, input) => {
  const origin = normalizeUrl(input);
  let ok = false; let detail = '';
  try {
    const r = await net.fetch(`${origin}/api/health`, { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    ok = r.ok && j.ok === true; detail = ok ? '' : `The server answered with status ${r.status}.`;
  } catch (e) { detail = e.message; }
  if (!ok) throw new Error(`That doesn't look like an Aventra ITSM server. ${detail}`.trim());
  const changed = settings.serverUrl !== origin;
  settings.serverUrl = origin; settings.lastNotificationId = changed ? 0 : settings.lastNotificationId; saveSettings();
  if (setupWin) { const s = setupWin; setupWin = null; s.close(); }
  if (!win) createMainWindow(); else win.loadURL(origin);
  win.show();
  startPolling(); buildTrayMenu();
  return { ok: true, origin };
});

// Poll for new notifications from inside the signed-in page (uses the page's own session cookie).
async function poll() {
  if (!win || win.isDestroyed() || !sameOrigin(win.webContents.getURL())) return;
  let list;
  try {
    list = await win.webContents.executeJavaScript(
      "fetch('/api/notifications', { credentials: 'same-origin', headers: { 'X-Requested-With': 'itsm' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null)", true);
  } catch { return; }
  if (!Array.isArray(list)) return; // signed out or offline
  const fresh = list.filter((n) => !n.read_at && Number(n.id) > settings.lastNotificationId).sort((a, b) => Number(a.id) - Number(b.id));
  unread = list.filter((n) => !n.read_at).length;
  if (fresh.length) {
    const first = settings.lastNotificationId === 0; // don't flood on first sign-in
    settings.lastNotificationId = Math.max(...list.map((n) => Number(n.id)));
    saveSettings();
    if (!first && Notification.isSupported()) {
      for (const n of fresh.slice(-3)) {
        const note = new Notification({ title: n.number ? `Aventra · ${n.number}` : 'Aventra Service Desk', body: n.message, icon: path.join(__dirname, 'icon.png') });
        note.on('click', () => { win.show(); win.focus(); if (n.ticket_id) win.loadURL(`${settings.serverUrl}/#/tickets/${n.ticket_id}`); });
        note.show();
      }
      if (!win.isFocused()) win.flashFrame(true);
    }
  }
  updateTray();
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, POLL_MS);
  setTimeout(poll, 8000);
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(unread ? `Aventra Service Desk — ${unread} unread` : 'Aventra Service Desk');
  buildTrayMenu();
}

function buildTrayMenu() {
  if (!tray) return;
  const login = app.getLoginItemSettings();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Aventra Service Desk', click: () => { if (win) { win.show(); win.focus(); } else if (settings.serverUrl) createMainWindow(); } },
    { label: unread ? `${unread} unread notification${unread === 1 ? '' : 's'}` : 'No unread notifications', enabled: false },
    { type: 'separator' },
    { label: 'Reload', click: () => win && win.loadURL(settings.serverUrl) },
    { label: `Server: ${settings.serverUrl ? new URL(settings.serverUrl).host : 'not set'}`, enabled: false },
    { label: 'Change server…', click: createSetupWindow },
    { label: 'Start when I sign in to Windows', type: 'checkbox', checked: login.openAtLogin,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function appMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ label: 'Change server…', click: createSetupWindow }, { type: 'separator' }, { label: 'Quit', accelerator: 'Ctrl+Q', click: () => { quitting = true; app.quit(); } }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [
      { label: 'Back', accelerator: 'Alt+Left', click: () => win?.webContents.navigationHistory.goBack() },
      { label: 'Forward', accelerator: 'Alt+Right', click: () => win?.webContents.navigationHistory.goForward() },
      { label: 'Reload', accelerator: 'Ctrl+R', click: () => win?.loadURL(win.webContents.getURL().startsWith('data:') ? settings.serverUrl : win.webContents.getURL()) },
      { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' },
      ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
    ] },
    { label: 'Help', submenu: [
      { label: 'Open in browser', click: () => settings.serverUrl && openExternal(win?.webContents.getURL().startsWith('http') ? win.webContents.getURL() : settings.serverUrl) },
      { label: 'About', click: () => dialog.showMessageBox({ type: 'info', title: 'Aventra Service Desk', message: `Aventra Service Desk ${app.getVersion()}`, detail: `Connected to ${settings.serverUrl || '—'}\n© Aventra Tech`, icon: nativeImage.createFromPath(path.join(__dirname, 'icon.png')) }) },
    ] },
  ]));
}

// ---- lifecycle
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); if (win.isMinimized()) win.restore(); win.focus(); } else if (setupWin) setupWin.focus(); });
  app.setAppUserModelId(APP_ID); // required for Windows toast notifications
  app.whenReady().then(() => {
    loadSettings();
    appMenu();
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')));
    tray.on('click', () => { if (win) { win.isVisible() && win.isFocused() ? win.hide() : (win.show(), win.focus()); } });
    buildTrayMenu(); updateTray();
    if (!settings.serverUrl) { createSetupWindow(); return; }
    createMainWindow();
    if (process.argv.includes('--hidden')) win.once('ready-to-show', () => win.hide());
    startPolling();
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', (e) => e.preventDefault()); // keep running in the tray
  // Harden: block unexpected webviews and permission prompts except notifications
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (ev) => ev.preventDefault());
    contents.session.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'notifications' || permission === 'clipboard-sanitized-write'));
  });
}
