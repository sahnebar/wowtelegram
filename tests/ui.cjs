const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'azeroth-ui-'));
  // Do not contend with the global bindings of a user's running app.
  const testHotkey = 'CommandOrControl+Alt+F8', testQuietHotkey = 'CommandOrControl+Alt+F9';
  await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ hotkey: testHotkey, quietHotkey: testQuietHotkey }));
  await fs.mkdir('test-results', { recursive: true });
  const environment = { ...process.env, AZEROTH_TEST: '1', AZEROTH_TEST_DIRECTORY: directory };
  delete environment.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({ executablePath: require('electron'), args: [path.resolve('.'), '--demo'], env: environment, timeout: 30000 });
  const errors = [];
  try {
    await application.firstWindow();
    const page = application.windows().find(window => window.url().endsWith('/index.html')) || await application.waitForEvent('window', { predicate: window => window.url().endsWith('/index.html') });
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('#chat-view').waitFor({ state: 'visible' });
    await page.locator('#chat-title').filter({ hasText: 'Mara' }).waitFor();
    const focused = await application.evaluate(({ BrowserWindow, app }) => new Promise(resolve => {
      const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'));
      window.once('focus', () => resolve(true)); window.show(); if (process.platform === 'darwin') app.focus({ steal: true }); window.focus();
      setTimeout(() => resolve(window.isFocused()), 1000);
    }));
    assert.equal(focused, true, 'Desktop UI tests require a native focused window');
    const native = await application.evaluate(({ BrowserWindow, globalShortcut }) => {
      const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'));
      return { onTop: window.isAlwaysOnTop(), shortcut: globalShortcut.isRegistered('CommandOrControl+Alt+F8'), sandbox: window.webContents.getLastWebPreferences().sandbox, node: window.webContents.getLastWebPreferences().nodeIntegration };
    });
    assert.equal(native.onTop, true); assert.equal(native.shortcut, true); assert.equal(native.sandbox, true); assert.equal(native.node, false);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    await page.screenshot({ path: 'test-results/01-chat.png' });

    // Real preload IPC + main process + demo adapter, including safe handling of untrusted text.
    await page.locator('#message-input').fill('<img src=x onerror=alert(1)> Grüße aus Azeroth 🌙');
    await page.locator('#send-button').click();
    await page.locator('.message-text').filter({ hasText: '<img src=x onerror=alert(1)> Grüße aus Azeroth 🌙' }).waitFor();
    assert.equal(await page.locator('#messages img').count(), 0);
    assert.equal(await page.locator('#message-input').inputValue(), '');
    await page.locator('.reply-action').first().focus(); await page.locator('.reply-action').first().click();
    await page.locator('#reply-preview').waitFor({ state: 'visible' });
    await page.locator('#message-input').fill('Antwort auf deine Nachricht.'); await page.locator('#send-button').click();
    await page.locator('.quote-block').last().waitFor();

    // Per-chat drafts and favorites survive view changes.
    await page.locator('#message-input').fill('Mein ungesendeter Entwurf');
    await page.locator('[data-chat-id="103"]').click();
    await page.locator('[data-chat-id="101"]').click();
    assert.equal(await page.locator('#message-input').inputValue(), 'Mein ungesendeter Entwurf');
    await page.locator('#favorite-button').click();
    await page.locator('#filter-favorites').click();
    assert.equal(await page.locator('.chat-item').count(), 1);
    await page.locator('#filter-all').click();

    // Privacy: passive notification must not expose the sender or text by default.
    await page.locator('[data-chat-id="103"]').click();
    await page.evaluate(() => window.relay.simulate());
    const toast = (await application.windows()).find(window => window !== page);
    await toast.locator('#title').filter({ hasText: 'Neue Nachricht' }).waitFor();
    assert.equal(await toast.locator('#body').innerText(), 'Öffne Azeroth Relay, um sie zu lesen.');
    const toastNative = await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/toast.html')); return { focusable: window.isFocusable(), visible: window.isVisible() }; });
    assert.equal(toastNative.focusable, false); assert.equal(toastNative.visible, true);
    await page.locator('#quiet-button').click();
    await page.evaluate(() => window.relay.simulate());
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/toast.html')).isVisible()), false);
    await page.locator('#quiet-button').click();

    await page.locator('#settings-button').click();
    await page.locator('#settings-dialog').waitFor({ state: 'visible' });
    await page.locator('#opacity').evaluate(input => { input.value = '85'; input.dispatchEvent(new Event('change')); });
    await page.waitForFunction(() => document.querySelector('#opacity-value').value === '85 %');
    await page.screenshot({ path: 'test-results/02-settings.png' });
    // Conflicting hotkeys must be rejected without losing the existing binding.
    await page.locator('#quiet-hotkey-setting').fill(testHotkey);
    await page.locator('#hotkey-form button').click();
    await page.locator('#settings-error').filter({ hasText: 'unterschiedlich' }).waitFor();
    assert.equal(await application.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Alt+F8')), true);
    await page.locator('#close-settings').click();
    await page.locator('#profile').selectOption('forever');
    await page.locator('#settings-button').click();
    assert.equal(await page.locator('#opacity').inputValue(), '96');
    await page.locator('#close-settings').click();
    await page.locator('#profile').selectOption('retail');
    await page.locator('#settings-button').click();
    assert.equal(await page.locator('#opacity').inputValue(), '85');
    await page.locator('#close-settings').click();

    // Compact layout remains navigable on a small overlay.
    await page.locator('#compact-button').click();
    await page.waitForFunction(() => document.body.classList.contains('compact'));
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).setSize(480, 620));
    await page.screenshot({ path: 'test-results/03-compact.png' });
    await page.locator('#back-chats').click();
    await page.locator('[data-chat-id="101"]').click();
    await page.locator('#chat-title').filter({ hasText: 'Mara' }).waitFor();
    await page.locator('#compact-button').click();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).setSize(820, 680));

    // Passive display relinquishes native focus; menu action restores interactivity.
    await page.locator('#passive-button').click();
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).isFocusable()), false);
    await application.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items[0].click());
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).isFocusable()), true);
    await page.keyboard.press('Escape');
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).isVisible()), false);
    await application.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items[0].click());

    await page.locator('#connect-from-demo').click();
    await page.locator('#login-view').waitFor({ state: 'visible' });
    await page.screenshot({ path: 'test-results/04-login.png' });
    await page.locator('#api-id').fill('wrong'); await page.locator('#api-hash').fill('a'.repeat(32));
    await page.locator('#login-submit').click();
    await page.locator('#login-error').filter({ hasText: 'gültige API-ID' }).waitFor();
    const files = await fs.readdir(directory);
    assert.equal(files.includes('account.enc'), false, 'UI tests must never create a real Telegram session');
    assert.deepEqual(errors, [], 'No uncaught renderer errors');
    const version = await page.evaluate(() => window.relay.bootstrap().then(state => state.app.version));
    await fs.writeFile('test-results/ui-report.json', JSON.stringify({ passed: true, version, platform: process.platform, tests: ['native-window', 'preload-isolation', 'send', 'reply', 'drafts', 'favorites', 'private-passive-notification', 'quiet-mode', 'settings', 'hotkey-conflict', 'profiles', 'compact-navigation', 'passive-focus', 'hide-restore', 'login-validation'], rendererErrors: errors }, null, 2));
    console.log('15 desktop UI scenarios passed. Screenshots saved to test-results/.');
  } finally { await application.close(); await fs.rm(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
