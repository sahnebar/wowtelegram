const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');

function classifyGame(info) {
  const executable = String(info?.path || '').toLowerCase();
  const name = String(info?.name || '').toLowerCase();
  const bundle = String(info?.bundle || '').toLowerCase();
  const active = /(?:^|[\\/])wow(?:classic|forever)?(?:t|b)?\.exe$/.test(executable) || /^wow(?:classic|forever)?(?:t|b)?$/.test(name) || bundle === 'com.blizzard.worldofwarcraft' || /^world of warcraft(?: beta| ptr)?$/.test(name);
  const profile = /forever|_forever_/.test(executable) ? 'forever' : /_retail_/.test(executable) ? 'retail' : null;
  return { active, profile, own: Number(info?.pid) === process.pid };
}

class ForegroundWatcher extends EventEmitter {
  start() {
    if (this.child) return;
    const platform = process.platform;
    if (!['darwin', 'win32'].includes(platform)) { this.emit('unavailable'); return; }
    const executable = platform === 'darwin' ? '/usr/bin/osascript' : 'powershell.exe';
    // External interpreters cannot read Electron's virtual app.asar filesystem.
    const script = name => path.join(__dirname, name).replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    const args = platform === 'darwin'
      ? ['-l', 'JavaScript', script('watcher-mac.js')]
      : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script('watcher-windows.ps1')];
    this.child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 8192) buffer = '';
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try { this.emit('change', classifyGame(JSON.parse(line))); } catch { /* Ignore partial OS output. */ }
      }
    });
    this.child.on('error', () => { this.emit('unavailable'); });
    this.child.on('exit', () => { this.child = null; this.emit('unavailable'); });
  }
  stop() { this.child?.kill(); this.child = null; }
}
module.exports = { ForegroundWatcher, classifyGame };
