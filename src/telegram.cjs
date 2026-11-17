const { EventEmitter } = require('node:events');
const { TelegramClient, Api, utils } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { NewMessage, EditedMessage, DeletedMessage, Raw } = require('teleproto/events');
const QRCode = require('qrcode');
const { credentials, outgoing, chatId, errorText, UserError } = require('./model.cjs');

function person(entity) { return [entity?.firstName, entity?.lastName].filter(Boolean).join(' ') || entity?.title || entity?.username || 'Kontakt'; }
function initials(name) { return name.split(/\s+/).slice(0, 2).map(x => [...x][0]).join('').toUpperCase(); }
function content(message) {
  if (message.ttlPeriod || message.media?.ttlSeconds) return 'Selbstlöschende Nachricht · bitte in Telegram ansehen';
  if (message.message) return message.message;
  if (message.photo) return '📷 Foto';
  if (message.voice) return '🎙 Sprachnachricht';
  if (message.video) return '🎬 Video';
  if (message.sticker) return 'Sticker';
  if (message.media) return 'Anhang · in Telegram öffnen';
  return 'Systemnachricht';
}
function serializeMessage(message) {
  const sender = message._sender || message.sender;
  return {
    id: message.id, text: content(message), outgoing: !!message.out,
    sender: message.out ? 'Du' : person(sender), date: Number(message.date) || Math.floor(Date.now() / 1000),
    replyTo: message.replyTo?.replyToMsgId || null, media: !!message.media,
  };
}

class LiveTelegram extends EventEmitter {
  constructor(vault) {
    super(); this.vault = vault; this.mode = 'live'; this.status = 'disconnected';
    this.chats = new Map(); this.entities = new Map(); this.sent = new Map(); this.readRevisions = new Map();
    this.client = null; this.user = null; this.auth = null; this.error = null; this.connection = 'offline';
    this.pending = null; this.generation = 0; this.dialogIterator = null; this.hasMoreChats = false;
    this.incomingQueue = Promise.resolve(); this.loadingChats = null;
  }
  snapshot() { return { mode: this.mode, status: this.status, connection: this.connection, user: this.user, auth: this.auth, error: this.error, chats: [...this.chats.values()].sort((a, b) => b.date - a.date), hasMoreChats: this.hasMoreChats }; }
  changed() { this.emit('state', this.snapshot()); }
  makeClient(account) {
    // Transport logs can include RPC inputs. Supply a silent logger.
    const logger = { log() {}, error() {}, warn() {}, info() {}, debug() {}, canSend() { return false; }, setLevel() {} };
    const client = new TelegramClient(new StringSession(account.session || ''), account.apiId, account.apiHash, {
      connectionRetries: 3, requestRetries: 1, autoReconnect: true, retryDelay: 1500,
      floodSleepThreshold: 0, baseLogger: logger,
      deviceModel: `Azeroth Relay · ${process.platform}`, appVersion: require('../package.json').version, langCode: 'de', systemLangCode: 'de',
    });
    const connection = value => { if (this.client === client) { this.connection = value; this.changed(); } };
    client.onConnecting(() => connection('connecting'));
    client.onDisconnect(() => connection('offline'));
    client.onConnect(() => connection('online'));
    client.onReconnecting(() => connection('connecting'));
    client.onReconnect(() => connection('online'));
    return client;
  }
  async initialize() {
    const generation = ++this.generation;
    let account;
    try { account = await this.vault.read(); }
    catch (error) { this.error = error.message; this.changed(); return; }
    if (generation !== this.generation) return;
    if (!account?.session) { this.changed(); return; }
    this.status = 'connecting'; this.changed();
    try {
      const client = this.makeClient({ ...credentials(account), session: account.session }); this.client = client;
      await client.connect();
      if (generation !== this.generation) return;
      if (!await client.isUserAuthorized()) { await client.disconnect(); this.status = 'disconnected'; this.error = 'Bitte erneut bei Telegram anmelden.'; this.changed(); return; }
      await this.ready(client, account, generation);
    } catch (error) { if (generation !== this.generation) return; this.status = 'disconnected'; this.error = errorText(error); this.changed(); }
  }
  async beginLogin(input) {
    const account = credentials(input);
    if (this.status === 'ready') throw new UserError('Bitte zuerst abmelden.');
    await this.cancelLogin();
    if (!await this.vault.available()) throw new UserError('Der sichere Schlüsselspeicher ist nicht verfügbar. Bitte den Rechner entsperren.');
    const generation = ++this.generation;
    this.loginAbort = new AbortController();
    const client = this.makeClient(account); this.client = client;
    this.status = 'authenticating'; this.error = null; this.auth = { kind: 'connecting' }; this.changed();
    const ask = (kind, extra = {}) => {
      if (generation !== this.generation) return Promise.reject(new Error('AUTH_CANCELLED'));
      return new Promise((resolve, reject) => {
        this.pending = { resolve, reject }; this.auth = { kind, ...extra }; this.changed();
      });
    };
    this.loginTask = (async () => {
      try {
        await client.connect();
        if (generation !== this.generation) throw new Error('AUTH_CANCELLED');
        if (input.method === 'qr') {
          await client.signInUserWithQrCode(account, {
            abortSignal: this.loginAbort.signal,
            qrCode: async ({ token, expires }) => {
              const dataUrl = await QRCode.toDataURL(`tg://login?token=${token.toString('base64url')}`, { width: 256, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#141a24', light: '#ffffff' } });
              if (generation === this.generation) { this.auth = { kind: 'qr', dataUrl, expires }; this.changed(); }
            },
            password: () => ask('password'),
            onError: async error => {
              if (generation !== this.generation) return true;
              this.error = errorText(error); this.changed(); return false;
            },
          });
        } else {
          const phone = String(input.phone || '').replace(/[\s()-]/g, '');
          if (!/^\+[1-9]\d{6,14}$/.test(phone)) throw new Error('PHONE_NUMBER_INVALID');
          await client.start({
            phoneNumber: phone,
            phoneCode: () => ask('code'),
            password: () => ask('password'),
            emailAddress: () => ask('email'),
            emailVerification: async () => ({ code: await ask('emailCode') }),
            firstAndLastNames: () => { throw new Error('UPDATE_APP_TO_LOGIN'); },
            onError: async error => {
              if (generation !== this.generation) return true;
              this.error = errorText(error); this.changed();
              return /PHONE_CODE_EXPIRED|PHONE_NUMBER_INVALID|API_ID_|AUTH_RESTART|EMAIL_|UPDATE_APP_TO_LOGIN/.test(String(error.errorMessage || error.message));
            },
          });
        }
        if (generation !== this.generation) return;
        if (!await client.isUserAuthorized()) throw new Error('AUTH_KEY_UNREGISTERED');
        await this.ready(client, account, generation);
      } catch (error) {
        if (generation !== this.generation) return;
        this.status = 'disconnected'; this.auth = null; this.error = errorText(error); this.changed();
        await client.disconnect().catch(() => {});
      }
    })();
    return { started: true };
  }
  answer(value) {
    if (!this.pending) throw new UserError('Es wird gerade keine Eingabe erwartet.');
    if (typeof value !== 'string' || !value.trim() || value.length > 1024) throw new UserError('Bitte die angeforderte Eingabe ausfüllen.');
    const p = this.pending; this.pending = null; this.error = null;
    this.auth = { kind: 'checking' }; this.changed(); p.resolve(value); return { accepted: true };
  }
  async ready(client, account, generation = this.generation) {
    const me = await client.getMe();
    if (generation !== this.generation || this.client !== client) return;
    await this.vault.write({ ...account, session: client.session.save() });
    if (generation !== this.generation || this.client !== client) return;
    this.user = { name: person(me), initials: initials(person(me)) };
    this.status = 'ready'; this.connection = 'online'; this.auth = null; this.error = null;
    client.addEventHandler(event => {
      this.incomingQueue = this.incomingQueue.then(() => this.receive(event, false)).catch(() => {});
    }, new NewMessage({}));
    client.addEventHandler(event => {
      this.incomingQueue = this.incomingQueue.then(() => this.receive(event, true)).catch(() => {});
    }, new EditedMessage({}));
    client.addEventHandler(event => {
      // Private-chat delete updates have no peer; message IDs are unique across private chats.
      this.emit('deleted', { chatId: event.chatId?.toString() || null, ids: event.deletedIds, privateOnly: !event.chatId });
    }, new DeletedMessage({}));
    client.addEventHandler(update => {
      let peer;
      if (update.className === 'UpdateReadHistoryInbox') peer = update.peer;
      else if (update.className === 'UpdateReadChannelInbox') peer = new Api.PeerChannel({ channelId: update.channelId });
      if (!peer) return;
      const id = utils.getPeerId(peer).toString(), chat = this.chats.get(id);
      if (chat) {
        chat.unread = Math.max(0, Number(update.stillUnreadCount) || 0);
        this.readRevisions.set(id, (this.readRevisions.get(id) || 0) + 1); this.changed();
      }
    }, new Raw({}));
    this.changed();
    await this.loadChats();
  }
  async loadChats(more = false) {
    if (this.loadingChats) return this.loadingChats;
    this.loadingChats = this.fetchChats(more).finally(() => { this.loadingChats = null; });
    return this.loadingChats;
  }
  async fetchChats(more) {
    if (this.status !== 'ready') return this.snapshot();
    if (!more || !this.dialogIterator) this.dialogIterator = this.client.iterDialogs({ limit: undefined })[Symbol.asyncIterator]();
    let count = 0;
    this.hasMoreChats = true;
    while (count < 60) {
      const next = await this.dialogIterator.next();
      if (next.done) { this.hasMoreChats = false; break; }
      const dialog = next.value;
      if (!dialog.isUser && !dialog.isGroup) continue; // Channels require sponsored-message support; exclude them.
      if (dialog.entity?.bot || dialog.entity?.deleted || dialog.entity?.broadcast) continue;
      const id = dialog.id.toString(); const title = dialog.entity?.self ? 'Gespeichertes' : dialog.title || person(dialog.entity);
      this.entities.set(id, dialog.inputEntity);
      this.chats.set(id, { id, title, initials: initials(title), kind: dialog.entity?.self ? 'saved' : dialog.isGroup ? 'group' : 'private', unread: dialog.unreadCount || 0, latestId: dialog.message?.id || 0, preview: dialog.message ? content(dialog.message) : '', date: Number(dialog.date) || 0, color: ['rose', 'gold', 'blue', 'green'][Math.abs(Number(id.slice(-4))) % 4], muted: Number(dialog.dialog?.notifySettings?.muteUntil) > Date.now() / 1000 });
      count++;
    }
    this.changed(); return this.snapshot();
  }
  entity(id) {
    chatId(id); const entity = this.entities.get(id);
    if (!entity) throw new UserError('Bitte den Chat zuerst laden.');
    return entity;
  }
  async messages(id, before) {
    const messages = await this.client.getMessages(this.entity(id), { limit: 50, offsetId: before || 0 });
    return { messages: Array.from(messages, serializeMessage).reverse(), hasMore: messages.length === 50 };
  }
  async receive(event, edited) {
    const message = event.message;
    const id = event.chatId?.toString();
    if (!id || !message) return;
    let chat = this.chats.get(id);
    if (!chat) {
      const entity = await event.getChat();
      if (entity?.broadcast || entity?.bot || entity?.deleted) return;
      const title = entity?.self ? 'Gespeichertes' : person(entity);
      this.entities.set(id, await event.getInputChat());
      chat = { id, title, initials: initials(title), kind: entity?.className === 'User' ? 'private' : 'group', unread: 0, color: 'blue', date: 0 };
      this.chats.set(id, chat);
    }
    await message.getSender().catch(() => {});
    const dto = serializeMessage(message);
    if (!edited) {
      chat.preview = dto.text; chat.date = dto.date;
      chat.latestId = Math.max(chat.latestId || 0, dto.id);
      if (!dto.outgoing) chat.unread++;
    }
    this.emit(edited ? 'edited' : 'message', { chatId: id, message: dto }); this.changed();
  }
  async send(input) {
    const data = outgoing(input);
    if (this.sent.has(data.requestId)) return this.sent.get(data.requestId);
    if (this.status !== 'ready' || this.connection !== 'online') throw new UserError('Telegram ist noch nicht verbunden. Bitte warten; dein Entwurf bleibt erhalten.');
    const entity = this.entity(data.chatId);
    // Keep the same promise, including a failed/uncertain result. A repeated UI request never resends.
    const result = this.client.sendMessage(entity, { message: data.text, replyTo: data.replyTo, parseMode: false, linkPreview: false })
      .then(serializeMessage).then(message => ({ ...message, replyTo: message.replyTo || data.replyTo || null }));
    this.sent.set(data.requestId, result);
    if (this.sent.size > 1000) this.sent.delete(this.sent.keys().next().value);
    const message = await result;
    const chat = this.chats.get(data.chatId);
    chat.preview = message.text; chat.date = message.date;
    this.emit('message', { chatId: data.chatId, message }); this.changed(); return message;
  }
  async markRead(id, maxId) {
    if (!Number.isSafeInteger(maxId) || maxId <= 0) throw new UserError('Ungültige Lesebestätigung.');
    const chat = this.chats.get(id), count = chat?.unread || 0, latest = chat?.latestId || 0;
    const revision = this.readRevisions.get(id) || 0;
    await this.client.markAsRead(this.entity(id), maxId || undefined);
    // Do not erase an unread message that arrived during the acknowledgement RPC.
    // Server read updates (including reads on other devices) take precedence.
    if (chat && revision === (this.readRevisions.get(id) || 0) && latest <= maxId) chat.unread = Math.max(0, chat.unread - count);
    this.changed();
  }
  async typing(id) {
    await this.client.invoke(new Api.messages.SetTyping({ peer: this.entity(id), action: new Api.SendMessageTypingAction() }));
  }
  async cancelLogin() {
    this.generation++;
    this.loginAbort?.abort(); this.loginAbort = null;
    if (this.pending) { this.pending.reject(new Error('AUTH_CANCELLED')); this.pending = null; }
    if (this.client && this.status !== 'ready') { await this.dispose(this.client); this.client = null; }
    if (this.status !== 'ready') { this.status = 'disconnected'; this.auth = null; this.changed(); }
  }
  async logout() {
    await this.cancelLogin();
    if (this.client) {
      try { await this.client.invoke(new Api.auth.LogOut()); }
      catch { throw new UserError('Die Sitzung konnte bei Telegram nicht abgemeldet werden. Bitte erneut versuchen oder unter Telegram → Einstellungen → Geräte widerrufen.'); }
      await this.client.disconnect();
    }
    await this.resetLocal();
  }
  async resetLocal() {
    await this.cancelLogin();
    if (this.client) await this.dispose(this.client);
    this.client = null; await this.vault.clear(); this.chats.clear(); this.entities.clear(); this.sent.clear(); this.readRevisions.clear();
    this.user = null; this.status = 'disconnected'; this.connection = 'offline'; this.auth = null; this.error = null; this.changed();
  }
  async dispose(client) {
    try { if (client.destroy) await client.destroy(); else await client.disconnect(); } catch { /* Closing must also work offline. */ }
  }
  async close() { await this.cancelLogin(); if (this.client) await this.dispose(this.client); this.client = null; }
}
module.exports = { LiveTelegram, serializeMessage };
