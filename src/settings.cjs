const fs = require('node:fs');
const path = require('node:path');

const PROFILE_NAMES = ['retail', 'forever'];
const baseProfile = () => ({ bounds: null, opacity: 96, compact: false });
const defaults = () => ({
  profile: 'retail', hotkey: 'CommandOrControl+Shift+Space', quietHotkey: 'CommandOrControl+Shift+D',
  quiet: false, previews: false, notifications: true, autoHide: false, startAtLogin: false,
  favorites: [], onlyFavorites: false, monitor: 'primary',
  profiles: { retail: baseProfile(), forever: baseProfile() },
});

function cleanBounds(value) {
  if (!value || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(value[k]))) return null;
  return { x: Math.round(value.x), y: Math.round(value.y), width: Math.max(460, Math.min(1600, Math.round(value.width))), height: Math.max(520, Math.min(1400, Math.round(value.height))) };
}

function sanitizeSettings(value = {}) {
  const result = defaults();
  if (PROFILE_NAMES.includes(value.profile)) result.profile = value.profile;
  for (const k of ['quiet', 'previews', 'notifications', 'autoHide', 'startAtLogin', 'onlyFavorites']) {
    if (typeof value[k] === 'boolean') result[k] = value[k];
  }
  for (const k of ['hotkey', 'quietHotkey']) {
    if (typeof value[k] === 'string' && value[k].length > 0 && value[k].length <= 100) result[k] = value[k];
  }
  if (value.monitor === 'primary' || /^\d+$/.test(String(value.monitor))) result.monitor = String(value.monitor);
  if (Array.isArray(value.favorites)) result.favorites = [...new Set(value.favorites.filter(x => typeof x === 'string' && /^-?\d+$/.test(x)))].slice(0, 500);
  for (const p of PROFILE_NAMES) {
    const v = value.profiles?.[p];
    if (!v) continue;
    result.profiles[p] = {
      bounds: cleanBounds(v.bounds), opacity: Math.max(50, Math.min(100, Number(v.opacity) || 96)), compact: v.compact === true,
    };
  }
  return result;
}

class SettingsStore {
  constructor(directory) {
    this.file = path.join(directory, 'settings.json');
    try { this.value = sanitizeSettings(JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
    catch { this.value = defaults(); }
  }
  update(patch) {
    this.value = sanitizeSettings({ ...this.value, ...patch, profiles: { ...this.value.profiles, ...patch.profiles } });
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.value, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    return this.value;
  }
}

module.exports = { defaults, sanitizeSettings, cleanBounds, SettingsStore };
