const fs = require('node:fs/promises');
const path = require('node:path');
const { UserError } = require('./model.cjs');

class CredentialVault {
  constructor(directory, safeStorage) {
    this.file = path.join(directory, 'account.enc');
    this.crypto = safeStorage;
  }
  async available() {
    return this.crypto.isAsyncEncryptionAvailable();
  }
  async read() {
    let buffer;
    try { buffer = await fs.readFile(this.file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!await this.available()) throw new UserError('Der sichere Schlüsselspeicher ist nicht verfügbar. Bitte den Rechner entsperren und erneut versuchen.');
    let account, rotate;
    try { const decrypted = await this.crypto.decryptStringAsync(buffer); account = JSON.parse(decrypted.result); rotate = decrypted.shouldReEncrypt; }
    catch { throw new UserError('Die gespeicherte Anmeldung konnte nicht entschlüsselt werden. Bitte die lokale Anmeldung zurücksetzen.'); }
    if (rotate) await this.write(account);
    return account;
  }
  async write(account) {
    if (!await this.available()) throw new UserError('Die Anmeldung wird nicht unverschlüsselt gespeichert. Der sichere Schlüsselspeicher ist nicht verfügbar.');
    const buffer = await this.crypto.encryptStringAsync(JSON.stringify(account));
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.writeFile(`${this.file}.tmp`, buffer, { mode: 0o600 });
    await fs.rename(`${this.file}.tmp`, this.file);
  }
  async clear() { await fs.rm(this.file, { force: true }); await fs.rm(`${this.file}.tmp`, { force: true }); }
}
module.exports = { CredentialVault };
