const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

(async () => {
  const output = require('../package.json').build.directories.output;
  const defaultPath = process.platform === 'win32' ? `${output}/win-unpacked/Azeroth Relay.exe` : `${output}/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Azeroth Relay.app/Contents/MacOS/Azeroth Relay`;
  const executablePath = process.argv[2] || path.resolve(defaultPath);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'azeroth-package-'));
  const env = { ...process.env, AZEROTH_TEST: '1', AZEROTH_TEST_DIRECTORY: directory }; delete env.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({ executablePath, args: ['--demo'], env });
  try {
    await application.firstWindow();
    const page = application.windows().find(p => p.url().endsWith('/index.html'));
    await page.locator('#chat-view').waitFor({ state: 'visible' });
    const result = await application.evaluate(async ({ app, safeStorage }) => {
      const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
      const path = require('node:path');
      const available = await safeStorage.isAsyncEncryptionAvailable();
      let protectedRoundTrip = false;
      if (available) {
        const text = 'synthetic-azeroth-relay-storage-check';
        const encrypted = await safeStorage.encryptStringAsync(text);
        const decrypted = await safeStorage.decryptStringAsync(encrypted);
        protectedRoundTrip = decrypted.result === text && !encrypted.includes(Buffer.from(text));
      }
      const { ForegroundWatcher } = require(path.join(app.getAppPath(), 'src/platform.cjs'));
      const watcher = new ForegroundWatcher();
      const foreground = await new Promise(resolve => {
        const timeout = setTimeout(() => { watcher.stop(); resolve({ available: false, reason: 'timeout' }); }, 6000);
        watcher.once('change', info => { clearTimeout(timeout); watcher.stop(); resolve({ available: true, active: info.active, own: info.own }); });
        watcher.once('unavailable', () => { clearTimeout(timeout); resolve({ available: false }); });
        watcher.start();
      });
      return { packaged: app.isPackaged, version: app.getVersion(), platform: process.platform, architecture: process.arch, available, protectedRoundTrip, foreground };
    });
    assert.equal(result.packaged, true); assert.equal(result.protectedRoundTrip, true, 'OS-backed encryption round trip');
    assert.equal(result.foreground.available, true, 'Foreground helper must run from the packaged app');
    await fs.mkdir('test-results', { recursive: true });
    await fs.writeFile('test-results/packaged-report.json', JSON.stringify(result, null, 2));
    await fs.writeFile(`test-results/packaged-report-${result.architecture}.json`, JSON.stringify(result, null, 2));
    console.log('Packaged app started; OS encryption and bundled game-detection helper passed.');
  } finally { await application.close(); await fs.rm(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
