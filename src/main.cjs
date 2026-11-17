const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, screen, safeStorage, shell, powerMonitor, session } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { SettingsStore } = require('./settings.cjs');
const { CredentialVault } = require('./vault.cjs');
const { LiveTelegram } = require('./telegram.cjs');
const { DemoTelegram } = require('./demo.cjs');
const { ForegroundWatcher } = require('./platform.cjs');
const { errorText, placeBounds, chatId, UserError } = require('./model.cjs');

app.setName('Azeroth Relay');
if (process.platform === 'win32') app.setAppUserModelId('de.azerothrelay.desktop');
const testMode = process.env.AZEROTH_TEST === '1';
if (testMode) app.setPath('userData', process.env.AZEROTH_TEST_DIRECTORY || path.join(os.tmpdir(), `azeroth-relay-test-${process.pid}`));
const uiFile = path.join(__dirname, 'ui', 'index.html');
const toastFile = path.join(__dirname, 'ui', 'toast.html');
let win, toast, tray, store, vault, service, watcher;
let quitting = false, locked = false, hotkeyRegistered = false, passive = false;
let toastTimer, saveTimer, activeChat = null;
let game = { active: false, profile: null, own: false, available: false };

function push(type, value) {
  for (const window of [win, toast]) if (window && !window.isDestroyed()) window.webContents.send('relay:event', { type, value });
}
function state() {
  return { app: { version: app.getVersion(), platform: process.platform, packaged: app.isPackaged, hotkeyRegistered, passive, locked }, settings: store.value,
    telegram: service.snapshot(), game, monitors: screen.getAllDisplays().map(d => ({ id: String(d.id), label: d.label || `${d.size.width} × ${d.size.height}`, primary: d.id === screen.getPrimaryDisplay().id })) };
}
function display() { return screen.getAllDisplays().find(d => String(d.id) === store.value.monitor) || screen.getPrimaryDisplay(); }
function refreshState() { push('state', state()); updateTray(); }
function secureWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
}
function applyProfile() {
  const profile = store.value.profiles[store.value.profile];
  win.setBounds(placeBounds(profile.bounds, display().workArea, profile.compact));
  win.setOpacity(profile.opacity / 100);
  refreshState();
}
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  const key = store.value.profile;
  store.update({ profiles: { [key]: { ...store.value.profiles[key], bounds: win.getBounds() } } });
}
function showOverlay() {
  if (locked) return;
  passive = false; win.setIgnoreMouseEvents(false); win.setFocusable(true);
  toast.hide(); clearTimeout(toastTimer);
  win.show();
  if (process.platform === 'darwin') app.focus({ steal: true });
  win.focus(); refreshState(); push('focus-composer', null);
}
function hideOverlay() {
  passive = false; activeChat = null; win.setIgnoreMouseEvents(false); win.hide();
  // Hiding the application lets macOS return focus to the previously active app.
  if (process.platform === 'darwin') app.hide();
  refreshState();
}
function passiveOverlay() {
  passive = true; win.setFocusable(false); win.setIgnoreMouseEvents(true); win.blur(); refreshState();
}
function configureShortcuts(settings) {
  if (settings.hotkey === settings.quietHotkey) throw new UserError('Die beiden Tastenkürzel müssen unterschiedlich sein.');
  const old = store.value;
  globalShortcut.unregisterAll();
  try {
    if (!globalShortcut.register(settings.hotkey, () => win.isVisible() && !passive ? hideOverlay() : showOverlay())) throw new UserError('Das Overlay-Tastenkürzel ist belegt oder ungültig. Bitte ein anderes wählen.');
    if (!globalShortcut.register(settings.quietHotkey, () => { store.update({ quiet: !store.value.quiet }); toast.hide(); refreshState(); })) throw new UserError('Das Ruhemodus-Tastenkürzel ist belegt oder ungültig. Bitte ein anderes wählen.');
    hotkeyRegistered = true;
  } catch (error) {
    globalShortcut.unregisterAll();
    hotkeyRegistered = globalShortcut.register(old.hotkey, () => win.isVisible() && !passive ? hideOverlay() : showOverlay());
    globalShortcut.register(old.quietHotkey, () => { store.update({ quiet: !store.value.quiet }); refreshState(); });
    throw error;
  }
}
async function changeSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new UserError('Ungültige Einstellungen.');
  const allowed = ['profile', 'hotkey', 'quietHotkey', 'quiet', 'previews', 'notifications', 'autoHide', 'startAtLogin', 'favorites', 'onlyFavorites', 'monitor', 'profiles'];
  const selected = Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.includes(key)));
  const { sanitizeSettings } = require('./settings.cjs');
  const next = sanitizeSettings({ ...store.value, ...selected, profiles: { ...store.value.profiles, ...selected.profiles } });
  if (next.hotkey !== store.value.hotkey || next.quietHotkey !== store.value.quietHotkey) configureShortcuts(next);
  if (selected.startAtLogin !== undefined && next.startAtLogin !== store.value.startAtLogin) {
    if (!app.isPackaged) throw new UserError('Autostart ist erst in der installierten App verfügbar.');
    app.setLoginItemSettings({ openAtLogin: next.startAtLogin, openAsHidden: true, args: ['--background'] });
  }
  if (next.profile !== store.value.profile) { clearTimeout(saveTimer); saveBounds(); }
  store.update(selected);
  if (selected.profile || selected.profiles || selected.monitor) applyProfile();
  if (store.value.quiet || !store.value.notifications) toast.hide();
  refreshState(); return state();
}
function notify({ chatId: id, message }) {
  const prefs = store.value;
  if (message.outgoing || locked || prefs.quiet || !prefs.notifications || (prefs.autoHide && !game.active && !game.own)) return;
  const chat = service.snapshot().chats.find(c => c.id === id);
  if (!chat || chat.muted || (prefs.onlyFavorites && !prefs.favorites.includes(id))) return;
  if (win.isFocused() && activeChat === id && !passive) return;
  const area = display().workArea;
  toast.setBounds({ x: area.x + area.width - 388, y: area.y + 30, width: 360, height: 116 });
  toast.webContents.send('relay:event', { type: 'notification', value: { title: prefs.previews ? chat.title : 'Neue Nachricht', body: prefs.previews ? message.text.slice(0, 180) : 'Öffne Azeroth Relay, um sie zu lesen.', hotkey: prefs.hotkey, demo: service.mode === 'demo' } });
  toast.showInactive(); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.hide(), 5500);
}
function bindService(next) {
  service = next;
  service.on('state', () => refreshState());
  service.on('message', event => { push('message', event); notify(event); });
  service.on('edited', event => push('edited', event));
  service.on('deleted', event => push('deleted', event));
}
async function switchMode(demo) {
  await service.close(); service.removeAllListeners(); activeChat = null;
  bindService(demo ? new DemoTelegram() : new LiveTelegram(vault));
  refreshState(); await service.initialize(); return state();
}
function updateTray() {
  if (!tray || !store) return;
  const unread = service?.snapshot().chats.reduce((sum, c) => sum + c.unread, 0) || 0;
  tray.setToolTip(`Azeroth Relay${unread ? ` · ${unread} ungelesen` : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Chat öffnen', click: showOverlay },
    { label: `Profil: ${store.value.profile === 'retail' ? 'Retail' : 'Forever'}`, submenu: ['retail', 'forever'].map(p => ({ label: p === 'retail' ? 'Retail' : 'Forever', type: 'radio', checked: store.value.profile === p, click: () => changeSettings({ profile: p }).catch(() => {}) })) },
    { label: 'Ruhemodus', type: 'checkbox', checked: store.value.quiet, click: () => changeSettings({ quiet: !store.value.quiet }).catch(() => {}) },
    { type: 'separator' }, { label: 'Beenden', click: () => app.quit() },
  ]));
}

async function handle(action, payload) {
  switch (action) {
    case 'bootstrap': return state();
    case 'settings': return changeSettings(payload);
    case 'login': return service.beginLogin(payload);
    case 'answer': return service.answer(payload);
    case 'cancel-login': return service.cancelLogin();
    case 'demo': return switchMode(payload === true);
    case 'simulate': if (service.mode === 'demo') service.simulate(); return null;
    case 'chats': return service.loadChats(payload === true);
    case 'messages': {
      chatId(payload?.id); activeChat = payload.id;
      const before = payload.before == null ? undefined : Number(payload.before);
      if (before != null && (!Number.isSafeInteger(before) || before < 1)) throw new UserError('Ungültige Nachricht.');
      return service.messages(payload.id, before);
    }
    case 'send': if (!win.isFocused() || passive || locked) throw new UserError('Bitte zuerst das Chatfenster aktivieren.'); return service.send(payload);
    case 'read': {
      if (!win.isFocused() || passive || locked || payload?.id !== activeChat) return null;
      chatId(payload.id); const maxId = Number(payload.maxId);
      if (!Number.isSafeInteger(maxId) || maxId < 1) throw new UserError('Ungültige Lesebestätigung.');
      return service.markRead(payload.id, maxId);
    }
    case 'typing': if (win.isFocused() && !passive && !locked && service.typing) await service.typing(chatId(payload)); return null;
    case 'hide': hideOverlay(); return null;
    case 'passive': passiveOverlay(); return null;
    case 'open': {
      const urls = { api: 'https://my.telegram.org/apps', telegram: 'https://desktop.telegram.org/', help: 'https://core.telegram.org/api/obtaining_api_id' };
      if (!urls[payload]) throw new UserError('Unbekannter Link.');
      await shell.openExternal(urls[payload]); return null;
    }
    case 'logout': return service.logout();
    case 'reset-local': return service.resetLocal();
    case 'quit': app.quit(); return null;
    default: throw new UserError('Unbekannte Aktion.');
  }
}

async function createApp() {
  store = new SettingsStore(app.getPath('userData')); vault = new CredentialVault(app.getPath('userData'), safeStorage);
  bindService(process.argv.includes('--demo') ? new DemoTelegram() : new LiveTelegram(vault));
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const common = { frame: false, show: false, backgroundColor: '#10151e', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, devTools: !app.isPackaged || testMode } };
  win = new BrowserWindow({ ...common, width: 820, height: 680, minWidth: 460, minHeight: 520, alwaysOnTop: true, title: 'Azeroth Relay', icon: path.join(__dirname, '../assets/icon.png') });
  toast = new BrowserWindow({ ...common, width: 360, height: 116, resizable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true });
  for (const window of [win, toast]) {
    secureWindow(window); window.setAlwaysOnTop(true, 'floating');
    if (process.platform === 'darwin') window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: false });
  }
  toast.setIgnoreMouseEvents(true);
  ipcMain.handle('relay:invoke', async (event, request) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(uiFile).href) return { ok: false, error: 'Zugriff nicht erlaubt.' };
    if (!request || typeof request.action !== 'string') return { ok: false, error: 'Ungültige Anfrage.' };
    try { return { ok: true, value: await handle(request.action, request.payload) }; }
    catch (error) {
      return { ok: false, error: errorText(error) };
    }
  });
  win.on('close', event => { if (!quitting) { event.preventDefault(); hideOverlay(); } });
  win.on('focus', () => push('focus', true)); win.on('blur', () => push('focus', false));
  for (const event of ['moved', 'resized']) win.on(event, () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveBounds, 350); });
  screen.on('display-metrics-changed', applyProfile); screen.on('display-removed', applyProfile);
  try { configureShortcuts(store.value); } catch { hotkeyRegistered = false; }
  let trayImage = nativeImage.createFromPath(path.join(__dirname, '../assets/tray.png'));
  trayImage = trayImage.resize({ width: 18, height: 18 });
  if (process.platform === 'darwin') trayImage.setTemplateImage(true);
  tray = new Tray(trayImage); tray.on('click', showOverlay); updateTray();
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Azeroth Relay', submenu: [{ label: 'Chat öffnen', click: showOverlay }, { type: 'separator' }, { role: 'quit', label: 'Beenden' }] }, { role: 'editMenu', label: 'Bearbeiten' }]));
  watcher = new ForegroundWatcher();
  watcher.on('change', next => {
    game = { ...next, available: true };
    if (store.value.autoHide && service.status === 'ready' && !next.active && !next.own) { win.hide(); toast.hide(); }
    refreshState();
  });
  watcher.on('unavailable', () => { game = { ...game, available: false }; refreshState(); });
  if (!testMode) watcher.start();
  powerMonitor.on('lock-screen', () => { locked = true; win.hide(); toast.hide(); refreshState(); });
  powerMonitor.on('unlock-screen', () => { locked = false; refreshState(); });
  await Promise.all([win.loadFile(uiFile), toast.loadFile(toastFile)]);
  applyProfile();
  if (!process.argv.includes('--background')) showOverlay();
  // Network/auth initialization never blocks window creation.
  service.initialize().catch(() => { push('notice', 'Telegram konnte noch nicht verbunden werden. Bitte die Anmeldung prüfen.'); });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.whenReady().then(createApp).catch(() => { console.error('Azeroth Relay konnte nicht gestartet werden.'); app.quit(); });
  app.on('second-instance', () => { if (win) showOverlay(); });
  app.on('activate', () => { if (win) showOverlay(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => {
    quitting = true; clearTimeout(toastTimer); clearTimeout(saveTimer); if (win) saveBounds();
    globalShortcut.unregisterAll(); watcher?.stop(); service?.close().catch(() => {});
  });
}
