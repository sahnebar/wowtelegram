const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { credentials, outgoing, errorText, placeBounds } = require('../src/model.cjs');
const { SettingsStore, sanitizeSettings } = require('../src/settings.cjs');
const { CredentialVault } = require('../src/vault.cjs');
const { DemoTelegram } = require('../src/demo.cjs');
const { LiveTelegram, serializeMessage } = require('../src/telegram.cjs');
const { classifyGame } = require('../src/platform.cjs');

const message = { chatId: '101', text: 'Hallo 🌙', requestId: 'unique-message-0001' };
const account = { apiId: 1234, apiHash: 'f'.repeat(32), session: 'synthetic-session-for-tests' };

test('settings survive restart, ignore invalid fields and clamp profile geometry', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-settings-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new SettingsStore(dir);
  store.update({ profile: 'forever', favorites: ['101', '101', '<script>', 42], apiHash: 'must-not-persist', profiles: { forever: { opacity: 25, bounds: { x: 9999, y: -9999, width: 1, height: 9 } } } });
  const persisted = new SettingsStore(dir).value;
  assert.equal(persisted.profile, 'forever'); assert.deepEqual(persisted.favorites, ['101']);
  assert.equal(persisted.profiles.forever.opacity, 50); assert.equal(persisted.profiles.forever.bounds.width, 460);
  assert.equal(persisted.profiles.retail.opacity, 96);
  assert.equal((await fs.readFile(store.file, 'utf8')).includes('must-not-persist'), false);
  assert.equal(sanitizeSettings({ profile: '__proto__', profiles: { retail: { bounds: { x: NaN } } } }).profile, 'retail');
});

test('restoring a disconnected monitor keeps the entire window on the chosen display', () => {
  const area = { x: -1920, y: 0, width: 1920, height: 1080 };
  const bounds = placeBounds({ x: 9000, y: -9000, width: 820, height: 680 }, area);
  assert.ok(bounds.x >= area.x); assert.ok(bounds.x + bounds.width <= area.x + area.width);
  assert.ok(bounds.y >= 0); assert.ok(bounds.y + bounds.height <= area.height);
  assert.deepEqual(placeBounds(null, { x: 0, y: 0, width: 400, height: 300 }), { x: 0, y: 0, width: 400, height: 300 });
});

test('vault uses the asynchronous OS API result, encrypts before writing and rotates keys', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-vault-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const key = crypto.randomBytes(32); let writes = 0, rotate = false;
  const backend = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async text => { writes++; const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]); },
    decryptStringAsync: async buffer => { const decipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12)); decipher.setAuthTag(buffer.subarray(12, 28)); return { result: Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString(), shouldReEncrypt: rotate }; },
  };
  const vault = new CredentialVault(dir, backend); assert.equal(await vault.read(), null);
  await vault.write(account);
  const disk = await fs.readFile(vault.file); assert.equal(disk.includes(Buffer.from(account.session)), false); assert.equal(disk.includes(Buffer.from(account.apiHash)), false);
  assert.deepEqual(await vault.read(), account); rotate = true; assert.deepEqual(await vault.read(), account); assert.equal(writes, 2);
  await vault.clear(); assert.equal(await vault.read(), null);
});

test('vault fails closed when OS encryption is unavailable; never writes a plain session', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-locked-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const vault = new CredentialVault(dir, { isAsyncEncryptionAvailable: async () => false });
  await assert.rejects(vault.write(account), /nicht unverschlüsselt/);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('Telegram inputs reject invalid peers, credentials and oversized Unicode messages', () => {
  assert.throws(() => credentials({ apiId: 'abc', apiHash: 'secret' }));
  assert.deepEqual(credentials(account), { apiId: account.apiId, apiHash: account.apiHash });
  assert.throws(() => outgoing({ ...message, chatId: 'file:///etc/passwd' }));
  assert.throws(() => outgoing({ ...message, replyTo: -1 }));
  assert.throws(() => outgoing({ ...message, text: '🌙'.repeat(4097) }));
  assert.equal([...outgoing({ ...message, text: '🌙'.repeat(4096) }).text].length, 4096);
  assert.equal(errorText(new Error('transport leaked phone +491234 and api_hash secret')).includes('secret'), false);
  assert.match(errorText({ errorMessage: 'FLOOD_WAIT_60' }), /60 Sekunden/);
});

test('demo never uses a Telegram client and deduplicates accidental repeated sends', async () => {
  const demo = new DemoTelegram();
  const [a, b] = await Promise.all([demo.send(message), demo.send(message)]);
  assert.equal(a.id, b.id); const history = await demo.messages('101'); assert.equal(history.messages.filter(m => m.text === message.text).length, 1);
  await demo.markRead('101'); assert.equal(demo.snapshot().chats[0].unread, 0);
  demo.simulate(); assert.equal(demo.snapshot().chats[0].unread, 1);
});

test('live sends share one in-flight RPC; failed/uncertain sends are not automatically repeated', async () => {
  const live = new LiveTelegram({}); live.status = 'ready'; live.connection = 'online';
  live.entities.set('101', {}); live.chats.set('101', { id: '101', unread: 0 });
  let calls = 0;
  live.client = { sendMessage: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return { id: 40, message: message.text, out: true, date: 1700000000 }; } };
  const [a, b] = await Promise.all([live.send(message), live.send(message)]);
  assert.equal(calls, 1); assert.equal(a.id, b.id);
  live.client.sendMessage = async () => { calls++; throw new Error('TIMEOUT'); };
  const failed = { ...message, requestId: 'uncertain-message-0002' };
  await assert.rejects(live.send(failed)); await assert.rejects(live.send(failed)); assert.equal(calls, 2);
  live.connection = 'offline'; await assert.rejects(live.send({ ...message, requestId: 'new-offline-request' }), /nicht verbunden/); assert.equal(calls, 2);
});

test('read acknowledgements are bounded to the last visible message ID', async () => {
  const live = new LiveTelegram({}); live.entities.set('101', 'peer'); live.chats.set('101', { id: '101', unread: 3 });
  const calls = []; live.client = { markAsRead: async (...args) => calls.push(args) };
  await live.markRead('101', 55); assert.deepEqual(calls[0], ['peer', 55]); assert.equal(live.snapshot().chats[0].unread, 0);
});

test('a new unread message arriving during acknowledgement is not cleared', async () => {
  const live = new LiveTelegram({}); live.entities.set('101', 'peer');
  const chat = { id: '101', unread: 3, latestId: 55 }; live.chats.set('101', chat);
  let finish;
  live.client = { markAsRead: () => new Promise(resolve => { finish = resolve; }) };
  const ack = live.markRead('101', 55); chat.unread++; chat.latestId = 56; finish(); await ack;
  assert.equal(chat.unread, 1);
  await assert.rejects(live.markRead('101', 0), /Lesebestätigung/);
});

test('successful login completes code, password and email challenges without persisting these inputs', async () => {
  const saved = [];
  const live = new LiveTelegram({ available: async () => true, write: async value => saved.push(value) });
  const fake = {
    connect: async () => {}, disconnect: async () => {}, isUserAuthorized: async () => true,
    session: { save: () => 'encrypted-later-session' }, getMe: async () => ({ firstName: 'Test', lastName: 'User' }),
    addEventHandler: () => {}, iterDialogs: async function* () {},
    start: async auth => {
      assert.equal(await auth.phoneCode(), '123456');
      assert.equal(await auth.password(), 'synthetic-two-step-password');
      assert.equal(await auth.emailAddress(), 'test@example.invalid');
      assert.deepEqual(await auth.emailVerification(), { code: '654321' });
    },
  };
  live.makeClient = () => fake;
  await live.beginLogin({ ...account, method: 'phone', phone: '+491234567890' });
  for (const value of ['123456', 'synthetic-two-step-password', 'test@example.invalid', '654321']) {
    await new Promise(resolve => setImmediate(resolve)); live.answer(value);
  }
  await live.loginTask;
  assert.equal(live.status, 'ready'); assert.equal(saved.length, 1);
  assert.deepEqual(Object.keys(saved[0]).sort(), ['apiHash', 'apiId', 'session']);
  assert.equal(JSON.stringify(live.snapshot()).includes(account.apiHash), false);
  assert.equal(JSON.stringify(saved).includes('synthetic-two-step-password'), false);
});

test('chat pagination uses the real Telegram library asynchronous-iterator contract', async t => {
  const { Api } = require('teleproto');
  const bigInt = require('big-integer');
  const live = new LiveTelegram({});
  const client = live.makeClient({ apiId: account.apiId, apiHash: account.apiHash });
  t.after(() => client.destroy());
  const dialogs = [], users = [], messages = [];
  for (let i = 0; i < 61; i++) {
    const id = bigInt(2000 + i), peer = new Api.PeerUser({ userId: id });
    users.push(new Api.User({ id, accessHash: bigInt(7000 + i), firstName: `Contact ${i}` }));
    messages.push(new Api.Message({ id: i + 1, peerId: peer, fromId: peer, date: 1700000000 + i, message: `Message ${i}` }));
    dialogs.push(new Api.Dialog({ peer, topMessage: i + 1, readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 1, unreadMentionsCount: 0, unreadReactionsCount: 0, notifySettings: new Api.PeerNotifySettings({}) }));
  }
  let requests = 0;
  client.invoke = async request => {
    assert.ok(request instanceof Api.messages.GetDialogs);
    requests++;
    return new Api.messages.Dialogs({ dialogs, users, messages, chats: [] });
  };
  live.client = client; live.status = 'ready';
  const first = await live.loadChats();
  assert.equal(first.chats.length, 60); assert.equal(first.hasMoreChats, true);
  const second = await live.loadChats(true);
  assert.equal(second.chats.length, 61); assert.equal(second.hasMoreChats, false);
  assert.equal(second.chats.find(chat => chat.id === '2060').preview, 'Message 60');
  assert.equal(requests, 1, 'the remaining buffered dialog must not restart pagination');
});

test('login challenges keep secrets out of snapshots and cancel a pending sign-in cleanly', async () => {
  const live = new LiveTelegram({ available: async () => true });
  live.makeClient = () => ({ connect: async () => {}, disconnect: async () => {}, start: async auth => { await auth.phoneCode(); } });
  await live.beginLogin({ ...account, method: 'phone', phone: '+491234567890' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(live.snapshot().auth.kind, 'code');
  assert.equal(JSON.stringify(live.snapshot()).includes(account.apiHash), false);
  await live.cancelLogin(); await live.loginTask;
  assert.equal(live.snapshot().status, 'disconnected'); assert.equal(live.pending, null);
});

test('message serialization treats all Telegram text as data and preserves replies', () => {
  const text = '<img src=x onerror=alert(1)> & <script>secret</script>';
  const dto = serializeMessage({ id: 5, message: text, date: 1700000000, out: false, replyTo: { replyToMsgId: 4 }, _sender: { firstName: 'Alice' } });
  assert.equal(dto.text, text); assert.equal(dto.replyTo, 4); assert.equal(dto.sender, 'Alice');
  const expiring = serializeMessage({ id: 6, message: 'Must not retain expiring content', date: 1700000000, ttlPeriod: 30 });
  assert.equal(JSON.stringify(expiring).includes('Must not retain'), false);
});

test('game detection handles real Mac installations and Windows process names without reading game memory', () => {
  assert.deepEqual(classifyGame({ path: '/Applications/World of Warcraft/_retail_/World of Warcraft.app/Contents/MacOS/World of Warcraft', bundle: 'com.blizzard.worldofwarcraft' }).profile, 'retail');
  assert.equal(classifyGame({ path: '/Applications/World of Warcraft/_forever_/World of Warcraft.app/Contents/MacOS/World of Warcraft', name: 'World of Warcraft' }).profile, 'forever');
  assert.equal(classifyGame({ path: 'C:\\Games\\World of Warcraft\\_forever_\\Wow.exe' }).active, true);
  assert.equal(classifyGame({ name: 'WowClassic' }).active, true);
  assert.equal(classifyGame({ name: 'NotWow', path: 'C:\\wow\\malware.exe' }).active, false);
  assert.equal(classifyGame({ name: 'World of Warcraft Launcher', bundle: 'com.blizzard.launcher' }).active, false);
  assert.equal(classifyGame({ pid: process.pid }).own, true);
});
